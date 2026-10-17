// Settings → Project trust (pi's /trust): whether pi loads a project's own .pi settings, extensions and
// skills. The decisions are pi's trust.json, written through pi's ProjectTrustStore; the terminal's pi asks
// once per project and keeps the answer there, and this page changes it afterwards. Nothing is kept here.
import type { ProjectTrust } from '@shared/ipc'
import { Comment, Segmented, SettingRow, SettingsPage } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { appStore } from '@/store/app'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

type Choice = 'trust' | 'distrust' | 'unset'

const FALLBACK = {
    ask: { zh: '每次询问', en: 'ask' },
    always: { zh: '总是信任', en: 'always trust' },
    never: { zh: '从不信任', en: 'never trust' },
}

const choiceOf = (t: ProjectTrust): Choice => t.inheritedFrom || t.decision === null ? 'unset' : t.decision ? 'trust' : 'distrust'

/** What pi does for the project, by its rules: the nearest folder's decision, else defaultProjectTrust. */
function effective(t: ProjectTrust): string {
    if (t.decision !== null) {
        const word = t.decision ? tr('信任', 'trusted') : tr('不信任', 'not trusted')
        return t.inheritedFrom ? tr(`继承自 ${t.inheritedFrom}：${word}`, `Inherited from ${t.inheritedFrom}: ${word}`) : word
    }
    const fallback = tr(FALLBACK[t.fallback])
    return t.fallback === 'always'
        ? tr(`没有记录，按默认设置（${fallback}）：信任`, `Not recorded; the default (${fallback}) trusts it`)
        : t.fallback === 'never'
            ? tr(`没有记录，按默认设置（${fallback}）：不信任`, `Not recorded; the default (${fallback}) does not trust it`)
            : tr(`没有记录，按默认设置（${fallback}）：终端里的 pi 下次会问；这里的线程当作不信任`, `Not recorded; the default is to ${tr(FALLBACK.ask)}: pi in a terminal asks next time, a thread here counts it as not trusted`)
}

export const TrustPage = observer(() => {
    const cwds = appStore.projects.map(p => p.cwd)
    const [trust, setTrust] = useState<Map<string, ProjectTrust>>()
    useEffect(() => {
        void window.pi.projectTrust(cwds).then(list => setTrust(new Map(list.map(t => [t.cwd, t]))))
        // The list of projects is what the page is about; it is read again when one is added.
    }, [cwds.join('\n')])
    const choose = async (cwd: string, choice: Choice) => {
        try {
            const next = await window.pi.setProjectTrust(cwd, choice === 'unset' ? null : choice === 'trust')
            setTrust(old => new Map(old).set(cwd, next))
            toast.success(tr('已保存，新开的线程生效；已在运行的线程不会重启', 'Saved. New threads use it; threads already running are not restarted'))
        }
        catch (error: any) {
            toast.error(`${tr('保存失败：', 'Could not save: ')}${error.message}`)
        }
    }
    return (
        <SettingsPage title={tr('项目信任', 'Project trust')} aside={trust && `${trust.size}`}>
            <Comment className="py-3">
                {tr(
                    '信任一个项目，pi 才会读它自己的 .pi 设置、扩展和技能，并执行其中的扩展。决定存在 ~/.pi/agent/trust.json，终端里的 pi 读同一份；离项目最近的那一条说了算。',
                    'Trusting a project lets pi load its own .pi settings, extensions and skills and run its extensions. The decisions live in ~/.pi/agent/trust.json, which pi in a terminal reads too; the nearest folder\'s decision wins.',
                )}
            </Comment>
            {!trust && <Comment className="py-3">{tr('读取中…', 'Reading…')}</Comment>}
            {cwds.length === 0 && <Comment className="py-3">{tr('还没有项目。', 'No projects yet.')}</Comment>}
            {cwds.map((cwd) => {
                const t = trust?.get(cwd)
                return t && (
                    <SettingRow
                        key={cwd}
                        title={<span className="[overflow-wrap:anywhere]" data-project={cwd}>{cwd}</span>}
                        description={`${effective(t)}${t.gated ? '' : tr('。这个项目没有需要信任的内容，改了也没有影响。', '. This project has nothing that needs trust, so a change has no effect.')}`}
                        control={({ labelId }) => (
                            <Segmented
                                labelledBy={labelId}
                                value={choiceOf(t)}
                                options={[
                                    { value: 'trust', label: tr('信任', 'Trust') },
                                    { value: 'distrust', label: tr('不信任', 'Do not trust') },
                                    { value: 'unset', label: tr('未记录', 'Not recorded') },
                                ]}
                                onChange={choice => void choose(cwd, choice)}
                            />
                        )}
                    />
                )
            })}
        </SettingsPage>
    )
})
