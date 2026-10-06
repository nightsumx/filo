// Settings dialog (⌘,): a single flat page. Changes apply immediately, so there is no button bar.
import type { ThemePref, TranscriptLang } from '@shared/ipc'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Segmented, SettingGroup, SettingRow } from '@/components/ui/form'
import { TRANSCRIPT_TEXT } from '@/lib/transcriptText'
import { appStore } from '@/store/app'
import { observer } from 'mobx-react-lite'
import { CapabilitiesGroup } from './Capabilities'

/** A few transcript lines in the chosen wording, so the effect is visible before closing. */
function TranscriptPreview({ lang }: { lang: TranscriptLang }) {
    const t = TRANSCRIPT_TEXT[lang]
    const [, done] = t.verbs[0]
    return (
        <div aria-hidden className="rounded-[6px] bg-[var(--jb-fill)] px-3 py-2.5 font-mono text-[12px] leading-[22px] text-gray-700">
            <div>
                <span className="text-ide-success">✓ </span>
                <span className="font-semibold text-gray-900">Bash</span>
                {' npm test'}
            </div>
            <div className="pl-4 font-sans">
                <span className="text-gray-400">↳ </span>
                <span className="text-gray-500">{t.linesReturned(12)}</span>
                <span className="text-gray-400">{` · ${t.expand}`}</span>
            </div>
            <div>
                <span className="text-ide-success">● </span>
                <span className="font-semibold text-gray-900">{`${t.multipleTools}:`}</span>
                <span className="font-sans text-gray-500">
                    {' '}
                    <span className="text-ide-success">3</span>
                    {` ${t.doneCount} · `}
                </span>
                <span className="text-gray-400">bash, read×2</span>
            </div>
            <div className="font-sans text-gray-500">
                <span className="text-gray-400">✻ </span>
                {t.workedFor(done, t.duration(192_000), t.clock(new Date(2026, 0, 1, 16, 12).getTime()))}
            </div>
        </div>
    )
}

const THEME_OPTIONS: { value: ThemePref, label: string }[] = [
    { value: 'system', label: '跟随系统' },
    { value: 'light', label: '浅色' },
    { value: 'dark', label: '深色' },
]

const LANG_OPTIONS: { value: TranscriptLang, label: string }[] = [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '中文' },
]

const LANG_HINTS: Record<TranscriptLang, string> = {
    en: '与 pi 终端界面（pi-cc-extensions）用词一致。',
    zh: '工具结果、diff、运行状态等提示改为中文。',
}

const GeneralGroup = observer(() => (
    <SettingGroup title="外观">
        <SettingRow
            title="主题"
            control={({ labelId }) => <Segmented labelledBy={labelId} value={appStore.themePref} options={THEME_OPTIONS} onChange={v => appStore.setTheme(v)} />}
        />
        <SettingRow
            title="对话显示语言"
            description={`${LANG_HINTS[appStore.transcriptLang]}只影响对话记录，界面其余部分不变。`}
            control={({ labelId }) => <Segmented labelledBy={labelId} value={appStore.transcriptLang} options={LANG_OPTIONS} onChange={v => appStore.setTranscriptLang(v)} />}
        >
            <div className="mt-2.5">
                <TranscriptPreview lang={appStore.transcriptLang} />
            </div>
        </SettingRow>
    </SettingGroup>
))

/** Settings dialog (⌘,): one scrolling page of groups, every choice visible, changes apply at once. */
export const SettingsDialog = observer(() => (
    <Dialog open={appStore.settingsOpen} onOpenChange={open => appStore.setSettingsOpen(open)}>
        <DialogContent
            className="max-h-[min(680px,88vh)] max-w-[560px] gap-0 overflow-hidden p-0"
            // Focus the dialog itself rather than the first control, so no focus ring shows on open.
            onOpenAutoFocus={(e) => {
                e.preventDefault()
                ;(e.currentTarget as HTMLElement).focus()
            }}
        >
            <div className="flex h-12 shrink-0 items-center px-6">
                <DialogTitle className="text-[14px]">设置</DialogTitle>
            </div>
            <DialogDescription className="sr-only">外观、对话显示和能力设置，改动立即生效。</DialogDescription>
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-5">
                <GeneralGroup />
                <CapabilitiesGroup />
            </div>
        </DialogContent>
    </Dialog>
))
