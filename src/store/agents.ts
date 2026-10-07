// The ACP agents this machine has, for the composer's agent picker and Settings → Agents. Read once,
// then again whenever an install starts or ends in any window (main broadcasts agents:changed).
import type { AgentAvailability, AgentKind } from '@shared/agents'
import { tr } from '@/lib/i18n'
import { makeAutoObservable, runInAction } from 'mobx'
import { toast } from 'sonner'

class AgentsStore {
    list: AgentAvailability[] = []
    loaded = false
    private loading: Promise<void> | null = null
    private listening = false

    constructor() {
        makeAutoObservable<this, 'loading' | 'listening'>(this, { loading: false, listening: false })
    }

    /** Reads the list on first use; later calls reuse it until something changes. */
    ensure() {
        if (!this.listening) {
            this.listening = true
            window.pi.onAgentsChanged(() => void this.reload())
        }
        if (!this.loaded)
            void this.reload()
    }

    reload(): Promise<void> {
        if (!this.loading) {
            this.loading = window.pi.listAgents().then(
                (list) => {
                    runInAction(() => {
                        this.list = list
                        this.loaded = true
                    })
                },
                () => {
                    runInAction(() => {
                        this.loaded = true
                    })
                },
            ).finally(() => {
                this.loading = null
            })
        }
        return this.loading
    }

    get(id: AgentKind): AgentAvailability | undefined {
        return this.list.find(a => a.id === id)
    }

    /** Installs an agent; true once it can start. Errors show as a toast. */
    async install(id: AgentKind): Promise<boolean> {
        const agent = this.get(id)
        const label = agent?.label ?? id
        // Shown at once; main's broadcast confirms it.
        runInAction(() => {
            if (agent)
                agent.installing = true
        })
        try {
            await window.pi.installAgent(id)
            await this.reload()
            toast.success(tr(`${label} 已安装`, `${label} installed`))
            return !!this.get(id)?.available
        }
        catch (error: any) {
            await this.reload()
            toast.error(tr(`${label} 安装失败`, `Could not install ${label}`), { description: String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').slice(0, 400) })
            return false
        }
    }
}

export const agentsStore = new AgentsStore()
