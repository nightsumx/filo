// Settings → 能力: which capability extensions pi loads for the active project. A preset is only a
// shortcut for a set of switches; any other combination shows no preset selected.
import type { CapabilityId } from '@shared/capabilities'
import { CAPABILITIES, PRESETS } from '@shared/capabilities'
import { Comment, Segmented, SettingRow, SettingsPage, Switch } from '@/components/ui/form'
import { basename } from '@/lib/utils'
import { appStore } from '@/store/app'
import { observer } from 'mobx-react-lite'

export const CapabilitiesPage = observer(() => {
    const cwd = appStore.activeProject
    if (!cwd) {
        return (
            <SettingsPage title="能力">
                <Comment className="py-3">先在主窗口的侧边栏选择一个项目。能力按项目设置。</Comment>
            </SettingsPage>
        )
    }

    const enabled = appStore.capabilitiesOf(cwd)
    const set = (ids: CapabilityId[]) => appStore.setCapabilities(cwd, ids)
    const preset = PRESETS.find(p => p.capabilities.length === enabled.length && p.capabilities.every(id => enabled.includes(id)))
    const extra = CAPABILITIES.filter(c => enabled.includes(c.id)).reduce((sum, c) => sum + c.contextTokens, 0)

    return (
        <SettingsPage title={`能力 · ${basename(cwd)}`} aside={extra ? `每次请求 +${extra} tokens` : '不增加上下文'}>
            <SettingRow
                title="预设"
                description={preset?.hint ?? '自定义组合。'}
                control={({ labelId }) => (
                    <Segmented
                        labelledBy={labelId}
                        value={preset?.id}
                        options={PRESETS.map(p => ({ value: p.id, label: p.label }))}
                        onChange={(v) => {
                            const next = PRESETS.find(p => p.id === v)
                            if (next)
                                set([...next.capabilities])
                        }}
                    />
                )}
            />
            {CAPABILITIES.map(c => (
                <SettingRow
                    key={c.id}
                    title={(
                        <>
                            {c.label}
                            <span className="ml-2 text-[12px] tabular-nums text-[var(--jb-comment)]">{`${c.contextTokens} tokens`}</span>
                        </>
                    )}
                    description={c.description}
                    control={({ labelId, descId }) => (
                        <Switch
                            labelledBy={labelId}
                            describedBy={descId}
                            checked={enabled.includes(c.id)}
                            onChange={on => set(on ? [...enabled, c.id] : enabled.filter(id => id !== c.id))}
                        />
                    )}
                />
            ))}
            <Comment className="pt-3">只作用于这个项目。改动后，打开的线程会在空闲时重启 pi，会话保留；下一次请求的提示词缓存会失效。</Comment>
        </SettingsPage>
    )
})
