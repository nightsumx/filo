// Settings → Skills: every skill in the agents' skill folders and which agents can use it. Sharing puts
// one copy in ~/.agents/skills (pi, Codex, OpenCode and Grok read it) and links it for Claude Code, so the
// terminal agents get it too; see electron/skills.ts. Nothing is kept here: the list is read from the folders.
import type { AgentKind } from '@shared/agents'
import type { SkillInfo } from '@shared/ipc'
import { AgentIcon } from '@/components/AgentIcon'
import { Button } from '@/components/ui/button'
import { Comment, SettingRow, SettingsPage } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { agentsStore } from '@/store/agents'
import { agentLabel } from '@shared/agents'
import { Loader2 } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

const READERS: AgentKind[] = ['claude', 'codex', 'opencode', 'grok']

export const SkillsPage = observer(() => {
    const [skills, setSkills] = useState<SkillInfo[]>()
    const [busy, setBusy] = useState(false)
    useEffect(() => {
        agentsStore.ensure()
        void window.pi.skills().then(setSkills)
    }, [])
    const agents: AgentKind[] = ['pi', ...READERS.filter(id => agentsStore.get(id)?.available)]
    const pending = skills?.filter(s => !s.shared && s.paths.length === 1).map(s => s.name) ?? []
    const share = async (names: string[]) => {
        setBusy(true)
        try {
            setSkills(await window.pi.shareSkills(names))
            toast.success(tr('已共享，新会话生效', 'Shared; new sessions pick it up'))
        }
        catch (error: any) {
            toast.error(`${tr('共享失败：', 'Could not share: ')}${error.message}`)
            setSkills(await window.pi.skills())
        }
        finally {
            setBusy(false)
        }
    }
    return (
        <SettingsPage title={tr('技能', 'Skills')} aside={skills && `${skills.length}`}>
            <SettingRow
                title={tr('所有 agent 共用', 'Shared by every agent')}
                description={tr(
                    '共享的技能放在 ~/.agents/skills，pi、Codex、OpenCode、Grok 都读这里；Claude Code 只读自己的目录，所以再链接一份过去。终端里的 agent 也用同一份。',
                    'Shared skills live in ~/.agents/skills, which pi, Codex, OpenCode and Grok read; Claude Code reads only its own folder, so it gets a link. The agents in the terminal use the same copy.',
                )}
                control={() => (
                    <Button variant="outline" size="sm" disabled={busy || !pending.length} onClick={() => void share(pending)}>
                        {busy && <Loader2 size={12} className="mr-1 animate-spin" />}
                        {pending.length ? tr(`全部共享（${pending.length}）`, `Share all (${pending.length})`) : tr('都已共享', 'All shared')}
                    </Button>
                )}
            />
            {!skills && <Comment className="py-3">{tr('读取中…', 'Reading…')}</Comment>}
            {skills?.length === 0 && <Comment className="py-3">{tr('还没有技能。技能是带 SKILL.md 的文件夹。', 'No skills yet. A skill is a folder with a SKILL.md.')}</Comment>}
            {skills?.map(skill => (
                <SettingRow
                    key={skill.name}
                    title={skill.name}
                    description={skill.description && <span className="line-clamp-2">{skill.description}</span>}
                    control={() => (
                        <span className="flex shrink-0 items-center gap-3">
                            <span className="flex items-center gap-1.5">
                                {agents.map(id => (
                                    <span key={id} title={skill.agents.includes(id) ? agentLabel(id) : tr(`${agentLabel(id)} 用不了`, `Not in ${agentLabel(id)}`)}>
                                        <AgentIcon agent={id} dim={!skill.agents.includes(id)} className={skill.agents.includes(id) ? undefined : 'opacity-40'} />
                                    </span>
                                ))}
                            </span>
                            {!skill.shared && skill.paths.length === 1 && (
                                <Button variant="outline" size="sm" disabled={busy} onClick={() => void share([skill.name])}>{tr('共享', 'Share')}</Button>
                            )}
                        </span>
                    )}
                >
                    {skill.paths.length > 1 && (
                        <Comment className="mt-1 [overflow-wrap:anywhere]">
                            {tr('同名的几份内容不同，删掉多余的再共享：', 'Different copies under one name; delete the extra ones, then share:')}
                            {skill.paths.map(p => <div key={p} className="font-mono">{p}</div>)}
                        </Comment>
                    )}
                </SettingRow>
            ))}
        </SettingsPage>
    )
})
