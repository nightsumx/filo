// Settings → 能力: which capability extensions every pi process loads. A preset is a named set of
// switches, saved by id so its later changes apply; any other combination is a custom set.
import type { CapabilityId } from '@shared/capabilities'
import { CAPABILITIES, isBudget, PRESETS } from '@shared/capabilities'
import { Button } from '@/components/ui/button'
import { Comment, flatFieldClass, Segmented, SettingRow, SettingsPage, Switch } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { appStore } from '@/store/app'
import { Loader2 } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'

export const CapabilitiesPage = observer(() => {
    const enabled = appStore.capabilities
    const set = (ids: CapabilityId[]) => appStore.setCapabilities(ids)
    const preset = PRESETS.find(p => p.id === appStore.capabilityPreset)
    const extra = CAPABILITIES.filter(c => enabled.includes(c.id)).reduce((sum, c) => sum + c.contextTokens, 0)
    const [budget, setBudget] = useState<string | null>(null)
    const commitBudget = () => {
        const n = Number(budget)
        if (budget !== null && isBudget(n))
            appStore.setBudget(n)
        setBudget(null)
    }

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
                            <span className="ml-2 text-[12px] tabular-nums text-[var(--jb-comment)]">
                                {c.contextTokens ? `${c.contextTokens} tokens` : tr('不占上下文', 'no context')}
                                {c.appOnly && tr(' · 仅 Filo', ' · Filo only')}
                            </span>
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
                >
                    {c.id === 'budget' && enabled.includes('budget') && (
                        <label className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--jb-comment)]">
                            {tr('每次提问 $', 'Per prompt $')}
                            <input
                                inputMode="decimal"
                                value={budget ?? String(appStore.budget)}
                                onChange={e => setBudget(e.target.value)}
                                onBlur={commitBudget}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter')
                                        commitBudget()
                                }}
                                className={cn(flatFieldClass, 'h-7 w-[72px] px-2 text-right tabular-nums')}
                            />
                        </label>
                    )}
                </SettingRow>
            ))}
            <WebAccessRow />
            <Comment className="pt-3">{tr('所有项目共用，也和终端里的 pi（pi-cc-tui 的 /capabilities）共用，存在 ~/.pi/agent/settings.json。改动后，打开的线程会在空闲时重启 pi，会话保留；下一次请求的提示词缓存会失效。', 'Shared by all projects and with pi in a terminal (pi-cc-tui\'s /capabilities), saved in ~/.pi/agent/settings.json. Open threads restart pi once idle and keep their session; the next request misses the prompt cache.')}</Comment>
        </SettingsPage>
    )
})

/** Measured with pi-web-access 0.37.0: its five tools' schemas and prompt lines. */
const WEB_ACCESS_TOKENS = 3200

/**
 * pi-web-access, a community pi package: installed with `pi install` (electron/piPackages.ts) only
 * when asked, so pi in a terminal has it as well. Its own settings live in ~/.pi/agent/web-search.json.
 */
const WebAccessRow = observer(() => {
    const web = appStore.webAccess
    return (
        <SettingRow
            title={(
                <>
                    {tr('联网搜索', 'Web access')}
                    <span className="ml-2 text-[12px] tabular-nums text-[var(--jb-comment)]">{`${WEB_ACCESS_TOKENS} tokens`}</span>
                </>
            )}
            description={tr(
                '搜索网页，读取网页、PDF、GitHub 仓库和视频，不需要 API key。社区包 pi-web-access（MIT），用 pi install 装进 ~/.pi/agent，终端里的 pi 也能用。装好后新会话可用。',
                'Searches the web and reads pages, PDFs, GitHub repos and videos; no API key needed. The community package pi-web-access (MIT), added with pi install to ~/.pi/agent so pi in a terminal has it too. New sessions get it.',
            )}
            control={({ labelId, descId }) => web.installed
                ? <Switch labelledBy={labelId} describedBy={descId} checked={web.enabled} onChange={on => void appStore.setWebAccess(on)} />
                : (
                        <Button variant="outline" size="sm" disabled={web.installing} aria-describedby={descId} onClick={() => void appStore.installWebAccess()}>
                            {web.installing && <Loader2 size={12} className="mr-1 animate-spin" />}
                            {web.installing ? tr('正在安装…', 'Installing…') : tr('安装', 'Install')}
                        </Button>
                    )}
        />
    )
})
