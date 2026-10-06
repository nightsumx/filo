// Settings → 上下文压缩: pi's own compaction.* settings in the global ~/.pi/agent/settings.json, so
// the terminal pi follows the same choices. Each number is a few named steps, not a free field;
// other values set by hand show as "自定义" with no step selected.
import type { GlobalCompaction, GlobalCompactionPatch } from '@shared/ipc'
import { Comment, Segmented, SettingRow, SettingsPage, Switch } from '@/components/ui/form'
import { appStore } from '@/store/app'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

const RESERVE_STEPS = [
    { value: '32768', label: '早' },
    { value: '16384', label: '默认' },
    { value: '8192', label: '晚' },
]

const KEEP_STEPS = [
    { value: '10000', label: '10k' },
    { value: '20000', label: '20k' },
    { value: '40000', label: '40k' },
]

const k = (n: number) => `${Math.round(n / 1024)}k`
const stepOf = (steps: { value: string }[], n: number) => steps.find(s => Number(s.value) === n)?.value

export const CompactionPage = observer(() => {
    const cwd = appStore.activeProject
    const [info, setInfo] = useState<GlobalCompaction | null>(null)
    const epoch = appStore.piSettingsEpoch

    useEffect(() => {
        let cancelled = false
        window.pi.globalCompaction(cwd ?? undefined)
            .then(i => !cancelled && setInfo(i))
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [cwd, epoch])

    if (!info)
        return <SettingsPage title="上下文压缩">{null}</SettingsPage>

    const set = (patch: GlobalCompactionPatch) => {
        // Optimistic, so the control moves at once; the reload after the write confirms it.
        setInfo({ ...info, ...patch })
        appStore.setGlobalCompaction(patch).catch((error: any) => {
            toast.error('没能保存压缩设置', { description: String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
            void window.pi.globalCompaction(cwd ?? undefined).then(setInfo)
        })
    }
    const reserveStep = stepOf(RESERVE_STEPS, info.reserveTokens)
    const keepStep = stepOf(KEEP_STEPS, info.keepRecentTokens)

    return (
        <SettingsPage title="上下文压缩" aside="写入 ~/.pi/agent/settings.json">
            <SettingRow
                title="自动压缩"
                description="上下文快满时，把较早的对话总结成摘要，腾出空间继续。关闭后需要手动 /compact。"
                control={({ labelId, descId }) => (
                    <Switch labelledBy={labelId} describedBy={descId} checked={info.enabled} onChange={on => set({ enabled: on })} />
                )}
            />
            {info.enabled && (
                <>
                    <SettingRow
                        title="触发时机"
                        description={`上下文剩余不到 ${k(info.reserveTokens)} tokens 时压缩${reserveStep ? '' : '（自定义）'}。越早越不容易中途撑满，但摘要更频繁。`}
                        control={({ labelId }) => (
                            <Segmented labelledBy={labelId} value={reserveStep} options={RESERVE_STEPS} onChange={v => set({ reserveTokens: Number(v) })} />
                        )}
                    />
                    <SettingRow
                        title="保留最近"
                        description={`压缩时原样保留最近约 ${Math.round(info.keepRecentTokens / 1000)}k tokens${keepStep ? '' : '（自定义）'}，更早的部分变成摘要。`}
                        control={({ labelId }) => (
                            <Segmented labelledBy={labelId} value={keepStep} options={KEEP_STEPS} onChange={v => set({ keepRecentTokens: Number(v) })} />
                        )}
                    />
                </>
            )}
            <Comment className="py-3">
                {[
                    info.modelOverrides && 'settings.json 里有按模型的单独设置（modelOverrides），这些模型以它为准。',
                    info.projectOverride && '当前项目的 .pi/settings.json 也设置了压缩，在这个项目里以它为准。',
                    '终端里的 pi 也使用这些设置。正在运行的线程会在空闲后重启生效，会话不受影响。',
                ].filter(Boolean).join('')}
            </Comment>
        </SettingsPage>
    )
})
