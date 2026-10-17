// Settings → Pi: what pi's terminal commands /scoped-models and /changelog do. The models you pick are
// enabledModels in ~/.pi/agent/settings.json, the key pi's TUI writes (Ctrl+P cycles them, /model opens on
// them); the changelog is the CHANGELOG.md that ships with pi. Nothing is kept here.
import type { ScopedModels } from '@shared/ipc'
import { Markdown } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { Choice, Comment, SettingRow, SettingsPage } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { appStore } from '@/store/app'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

/** The versions of a changelog, newest first: pi starts each with a `## ` heading. */
export function changelogVersions(text: string): string[] {
    const versions: string[] = []
    for (const line of text.split('\n')) {
        if (line.startsWith('## '))
            versions.push(line)
        else if (versions.length)
            versions[versions.length - 1] += `\n${line}`
    }
    return versions
}

const SHOWN = 5

const ModelsRow = observer(() => {
    const cwd = appStore.project?.cwd ?? ''
    const [state, setState] = useState<ScopedModels>()
    useEffect(() => {
        void window.pi.scopedModels(cwd).then(setState, () => setState(undefined))
    }, [cwd])
    if (!state)
        return <Comment className="py-3">{tr('读取中…', 'Reading…')}</Comment>
    const all = state.models.map(m => `${m.provider}/${m.id}`)
    const picked = new Set(state.scoped)
    const save = async (patterns: string[] | null) => {
        try {
            setState(await window.pi.setScopedModels(cwd, patterns))
        }
        catch (error: any) {
            toast.error(`${tr('保存失败：', 'Could not save: ')}${error.message}`)
        }
    }
    const toggle = (key: string) => {
        const next = new Set(picked)
        if (!next.delete(key))
            next.add(key)
        // Every model picked is the same as none set; none picked would leave pi with no model to cycle.
        if (!next.size)
            return
        void save(next.size === all.length ? null : all.filter(k => next.has(k)))
    }
    const providers = [...new Set(state.models.map(m => m.provider))]
    const custom = state.patterns?.some(p => !all.includes(p))
    return (
        <SettingRow
            title={tr('常用模型', 'Scoped models')}
            description={tr(
                '勾选后，终端里 pi 的 Ctrl+P 只在这些模型间切换，/model 也先列它们。存在 settings.json 的 enabledModels，和 pi 的 /scoped-models 一样。全选等于不限制。',
                'Ctrl+P in pi\'s terminal cycles only these, and /model lists them first. Saved as enabledModels in settings.json, like pi\'s /scoped-models. All selected means no limit.',
            )}
            control={() => (
                <Button variant="outline" size="sm" disabled={!state.patterns} onClick={() => void save(null)}>
                    {tr('全部模型', 'All models')}
                </Button>
            )}
        >
            {custom && (
                <Comment className="mt-1">
                    {tr(`现在用的是通配或带思考强度的写法（${state.patterns!.filter(p => !all.includes(p)).join('、')}）；改任何一项都会换成明确的模型列表。`, `Patterns with wildcards or thinking levels are set (${state.patterns!.filter(p => !all.includes(p)).join(', ')}); changing any model replaces them with an explicit list.`)}
                </Comment>
            )}
            {state.warnings.length > 0 && <Comment className="mt-1">{state.warnings.join('；')}</Comment>}
            {providers.map(provider => (
                <div key={provider} className="mt-3">
                    <Comment className="mb-1.5">{provider}</Comment>
                    <div className="flex flex-wrap gap-1.5" data-provider={provider}>
                        {state.models.filter(m => m.provider === provider).map(m => (
                            <Choice key={m.id} type="checkbox" checked={picked.has(`${m.provider}/${m.id}`)} onChange={() => toggle(`${m.provider}/${m.id}`)}>
                                {m.name || m.id}
                            </Choice>
                        ))}
                    </div>
                </div>
            ))}
            {providers.length === 0 && <Comment className="mt-2">{tr('还没有可用的模型，先在「供应商」里登录。', 'No models yet. Sign in under Providers first.')}</Comment>}
        </SettingRow>
    )
})

const ChangelogRow = observer(() => {
    const [text, setText] = useState<string | null>()
    const [all, setAll] = useState(false)
    useEffect(() => {
        void window.pi.piChangelog().then(setText, () => setText(null))
    }, [])
    const versions = text ? changelogVersions(text) : []
    return (
        <SettingRow
            title={tr('更新日志', 'Changelog')}
            description={text === undefined ? tr('读取中…', 'Reading…') : text === null ? tr('这个 pi 没带 CHANGELOG.md。', 'This pi has no CHANGELOG.md.') : tr('pi 自带的 CHANGELOG.md，和终端里的 /changelog 同一份。', 'The CHANGELOG.md that ships with pi, the same as /changelog in the terminal.')}
            control={() => versions.length > SHOWN
                ? <Button variant="outline" size="sm" onClick={() => setAll(!all)}>{all ? tr('只看最近', 'Latest only') : tr(`全部（${versions.length}）`, `All (${versions.length})`)}</Button>
                : null}
        >
            {versions.length > 0 && (
                <div className="mt-2 select-text" data-changelog>
                    <Markdown content={(all ? versions : versions.slice(0, SHOWN)).join('\n\n')} className="text-[13px]" />
                </div>
            )}
        </SettingRow>
    )
})

export const PiPage = observer(() => (
    <SettingsPage title="Pi">
        <ModelsRow />
        <ChangelogRow />
    </SettingsPage>
))
