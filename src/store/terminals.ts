// The Terminal tool window's state in this window. The terminals themselves live in main (one list
// for every window); what is window-local is whether the panel shows, its height and which tab of
// each project is in front.
import type { TerminalInfo } from '@shared/ipc'
import { tr } from '@/lib/i18n'
import { makeAutoObservable, runInAction } from 'mobx'
import { toast } from 'sonner'
import { appStore } from './app'

const api = () => window.pi

const HEIGHT_KEY = 'filo.terminal.height'
export const MIN_HEIGHT = 120
const DEFAULT_HEIGHT = 280

class TerminalStore {
    list: TerminalInfo[] = []
    open = false
    height = Number(localStorage.getItem(HEIGHT_KEY)) || DEFAULT_HEIGHT
    /** Per project: the tab in front. */
    activeByProject: Record<string, string> = {}
    /** Bumped to move keyboard focus into the front terminal. */
    focusRequest = 0
    /** Columns and rows the last fitted terminal had; new ones start at that size. */
    lastSize = { cols: 100, rows: 16 }

    constructor() {
        makeAutoObservable(this, { lastSize: false }, { autoBind: true })
    }

    init() {
        api().onTerminals(list => this.setList(list))
        void api().terminals().then(list => this.setList(list))
    }

    setList(list: TerminalInfo[]) {
        this.list = list
        // The last tab of the shown project closed (its shell exited): the tool window goes too.
        if (this.open && this.project && !this.tabs.length)
            this.open = false
    }

    get project(): string | null {
        return appStore.activeProject
    }

    of(cwd: string): TerminalInfo[] {
        return this.list.filter(t => t.cwd === cwd)
    }

    get tabs(): TerminalInfo[] {
        return this.project ? this.of(this.project) : []
    }

    get active(): TerminalInfo | undefined {
        const tabs = this.tabs
        const id = this.project ? this.activeByProject[this.project] : undefined
        return tabs.find(t => t.id === id) ?? tabs[tabs.length - 1]
    }

    busyIn(cwd: string): number {
        return this.of(cwd).filter(t => t.busy).length
    }

    async create(cwd: string, run?: { command: string, label?: string }) {
        try {
            const info = await api().terminalCreate({ cwd, ...this.lastSize, ...run })
            runInAction(() => {
                if (!this.list.some(t => t.id === info.id))
                    this.list = [...this.list, info]
                this.activeByProject[cwd] = info.id
                this.open = true
                this.focusRequest++
            })
        }
        catch (error: any) {
            toast.error(`${tr('无法打开终端：', 'Could not open a terminal: ')}${error?.message ?? error}`)
        }
    }

    select(id: string) {
        const info = this.list.find(t => t.id === id)
        if (!info)
            return
        this.activeByProject[info.cwd] = id
        this.open = true
        this.focusRequest++
    }

    async close(id: string) {
        const info = this.list.find(t => t.id === id)
        if (!info)
            return
        // The neighbour comes to the front, as with editor tabs.
        const tabs = this.of(info.cwd)
        const index = tabs.findIndex(t => t.id === id)
        const next = tabs[index + 1] ?? tabs[index - 1]
        this.list = this.list.filter(t => t.id !== id)
        if (next)
            this.activeByProject[info.cwd] = next.id
        else if (info.cwd === this.project)
            this.hide()
        await api().terminalClose(id).catch(() => {})
    }

    async restart(id: string) {
        await api().terminalRestart(id).catch((error: any) => toast.error(String(error?.message ?? error)))
        this.focusRequest++
    }

    /** Opens the tool window (with a first terminal if the project has none) and focuses it. */
    show() {
        if (!this.project)
            return
        if (!this.tabs.length) {
            void this.create(this.project)
            return
        }
        this.open = true
        this.focusRequest++
    }

    hide() {
        this.open = false
        const key = appStore.activeKey
        if (key)
            appStore.focus(key, true)
    }

    /** ⌃`: open and focus; from inside the terminal, hide it again. */
    toggle(focused: boolean) {
        if (this.open && focused)
            this.hide()
        else
            this.show()
    }

    setHeight(height: number) {
        this.height = Math.max(MIN_HEIGHT, Math.round(height))
        localStorage.setItem(HEIGHT_KEY, String(this.height))
    }

    /** Puts terminal output into the focused thread's composer, as a code block. */
    sendToThread(text: string) {
        const thread = appStore.active
        const body = text.replace(/\s+$/, '')
        if (!thread || !body)
            return
        const block = `\`\`\`\n${body}\n\`\`\`\n`
        thread.draft = thread.draft.trim() ? `${thread.draft.replace(/\s+$/, '')}\n\n${block}` : block
        appStore.focus(thread.key, true)
    }
}

export const terminalStore = new TerminalStore()
