// Settings → Agents: the coding agents a thread can run. pi is built in; the others are ACP agents
// started from the login shell's PATH, or through npx (downloaded on first use). Read-only: each
// agent signs in its own way, so the page says how instead of holding credentials.
import type { AgentAvailability } from '@shared/agents'
import { Button } from '@/components/ui/button'
import { Comment, SettingRow, SettingsPage } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { ACP_AGENTS } from '@shared/agents'
import { useCallback, useEffect, useState } from 'react'

function status(agent: AgentAvailability | undefined): { label: string, tone: 'ok' | 'note' | 'off' } {
    if (!agent)
        return { label: tr('检查中…', 'Checking…'), tone: 'note' }
    if (!agent.available)
        return { label: tr('未安装', 'Not installed'), tone: 'off' }
    if (agent.via === 'npx')
        return { label: tr('首次使用时下载', 'Downloads on first use'), tone: 'note' }
    return { label: tr('已安装', 'Installed'), tone: 'ok' }
}

export function AgentsPage() {
    const [agents, setAgents] = useState<AgentAvailability[] | null>(null)
    const load = useCallback(() => {
        setAgents(null)
        window.pi.listAgents().then(setAgents, () => setAgents([]))
    }, [])
    useEffect(load, [load])

    return (
        <SettingsPage title={tr('Agent', 'Agents')} aside={<Button variant="ghost" size="sm" onClick={load} disabled={!agents}>{tr('重新检查', 'Check again')}</Button>}>
            <SettingRow
                title="pi"
                description={tr('内置。模型和 API key 在「模型供应商」里设置。', 'Built in. Models and API keys are set in Model providers.')}
                control={() => <Status label={tr('内置', 'Built in')} tone="ok" />}
            />
            {ACP_AGENTS.map((spec) => {
                const agent = agents?.find(a => a.id === spec.id)
                const s = status(agents ? agent : undefined)
                return (
                    <SettingRow
                        key={spec.id}
                        title={spec.label}
                        description={agent && !agent.available
                            ? agent.error
                            : tr(`登录：${spec.signIn.zh}。`, `Sign in: ${spec.signIn.en}.`)}
                        control={() => <Status label={s.label} tone={s.tone} />}
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
                        '新建线程时，在输入框左下角选择 agent。除 pi 以外的 agent 通过 ACP（Agent Client Protocol）连接，用它们自己的登录和计费。',
                        'Pick the agent of a new thread at the bottom left of the composer. Agents other than pi connect over ACP (Agent Client Protocol) and use their own sign-in and billing.',
                    )}
                </Comment>
            </div>
        </SettingsPage>
    )
}

function Status({ label, tone }: { label: string, tone: 'ok' | 'note' | 'off' }) {
    return (
        <span className={cn('shrink-0 text-[12px]', tone === 'ok' ? 'text-ide-success' : tone === 'note' ? 'text-[var(--jb-comment)]' : 'text-gray-400')}>
            {label}
        </span>
    )
}
