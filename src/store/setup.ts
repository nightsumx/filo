// The setup assistant's state in this window: what the last probe found, and the installer running
// in its terminal. The terminal lives in main like any other (terminals.ts, `by: 'setup'`); its exit
// arrives with the terminal list, and then the tools are probed again.
import type { TerminalInfo } from '@shared/ipc'
import type { SetupProbe, SetupTool, SetupToolId } from '@shared/setup'
import { tr } from '@/lib/i18n'
import { makeAutoObservable, reaction, runInAction } from 'mobx'
import { toast } from 'sonner'
import { appStore } from './app'
import { terminalStore } from './terminals'

const api = () => window.pi

class SetupStore {
    page: 1 | 2 = 1
    probe: SetupProbe | null = null
    probing = false
    /** The installer's terminal, shown under the list until another starts or the assistant closes. */
    terminal: { id: string, tool: SetupToolId } | null = null
    /** Tools whose installer succeeded without the tool showing up on PATH. */
    notFound: SetupToolId[] = []
    private stopWatch: (() => void) | null = null

    constructor() {
        makeAutoObservable<this, 'stopWatch'>(this, { stopWatch: false }, { autoBind: true })
    }

    tool(id: SetupToolId): SetupTool | undefined {
        return this.probe?.tools.find(t => t.id === id)
    }

    /** The installer's terminal as main last reported it. */
    get terminalInfo(): TerminalInfo | undefined {
        const id = this.terminal?.id
        return id ? terminalStore.list.find(t => t.id === id) : undefined
    }

    get installing(): boolean {
        return !!this.terminal && !this.terminalInfo?.exit
    }

    async refresh() {
        this.probing = true
        try {
            const probe = await api().setupProbe()
            runInAction(() => (this.probe = probe))
        }
        catch (error: any) {
            toast.error(tr('检查环境失败', 'Could not check the tools'), { description: String(error?.message ?? error) })
        }
        finally {
            runInAction(() => (this.probing = false))
        }
    }

    /** Opens on page 1 with a fresh probe. */
    start() {
        this.page = 1
        this.notFound = []
        void this.refresh()
    }

    async install(id: SetupToolId, size?: { cols: number, rows: number }) {
        if (this.installing)
            return
        await this.dropTerminal()
        try {
            const info = await api().setupInstall(id, size)
            runInAction(() => {
                if (!terminalStore.list.some(t => t.id === info.id))
                    terminalStore.list = [...terminalStore.list, info]
                this.terminal = { id: info.id, tool: id }
                this.notFound = this.notFound.filter(t => t !== id)
            })
            this.stopWatch = reaction(() => this.terminalInfo?.exit, (exit) => {
                if (exit)
                    void this.installed(id, exit.code === 0)
            })
        }
        catch (error: any) {
            toast.error(tr('无法开始安装', 'Could not start the install'), { description: String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
        }
    }

    /** The installer ended: the login shell is asked again, and pi is looked up again (now the user's own, maybe). */
    private async installed(id: SetupToolId, ok: boolean) {
        this.stopWatch?.()
        this.stopWatch = null
        await this.refresh()
        await appStore.refreshEnv()
        runInAction(() => {
            // A failed one says so in the terminal's header.
            if (ok && !this.tool(id)?.path && !this.notFound.includes(id))
                this.notFound.push(id)
        })
    }

    private async dropTerminal() {
        this.stopWatch?.()
        this.stopWatch = null
        const id = this.terminal?.id
        this.terminal = null
        if (id)
            await api().terminalClose(id).catch(() => {})
    }

    setPage(page: 1 | 2) {
        this.page = page
    }

    /** Leaves the assistant; its terminal goes with it. */
    async close() {
        await this.dropTerminal()
    }
}

export const setupStore = new SetupStore()
