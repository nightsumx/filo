// Settings → 能力: which capability extensions every pi process loads. A preset is a named set of
// switches, saved by id so its later changes apply; any other combination is a custom set.
import type { CapabilityId } from '@shared/capabilities'
import { CAPABILITIES, PRESETS } from '@shared/capabilities'
import { Comment, Segmented, SettingRow, SettingsPage, Switch } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { appStore } from '@/store/app'
import { observer } from 'mobx-react-lite'

export const CapabilitiesPage = observer(() => {
    const enabled = appStore.capabilities
    const set = (ids: CapabilityId[]) => appStore.setCapabilities(ids)
    const preset = PRESETS.find(p => p.id === appStore.capabilityPreset)
    const extra = CAPABILITIES.filter(c => enabled.includes(c.id)).reduce((sum, c) => sum + c.contextTokens, 0)

    return (
        <SettingsPage title={tr('能力', 'Capabilities')} aside={extra ? tr(`每次请求 +${extra} tokens`, `+${extra} tokens per request`) : tr('不增加上下文', 'No extra context')}>
            <SettingRow
                title={tr('预设', 'Preset')}
                description={preset ? tr(preset.hint) : tr('自定义组合。', 'Custom combination.')}
                control={({ labelId }) => (
                    <Segmented
                        labelledBy={labelId}
                        value={preset?.id}
                        options={PRESETS.map(p => ({ value: p.id, label: tr(p.label) }))}
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
                            {tr(c.label)}
                            <span className="ml-2 text-[12px] tabular-nums text-[var(--jb-comment)]">{c.contextTokens ? `${c.contextTokens} tokens` : tr('不占上下文', 'no context')}</span>
                        </>
                    )}
                    description={tr(c.description)}
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
            <Comment className="pt-3">{tr('所有项目共用。改动后，打开的线程会在空闲时重启 pi，会话保留；下一次请求的提示词缓存会失效。', 'Shared by all projects. Open threads restart pi once idle and keep their session; the next request misses the prompt cache.')}</Comment>
        </SettingsPage>
    )
})
