// Settings → Agents: the coding agents a thread can run. pi is built in; the others are ACP agents,
// the user's own install (PATH) or one the app installs into its own folder (Install / Update).
// Sign-in stays with each agent, so the page says how instead of holding credentials.
import type { AgentAvailability } from '@shared/agents'
import { Button } from '@/components/ui/button'
import { Comment, SettingRow, SettingsPage } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { agentsStore } from '@/store/agents'
import { ACP_AGENTS } from '@shared/agents'
import { Loader2 } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect } from 'react'

function status(agent: AgentAvailability | undefined): { label: string, tone: 'ok' | 'note' | 'off' } {
    if (!agent)
        return { label: tr('检查中…', 'Checking…'), tone: 'note' }
    if (agent.installing)
        return { label: tr('安装中…', 'Installing…'), tone: 'note' }
    if (!agent.available)
        return { label: tr('未安装', 'Not installed'), tone: 'off' }
    if (agent.outdated)
        return { label: tr('有新版本', 'Update available'), tone: 'note' }
    return { label: agent.via === 'app' ? tr('已安装（应用内）', 'Installed (app)') : tr('已安装', 'Installed'), tone: 'ok' }
}

export const AgentsPage = observer(() => {
    useEffect(() => {
        agentsStore.ensure()
        void agentsStore.reload()
    }, [])
    const loaded = agentsStore.loaded
    return (
        <SettingsPage title={tr('Agent', 'Agents')}>
            <SettingRow
                title="pi"
                description={tr('内置。模型和 API key 在「模型供应商」里设置。', 'Built in. Models and API keys are set in Model providers.')}
                control={() => <Status label={tr('内置', 'Built in')} tone="ok" />}
            />
            {ACP_AGENTS.map((spec) => {
                const agent = loaded ? agentsStore.get(spec.id) : undefined
                const s = status(agent)
                const canInstall = !!agent && (agent.installable || agent.installing)
                return (
                    <SettingRow
                        key={spec.id}
                        title={spec.label}
                        description={agent && !agent.available && !agent.installable
                            ? agent.error
                            : tr(`登录：${spec.signIn.zh}。`, `Sign in: ${spec.signIn.en}.`)}
                        control={() => (
                            <span className="flex shrink-0 items-center gap-3">
                                <Status label={s.label} tone={s.tone} />
                                {canInstall && (
                                    <Button variant="outline" size="sm" disabled={agent.installing} onClick={() => void agentsStore.install(spec.id)}>
                                        {agent.installing && <Loader2 size={12} className="mr-1 animate-spin" />}
                                        {agent.available ? tr('更新', 'Update') : tr('安装', 'Install')}
                                    </Button>
                                )}
                            </span>
                        )}
                    >
                        {agent?.available && agent.command && (
                            <Comment className="mt-1 font-mono [overflow-wrap:anywhere]">{agent.command}</Comment>
                        )}
                    </SettingRow>
                )
            })}
            <div className="py-3">
                <Comment>
                    {tr(
                        '应用安装的 agent 放在应用自己的目录里，不影响终端里的版本；终端里已安装的优先使用。新建线程时在输入框左下角选择 agent。除 pi 以外的 agent 通过 ACP（Agent Client Protocol）连接，用它们自己的登录和计费。',
                        'Agents the app installs live in its own folder and leave your terminal installs alone; an install on your PATH is used first. Pick the agent of a new thread at the bottom left of the composer. Agents other than pi connect over ACP (Agent Client Protocol) and use their own sign-in and billing.',
                    )}
                </Comment>
            </div>
        </SettingsPage>
    )
})

function Status({ label, tone }: { label: string, tone: 'ok' | 'note' | 'off' }) {
    return (
        <span className={cn('shrink-0 text-[12px]', tone === 'ok' ? 'text-ide-success' : tone === 'note' ? 'text-[var(--jb-comment)]' : 'text-gray-400')}>
            {label}
        </span>
    )
}
