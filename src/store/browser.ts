// The Browser tool window's state in this window. The tabs themselves (pages) live in main, one list
// for every window; what is window-local is whether the panel shows, its width and which tab of each
// project is in front.
import type { BrowserTabInfo } from '@shared/ipc'
import { tr } from '@/lib/i18n'
import { shortcutOf } from '@/lib/shortcuts'
import { ipcMessage } from '@/lib/utils'
import { makeAutoObservable, runInAction } from 'mobx'
import { toast } from 'sonner'
import { appStore } from './app'

const api = () => window.pi

const WIDTH_KEY = 'filo.browser.width'
export const MIN_WIDTH = 320
const DEFAULT_WIDTH = 520

class BrowserStore {
    list: BrowserTabInfo[] = []
    open = false
    width = Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_WIDTH
    /** Per project: the tab in front. */
    activeByProject: Record<string, string> = {}
    /** The panel's edge is being dragged: the page would swallow the pointer, so it steps aside. */
    resizing = false
    /** Bumped to move keyboard focus to the address field. */
    addressRequest = 0
    private known = new Set<string>()

    constructor() {
        makeAutoObservable(this, {}, { autoBind: true })
    }

    async init() {
        this.setList(await api().browsers().catch(() => []), false)
        api().onBrowsers(list => this.setList(list, true))
        // A shortcut pressed inside a page: the window handles it as if it was typed there. The page
        // keeps ⌘B (bold) and ⌘/ for itself.
        api().onBrowserKey((e) => {
            const shortcut = shortcutOf('app', e)
            if (shortcut && shortcut !== 'sidebar' && shortcut !== 'commands')
                window.dispatchEvent(new KeyboardEvent('keydown', { ...e, bubbles: true, cancelable: true }))
        })
    }

    setList(list: BrowserTabInfo[], announce: boolean) {
        const fresh = announce ? list.filter(t => !this.known.has(t.id)) : []
        for (const t of list)
            this.known.add(t.id)
        this.list = list
        // A tab an agent opened, or a page opened one (target=_blank), comes to the front where the user is looking.
        for (const t of fresh) {
            if (t.cwd === this.project && (t.by === 'agent' || t.openedFrom)) {
                this.activeByProject[t.cwd] = t.id
                this.open = true
            }
        }
        if (this.open && this.project && !this.tabs.length)
            this.open = false
    }

    get project(): string | null {
        return appStore.activeProject
    }

    of(cwd: string): BrowserTabInfo[] {
        return this.list.filter(t => t.cwd === cwd)
    }

    get tabs(): BrowserTabInfo[] {
        return this.project ? this.of(this.project) : []
    }

    get active(): BrowserTabInfo | undefined {
        const tabs = this.tabs
        const id = this.project ? this.activeByProject[this.project] : undefined
        return tabs.find(t => t.id === id) ?? tabs[tabs.length - 1]
    }

    /** Tabs an agent is working in, for the toolbar's dot. */
    busyIn(cwd: string): number {
        return this.of(cwd).filter(t => t.busy).length
    }

    async create(url?: string) {
        const cwd = this.project
        if (!cwd)
            return
        try {
            const info = await api().browserCreate(cwd, url)
            runInAction(() => {
                this.known.add(info.id)
                if (!this.list.some(t => t.id === info.id))
                    this.list = [...this.list, info]
                this.activeByProject[cwd] = info.id
                this.open = true
                if (!url)
                    this.addressRequest++
            })
        }
        catch (error: any) {
            toast.error(`${tr('无法打开浏览器标签页：', 'Could not open a browser tab: ')}${ipcMessage(error)}`)
        }
    }

    select(id: string) {
        const info = this.list.find(t => t.id === id)
        if (!info)
            return
        this.activeByProject[info.cwd] = id
        this.open = true
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
            this.open = false
        await api().browserClose(id).catch(() => {})
    }

    async navigate(id: string, input: string) {
        try {
            await api().browserNavigate(id, input)
        }
        catch (error: any) {
            toast.error(ipcMessage(error))
        }
    }

    /** Opens the panel (with a blank tab if the project has none) and puts the cursor in the address field. */
    show() {
        if (!this.project)
            return
        if (!this.tabs.length) {
            void this.create()
            return
        }
        this.open = true
    }

    hide() {
        this.open = false
    }

    toggle() {
        if (this.open && this.tabs.length)
            this.hide()
        else
            this.show()
    }

    setWidth(width: number) {
        this.width = Math.max(MIN_WIDTH, Math.round(width))
        localStorage.setItem(WIDTH_KEY, String(this.width))
    }
}

export const browserStore = new BrowserStore()
