import type { FileRead } from '@shared/ipc'
import { core } from 'lite-monaco'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appStore } from './app'
import { AUTOSAVE_MS, FileTab } from './fileTab'

/** The disk as main would show it, with the same refuse-if-changed rule as electron/files.ts. */
let disk: Map<string, string>
let writes: string[]
const read = (file: string): FileRead => (disk.has(file) ? { kind: 'text', text: disk.get(file)!, bom: false, size: disk.get(file)!.length } : { kind: 'missing' })

beforeEach(() => {
    disk = new Map([['/p/a.ts', 'one\n']])
    writes = []
    vi.stubGlobal('window', { pi: {
        readFile: async (file: string) => read(file),
        writeFile: async (file: string, text: string, { expected }: { expected: string | null }) => {
            if (expected !== null && (disk.get(file) ?? null) !== expected)
                return { ok: false, disk: read(file) }
            disk.set(file, text)
            writes.push(text)
            return { ok: true }
        },
        agentStop: async () => {},
    } })
})
afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

/** A loaded tab with a document, as the editor pane would leave it. */
async function openTab(path = '/p/a.ts') {
    const tab = new FileTab(path, '/p')
    await tab.load()
    tab.state = core.EditorState.create({ doc: tab.base })
    return tab
}

/** What a keystroke does: change the document, tell the tab. */
function type(tab: FileTab, text: string, at = 0) {
    tab.state = tab.state!.applyTransaction(tab.state!.update({ changes: { from: at, insert: text } }))
    tab.edited()
}

describe('FileTab and the disk', () => {
    it('follows changes on disk while there are no unsaved edits', async () => {
        const tab = await openTab()
        disk.set('/p/a.ts', 'one\ntwo\n')
        await tab.reload()
        expect(tab.state!.doc.toString()).toBe('one\ntwo\n')
        expect(tab.base).toBe('one\ntwo\n')
        expect(tab.dirty).toBe(false)
    })

    it('autosaves after typing stops', async () => {
        vi.useFakeTimers()
        const tab = await openTab()
        type(tab, 'X')
        expect(tab.dirty).toBe(true)
        await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 50)
        expect(writes).toEqual([])
        await vi.advanceTimersByTimeAsync(100)
        expect(disk.get('/p/a.ts')).toBe('Xone\n')
        expect(tab.dirty).toBe(false)
        // The save's own echo from the folder watch changes nothing.
        await tab.reload()
        expect(tab.conflict).toBeNull()
    })

    it('does not overwrite an agent\'s write under unsaved edits; the user picks a side', async () => {
        vi.useFakeTimers()
        const tab = await openTab()
        type(tab, 'mine ')
        disk.set('/p/a.ts', 'agent\n')
        await tab.reload()
        expect(tab.conflict).toMatchObject({ kind: 'text', text: 'agent\n' })
        await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)
        expect(disk.get('/p/a.ts')).toBe('agent\n')
        expect(tab.unsaved).toBe(true)
        tab.takeDisk()
        expect(tab.state!.doc.toString()).toBe('agent\n')
        expect(tab.dirty).toBe(false)
        expect(tab.conflict).toBeNull()
    })

    it('a save racing an agent write turns into a conflict instead of clobbering it', async () => {
        const tab = await openTab()
        type(tab, 'mine ')
        // The agent writes between the edit and the autosave; no watch event has arrived yet.
        disk.set('/p/a.ts', 'agent\n')
        await tab.save('auto')
        expect(disk.get('/p/a.ts')).toBe('agent\n')
        expect(tab.conflict).toMatchObject({ text: 'agent\n' })
        await tab.keepMine()
        expect(disk.get('/p/a.ts')).toBe('mine one\n')
        expect(tab.conflict).toBeNull()
    })

    it('keeps CRLF line endings on save', async () => {
        disk.set('/p/w.txt', 'a\r\nb\r\n')
        const tab = await openTab('/p/w.txt')
        expect(tab.state!.doc.toString()).toBe('a\nb\n')
        type(tab, 'X', 1)
        await tab.save('explicit')
        expect(disk.get('/p/w.txt')).toBe('aX\r\nb\r\n')
    })

    it('stops autosaving a deleted file; ⌘S writes it again', async () => {
        vi.useFakeTimers()
        const tab = await openTab()
        disk.delete('/p/a.ts')
        await tab.reload()
        expect(tab.deleted).toBe(true)
        type(tab, 'X')
        await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)
        expect(disk.has('/p/a.ts')).toBe(false)
        await tab.save('explicit')
        expect(disk.get('/p/a.ts')).toBe('Xone\n')
        expect(tab.deleted).toBe(false)
    })
})

describe('editor tabs in the tab strip', () => {
    beforeEach(() => {
        appStore.threads.clear()
        appStore.files.clear()
        appStore.tabsByProject = {}
        appStore.activeTabByProject = {}
        appStore.lastThreadByProject = {}
        appStore.windowProjects = ['/p']
        appStore.activeProject = '/p'
        appStore.layout = 'split'
    })

    it('opens next to the focused tab; thread panels keep following the last thread', () => {
        appStore.newThread('/p')
        const thread = appStore.activeKey!
        appStore.openFile('/p/a.ts', '/p')
        expect(appStore.tabItems.map(t => t.key)).toEqual([thread, 'file:/p/a.ts'])
        expect(appStore.activeFile?.path).toBe('/p/a.ts')
        expect(appStore.active?.key).toBe(thread)
        // Thread-only lists (activity counts, history) do not see it.
        expect(appStore.tabs.map(t => t.key)).toEqual([thread])
        expect(appStore.activity('/p').open).toBe(0)
        // Opening it again focuses the same tab.
        appStore.focus(thread)
        appStore.openFile('/p/a.ts', '/p')
        expect(appStore.tabItems).toHaveLength(2)
        expect(appStore.activeKey).toBe('file:/p/a.ts')
        appStore.cycleTab(1)
        expect(appStore.activeKey).toBe(thread)
    })

    it('splits a file next to a thread', () => {
        appStore.newThread('/p')
        appStore.openFile('/p/a.ts', '/p')
        appStore.setPaneCapacity(10_000)
        expect(appStore.visibleTabs.map(t => t.key)).toHaveLength(2)
    })

    it('a file gone by the time it opens closes its tab', async () => {
        appStore.newThread('/p')
        appStore.openFile('/p/nope.ts', '/p')
        await vi.waitFor(() => expect(appStore.files.size).toBe(0))
        expect(appStore.tabItems).toHaveLength(1)
    })

    it('closing an editor tab saves what is pending', async () => {
        appStore.openFile('/p/a.ts', '/p')
        const tab = appStore.activeFile!
        await vi.waitFor(() => expect(tab.loaded).toBe(true))
        tab.state = core.EditorState.create({ doc: tab.base })
        type(tab, 'X')
        await appStore.closeTab(tab.key)
        expect(disk.get('/p/a.ts')).toBe('Xone\n')
        expect(appStore.files.size).toBe(0)
    })
})

describe('going to a position', () => {
    /** A view with what goto needs: the state, dispatch and focus. */
    function fakeView(tab: FileTab) {
        const view = {
            state: tab.state!,
            focused: 0,
            dispatch(tr: core.Transaction) {
                view.state = view.state.applyTransaction(tr)
            },
            focus() {
                view.focused++
            },
        }
        return view
    }
    const head = (view: { state: core.EditorState }) => view.state.selection.main.head

    it('moves the caret once a view shows the file, not before', async () => {
        disk.set('/p/a.ts', 'one\ntwo three\nfour\n')
        const tab = await openTab()
        tab.goto(2, 5)
        expect(tab.reveal).toEqual({ line: 2, col: 5 })
        const view = fakeView(tab)
        tab.view = view as never
        tab.applyReveal()
        expect(head(view)).toBe('one\n'.length + 4)
        expect(tab.reveal).toBeNull()
        expect(view.focused).toBe(1)
        tab.applyReveal() // nothing left to do
        expect(view.focused).toBe(1)
    })

    it('moves it at once when a view is already there', async () => {
        disk.set('/p/a.ts', 'one\ntwo\n')
        const tab = await openTab()
        const view = fakeView(tab)
        tab.view = view as never
        tab.goto(1, 3)
        expect(head(view)).toBe(2)
    })

    it('keeps a position past the end of the file inside it', async () => {
        disk.set('/p/a.ts', 'one\ntwo\n')
        const tab = await openTab()
        const view = fakeView(tab)
        tab.view = view as never
        tab.goto(99, 99)
        expect(head(view)).toBe(view.state.doc.length)
        tab.goto(0, 0)
        expect(head(view)).toBe(0)
    })
})
