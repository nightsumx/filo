// A file open in an editor tab. The text lives in a lite-monaco EditorState (kept here while no pane
// shows the tab, so undo history and selection survive switching tabs); this object tracks how it
// relates to the file on disk: autosave, changes from agents, conflicts, deletion.
import type { FileRead } from '@shared/ipc'
import { core } from 'lite-monaco'
import { tr } from '@/lib/i18n'
import { detectEol, minimalChange, toLf } from '@/lib/textEdit'
import { basename, uid } from '@/lib/utils'
import { makeAutoObservable, observable, runInAction } from 'mobx'

export const FILE_KEY_PREFIX = 'file:'
export const fileKey = (path: string) => `${FILE_KEY_PREFIX}${path}`
export const isFileKey = (key: string) => key.startsWith(FILE_KEY_PREFIX)
export const pathOfFileKey = (key: string) => key.slice(FILE_KEY_PREFIX.length)

/**
 * Edits reach the disk this long after the last keystroke, as in WebStorm there is no "unsaved"
 * state to manage: agents read the file from disk, so it should not lag behind the editor for long.
 */
export const AUTOSAVE_MS = 800

export type SaveMode = 'auto' | 'explicit' | 'overwrite'

export class FileTab {
    readonly kind = 'file' as const
    readonly id = uid()
    readonly key: string
    readonly path: string
    readonly cwd: string

    loaded = false
    /** What the file is (text, binary, too large, gone) as last read. */
    disk: FileRead | null = null
    /** Raw text on disk that the document descends from; a save only goes through over it. */
    base = ''
    bom = false
    eol: '\n' | '\r\n' = '\n'
    /** Edits not on disk yet. */
    dirty = false
    /** The disk changed under unsaved edits: what is there now. */
    conflict: FileRead | null = null
    /** Gone from disk; autosave stops so it is not recreated behind the user's back. */
    deleted = false
    saveError = ''
    /** Caret line and column (1-based) and selected characters, for the status bar. */
    cursor = { line: 1, col: 1, selected: 0 }
    /** Name of the highlighting language, once known. */
    language = ''

    /** The document while no view shows it. */
    state: core.EditorState | null = null
    /** The view showing it, if any (it owns the current state then). */
    view: core.EditorView | null = null
    /** Scroll position to restore when a view shows it again. */
    scroll: { top: number, left: number } | null = null

    /** Bumps on every user edit, so a save knows whether edits came in while it was writing. */
    private version = 0
    private timer: ReturnType<typeof setTimeout> | null = null
    private saving: Promise<void> | null = null

    constructor(path: string, cwd: string) {
        this.key = fileKey(path)
        this.path = path
        this.cwd = cwd
        makeAutoObservable<this, 'version' | 'timer' | 'saving'>(this, {
            disk: observable.ref,
            conflict: observable.ref,
            state: false,
            view: false,
            scroll: false,
            version: false,
            timer: false,
            saving: false,
        }, { autoBind: true })
    }

    get name(): string {
        return basename(this.path)
    }

    get title(): string {
        return this.name
    }

    /** The document's text, LF line breaks. */
    private get docText(): string {
        const state = this.view?.state ?? this.state
        return state ? state.doc.toString() : toLf(this.base)
    }

    /** First read. Resolves to false when the file is not there. */
    async load(): Promise<boolean> {
        const read = await window.pi.readFile(this.path).catch((error: Error) => {
            runInAction(() => (this.saveError = error.message))
            return { kind: 'missing' } as const
        })
        runInAction(() => {
            this.loaded = true
            this.disk = read
            this.deleted = read.kind === 'missing'
            if (read.kind === 'text')
                this.takeBase(read.text, read.bom)
        })
        return read.kind !== 'missing'
    }

    private takeBase(text: string, bom: boolean) {
        this.base = text
        this.bom = bom
        this.eol = detectEol(text)
    }

    /** The file's folder reported a change: read it again and fold the change in. */
    async reload() {
        if (!this.loaded)
            return
        const read = await window.pi.readFile(this.path).catch(() => null)
        if (read)
            runInAction(() => this.reconcile(read))
    }

    /**
     * What is on disk now against the document. Our own save's echo changes nothing; with no
     * unsaved edits the editor follows the disk (only the changed span is replaced, so the caret and
     * scroll stay); under unsaved edits it becomes a conflict for the user to settle.
     */
    reconcile(read: FileRead) {
        if (read.kind === 'missing') {
            this.deleted = true
            return
        }
        const wasDeleted = this.deleted
        this.deleted = false
        if (read.kind !== 'text') {
            if (this.dirty)
                this.conflict = read
            else
                this.disk = read
            return
        }
        if (read.text === this.base && this.disk?.kind === 'text' && !wasDeleted)
            return
        if (!this.dirty || toLf(read.text) === this.docText) {
            this.replaceDoc(read.text, false)
            this.disk = read
            this.takeBase(read.text, read.bom)
            this.dirty = false
            this.conflict = null
            return
        }
        this.conflict = read
    }

    /**
     * Swaps the document's text for `text` as one minimal change, marked remote so it does not
     * count as the user's edit. `undoable`: the user asked for it (load the disk version), so ⌘Z
     * brings their text back; an agent's change is not undone by the user's ⌘Z.
     */
    private replaceDoc(text: string, undoable: boolean) {
        const state = this.view?.state ?? this.state
        if (!state)
            return
        const change = minimalChange(state.doc.toString(), toLf(text))
        if (!change)
            return
        const spec = { changes: change, annotations: [core.Transaction.remote.of(true), core.Transaction.addToHistory.of(undoable)] }
        if (this.view)
            this.view.dispatch(state.update(spec))
        else
            this.state = state.applyTransaction(state.update(spec))
    }

    /** The user changed the document (the view's update listener). */
    edited() {
        this.version++
        this.dirty = true
        this.saveError = ''
        this.schedule()
    }

    private schedule() {
        if (this.timer)
            clearTimeout(this.timer)
        this.timer = setTimeout(() => {
            this.timer = null
            void this.save('auto')
        }, AUTOSAVE_MS)
    }

    /**
     * Writes the document. auto: not over a conflict or a deleted file. explicit (⌘S): recreates a
     * deleted file, still not over a conflict. overwrite: whatever is on disk (the user chose "keep
     * mine").
     */
    async save(mode: SaveMode = 'auto'): Promise<void> {
        while (this.saving)
            await this.saving
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
        if (mode !== 'overwrite' && (this.conflict || (!this.dirty && !this.deleted)))
            return
        if (mode === 'auto' && this.deleted)
            return
        const state = this.view?.state ?? this.state
        const text = state ? state.doc.sliceString(0, state.doc.length, this.eol) : this.base
        const version = this.version
        const expected = mode === 'overwrite' || this.deleted ? null : this.base
        const run = (async () => {
            try {
                const result = await window.pi.writeFile(this.path, text, { expected, bom: this.bom })
                runInAction(() => {
                    if (result.ok) {
                        this.base = text
                        this.disk = { kind: 'text', text, bom: this.bom, size: text.length }
                        this.conflict = null
                        this.deleted = false
                        this.saveError = ''
                        if (this.version === version)
                            this.dirty = false
                    }
                    else if (result.disk.kind === 'missing') {
                        this.deleted = true
                    }
                    else {
                        this.conflict = result.disk
                    }
                })
            }
            catch (error: any) {
                runInAction(() => (this.saveError = `${tr('保存失败：', 'Could not save: ')}${error.message}`))
            }
        })()
        this.saving = run
        await run
        this.saving = null
        // Typed while it was writing: those edits go out on the usual delay.
        if (this.dirty && !this.conflict && !this.deleted && !this.timer)
            this.schedule()
    }

    /** Saves pending edits now (tab closing, window losing focus). */
    flush(): Promise<void> {
        return this.timer || this.dirty ? this.save('auto') : Promise.resolve()
    }

    /** Conflict: take the disk's version (undoable, so the user's text is one ⌘Z away). */
    takeDisk() {
        const read = this.conflict
        if (!read)
            return
        this.conflict = null
        this.dirty = false
        this.disk = read
        if (read.kind === 'text') {
            this.replaceDoc(read.text, true)
            this.takeBase(read.text, read.bom)
        }
        else {
            this.state = null
        }
    }

    /** Conflict: the user's text goes over the disk's. */
    keepMine(): Promise<void> {
        return this.save('overwrite')
    }

    /** Caret moved (the view's update listener). */
    setCursor(line: number, col: number, selected: number) {
        if (this.cursor.line !== line || this.cursor.col !== col || this.cursor.selected !== selected)
            this.cursor = { line, col, selected }
    }

    setLanguage(name: string) {
        this.language = name
    }

    /** Edits that would be lost on close: the ones autosave cannot write (conflict, deleted file). */
    get unsaved(): boolean {
        return this.dirty && (!!this.conflict || this.deleted)
    }

    dispose() {
        if (this.timer)
            clearTimeout(this.timer)
        this.timer = null
        this.view = null
        this.state = null
    }
}
