// Settings → 上下文压缩: pi's own compaction.* settings in the global ~/.pi/agent/settings.json, so
// the terminal pi follows the same choices. The trigger is one "compact at N k" for every model
// (lib/compactAt turns it into per-model reserves, the only absolute form pi has); models that should
// compact elsewhere are listed under it as exceptions.
import type { GlobalCompaction, GlobalCompactionPatch } from '@shared/ipc'
import type { PiModel } from '@shared/pi'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Comment, flatFieldClass, Segmented, SettingRow, SettingsPage, Switch } from '@/components/ui/form'
import { isCustom, MIN_RESERVE } from '@/lib/compactAt'
import { cn } from '@/lib/utils'
import { appStore } from '@/store/app'
import { Plus } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { tr } from '@/lib/i18n'

const KEEP_STEPS = [
    { value: '10000', label: '10k' },
    { value: '20000', label: '20k' },
    { value: '40000', label: '40k' },
]

const k = (n: number) => `${Math.round(n / 1024)}k`
const stepOf = (steps: { value: string }[], n: number) => steps.find(s => Number(s.value) === n)?.value
/** Context sizes as people say them: 250k, 1M. */
const size = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}k`)
const keyOf = (m: { provider: string, id: string }) => `${m.provider}/${m.id}`

/** Compacting below what is kept verbatim would leave nothing to summarize. */
const MIN_ABOVE_KEPT = 10_000
/** No model has a window this large; just a sanity bound for the global field. */
const MAX_POINT_K = 10_000

const minPointK = (keepRecent: number) => Math.ceil((keepRecent + MIN_ABOVE_KEPT) / 1000)

function showError(error: any) {
    toast.error(tr('没能保存压缩设置', 'Could not save compaction settings'), { description: String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
}

export const CompactionPage = observer(() => {
    const cwd = appStore.activeProject
    const [info, setInfo] = useState<GlobalCompaction | null>(null)
    const revision = appStore.compactionRevision

    useEffect(() => {
        let cancelled = false
        window.pi.globalCompaction(cwd ?? undefined)
            .then(i => !cancelled && setInfo(i))
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [cwd, revision])

    if (!info)
        return <SettingsPage title={tr('上下文压缩', 'Compaction')}>{null}</SettingsPage>

    const reload = () => void window.pi.globalCompaction(cwd ?? undefined).then(setInfo)
    const set = (patch: GlobalCompactionPatch) => {
        // Optimistic, so the control moves at once; the reload after the write confirms it.
        setInfo({ ...info, ...patch, modelReserves: info.modelReserves })
        appStore.setGlobalCompaction(patch).catch((error) => {
            showError(error)
            reload()
        })
    }
    const keepStep = stepOf(KEEP_STEPS, info.keepRecentTokens)
    const at = appStore.compactAt ?? null
    const minK = minPointK(info.keepRecentTokens)

    return (
        <SettingsPage title={tr('上下文压缩', 'Compaction')} aside={tr('写入 ~/.pi/agent/settings.json', 'Saved to ~/.pi/agent/settings.json')}>
            <SettingRow
                title={tr('自动压缩', 'Auto-compact')}
                description={tr('上下文快满时，把较早的对话总结成摘要，腾出空间继续。关闭后需要手动 /compact。', 'When the context fills up, earlier conversation is summarized to make room. When off, run /compact yourself.')}
                control={({ labelId, descId }) => (
                    <Switch labelledBy={labelId} describedBy={descId} checked={info.enabled} onChange={on => set({ enabled: on })} />
                )}
            />
            {info.enabled && (
                <>
                    <SettingRow
                        title={tr('触发时机', 'Compact at')}
                        description={at !== null
                            ? tr(`上下文用到 ${size(at)} tokens 时压缩，所有模型一样。窗口装不下这么多的模型，剩余不到 ${k(info.reserveTokens)} 时压缩。`, `Compacts once the context reaches ${size(at)} tokens, for every model. Models whose window is smaller compact when less than ${k(info.reserveTokens)} is left.`)
                            : tr(`留空时，剩余不到 ${k(info.reserveTokens)} tokens 才压缩，1M 窗口要到约 ${size(1_000_000 - info.reserveTokens)}。填一个数让所有模型提早压缩，省钱也更稳。`, `Empty: compacts when less than ${k(info.reserveTokens)} tokens are left, around ${size(1_000_000 - info.reserveTokens)} on a 1M window. Set a number to compact every model earlier, which costs less and stays steadier.`)}
                        control={({ labelId, descId }) => (
                            <PointField
                                labelledBy={labelId}
                                describedBy={descId}
                                value={at}
                                min={minK}
                                max={MAX_POINT_K}
                                placeholder={tr('快满时', 'when full')}
                                onCommit={next => appStore.setCompactAt(next).catch((error) => {
                                    showError(error)
                                    reload()
                                })}
                            />
                        )}
                    />
                    <SettingRow
                        title={tr('保留最近', 'Keep recent')}
                        description={tr(`压缩时原样保留最近约 ${Math.round(info.keepRecentTokens / 1000)}k tokens${keepStep ? '' : '（自定义）'}，更早的部分变成摘要。`, `Keeps about the last ${Math.round(info.keepRecentTokens / 1000)}k tokens as they are${keepStep ? '' : ' (custom)'}; everything earlier becomes the summary.`)}
                        control={({ labelId }) => (
                            <Segmented labelledBy={labelId} value={keepStep} options={KEEP_STEPS} onChange={v => set({ keepRecentTokens: Number(v) })} />
                        )}
                    />
                    <ModelExceptions info={info} at={at} minK={minK} onError={(error) => {
                        showError(error)
                        reload()
                    }}
                    />
                </>
            )}
            <Comment className="py-3">
                {[
                    info.projectOverride && tr('当前项目的 .pi/settings.json 也设置了压缩，在这个项目里以它为准。', 'This project’s .pi/settings.json also sets compaction, and wins in this project. '),
                    tr('终端里的 pi 也使用这些设置。正在运行的线程会在空闲后重启生效，会话不受影响。', 'pi in the terminal uses these settings too. Running threads restart once idle to pick them up; sessions are kept.'),
                ].filter(Boolean).join('')}
            </Comment>
        </SettingsPage>
    )
})

/**
 * Models that compact somewhere other than the global point. Empty by default; a model is added
 * from pi's list and written once it has a number.
 */
const ModelExceptions = observer(({ info, at, minK, onError }: { info: GlobalCompaction, at: number | null, minK: number, onError: (error: unknown) => void }) => {
    const { models, current } = appStore.modelCatalog
    const [drafts, setDrafts] = useState<string[]>([])
    const byKey = new Map<string, Partial<PiModel>>(models.map(m => [keyOf(m), m]))
    if (current)
        byKey.set(keyOf(current), { ...byKey.get(keyOf(current)), ...current })
    const custom = Object.keys(info.modelReserves).filter(key => isCustom(byKey.get(key)?.contextWindow, info.modelReserves[key], at)).sort()
    const keys = [...new Set([...custom, ...drafts])]
    const addable = models.filter(m => m.contextWindow && !keys.includes(keyOf(m)))
    const groups = new Map<string, PiModel[]>()
    for (const m of addable)
        groups.set(m.provider, [...groups.get(m.provider) ?? [], m])

    const remove = (key: string) => {
        setDrafts(d => d.filter(x => x !== key))
        if (!(key in info.modelReserves) || !custom.includes(key))
            return
        const contextWindow = byKey.get(key)?.contextWindow
        // Unknown window: no point to return to, so drop the override and let pi's reserve apply.
        const done = contextWindow
            ? appStore.setModelCompactAt(key, contextWindow, null)
            : appStore.setGlobalCompaction({ modelReserves: { [key]: null } })
        done.catch(onError)
    }

    return (
        <div className="py-3">
            <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                    <div className="text-[13px] leading-5 text-gray-900">{tr('按模型自定义', 'Per-model')}</div>
                    <Comment className="mt-0.5">{keys.length ? tr('这些模型不按上面的触发时机。', 'These models don’t follow the point above.') : tr('个别模型要在别处压缩时，加在这里。', 'Add a model here when it should compact somewhere else.')}</Comment>
                </div>
                {addable.length > 0 && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="shrink-0 text-gray-600"><Plus size={13} />{tr('添加模型', 'Add model')}</Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="max-h-[360px] w-72">
                            {[...groups.entries()].map(([provider, list]) => (
                                <div key={provider}>
                                    <DropdownMenuLabel>{provider}</DropdownMenuLabel>
                                    {list.map(m => (
                                        <DropdownMenuItem key={keyOf(m)} onSelect={() => setDrafts(d => [...d, keyOf(m)])}>
                                            <span className="flex-1 truncate">{m.name}</span>
                                            <span className="text-[11px] tabular-nums text-gray-400">{size(m.contextWindow!)}</span>
                                        </DropdownMenuItem>
                                    ))}
                                </div>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>
            {keys.length > 0 && (
                <div className="mt-2 flex flex-col">
                    {keys.map((key) => {
                        const model = byKey.get(key)
                        const contextWindow = model?.contextWindow
                        const reserve = info.modelReserves[key]
                        const point = contextWindow && reserve !== undefined ? contextWindow - reserve : null
                        const detail = !contextWindow
                            ? tr(`剩余不到 ${k(reserve ?? info.reserveTokens)} 时压缩 · pi 没列出这个模型，不知道窗口大小`, `Compacts when less than ${k(reserve ?? info.reserveTokens)} is left · pi doesn’t list this model, so its window is unknown`)
                            : point === null ? tr('填一个压缩点', 'Enter a point') : ''
                        return (
                            <ExceptionRow
                                key={key}
                                name={model?.name ?? key}
                                meta={[model?.provider, contextWindow && tr(`${size(contextWindow)} 窗口`, `${size(contextWindow)} window`), current && key === keyOf(current) && tr('当前', 'current')].filter(Boolean).join(' · ')}
                                detail={detail}
                                field={contextWindow
                                    ? {
                                            value: point,
                                            min: minK,
                                            max: Math.floor((contextWindow - MIN_RESERVE) / 1000),
                                            onCommit: (next) => {
                                                if (next === null)
                                                    return remove(key)
                                                setDrafts(d => d.filter(x => x !== key))
                                                appStore.setModelCompactAt(key, contextWindow, next).catch(onError)
                                            },
                                        }
                                    : undefined}
                                onRemove={() => remove(key)}
                            />
                        )
                    })}
                </div>
            )}
        </div>
    )
})

function ExceptionRow({ name, meta, detail, field, onRemove }: {
    name: string
    meta: string
    detail: string
    field?: { value: number | null, min: number, max: number, onCommit: (k: number | null) => void }
    onRemove: () => void
}) {
    const labelId = useId()
    const detailId = useId()
    return (
        <div className="flex min-h-10 items-center gap-3 py-1">
            <div className="min-w-0 flex-1">
                <div id={labelId} className="flex min-w-0 items-baseline gap-1.5 text-[13px] leading-5">
                    <span className="truncate text-gray-900">{name}</span>
                    {meta && <span className="shrink-0 text-[12px] tabular-nums text-[var(--jb-comment)]">{meta}</span>}
                </div>
                {detail && <Comment id={detailId}>{detail}</Comment>}
            </div>
            {field && <PointField labelledBy={labelId} describedBy={detail ? detailId : undefined} autoFocus={field.value === null} {...field} />}
            <Button variant="ghost" size="sm" className="shrink-0 px-2 text-gray-600" aria-label={tr(`移除 ${name}`, `Remove ${name}`)} onClick={onRemove}>{tr('移除', 'Remove')}</Button>
        </div>
    )
}

/**
 * "用到 [ N ] k 时压缩". Commits on Enter or blur; an empty field commits null. Out-of-range input
 * stays in the field with the allowed range under it instead of being clamped silently.
 */
function PointField({ value, min, max, placeholder, autoFocus, labelledBy, describedBy, onCommit }: {
    value: number | null
    min: number
    max: number
    placeholder?: string
    autoFocus?: boolean
    labelledBy?: string
    describedBy?: string
    onCommit: (k: number | null) => void
}) {
    const shown = value !== null ? String(Math.round(value / 1000)) : ''
    const [draft, setDraft] = useState<string | null>(null)
    const [error, setError] = useState('')
    const errorId = useId()

    const commit = () => {
        if (draft === null)
            return
        const text = draft.trim()
        if (text === shown) {
            setDraft(null)
            setError('')
            return
        }
        if (!text) {
            setDraft(null)
            setError('')
            onCommit(null)
            return
        }
        const n = Number(text)
        if (!Number.isInteger(n) || n < min || n > max) {
            setError(tr(`填 ${min}–${max}`, `Enter ${min}–${max}`))
            return
        }
        setDraft(null)
        setError('')
        onCommit(n * 1000)
    }

    return (
        <div className="relative flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--jb-comment)]">
            {tr('用到', 'at')}
            <input
                inputMode="numeric"
                autoFocus={autoFocus}
                aria-labelledby={labelledBy}
                aria-describedby={[describedBy, error && errorId].filter(Boolean).join(' ') || undefined}
                aria-invalid={!!error}
                placeholder={placeholder}
                value={draft ?? shown}
                onChange={e => setDraft(e.target.value.replace(/\D/g, ''))}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter')
                        commit()
                }}
                className={cn(flatFieldClass, 'h-7 w-[72px] px-2 text-right tabular-nums', error && 'shadow-[0_0_0_1.5px_theme(colors.red.500)]')}
            />
            {tr('k 时压缩', 'k')}
            {error && <span id={errorId} role="alert" className="absolute top-full right-[60px] mt-0.5 whitespace-nowrap text-[11px] text-red-600 dark:text-red-400">{error}</span>}
        </div>
    )
}
