// Settings dialog (⌘,), laid out like a JetBrains settings page: a section list on the left,
// the selected section's options on the right.
import type { ThemePref, TranscriptLang } from '@shared/ipc'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { TRANSCRIPT_TEXT } from '@/lib/transcriptText'
import { cn } from '@/lib/utils'
import { appStore } from '@/store/app'
import { MessagesSquare, Palette } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useId, useState } from 'react'

interface Option<T extends string> {
    value: T
    label: string
    hint?: string
}

/** Segmented single-choice control with radio semantics. */
function Segmented<T extends string>({ label, options, value, onChange }: { label: string, options: Option<T>[], value: T, onChange: (v: T) => void }) {
    const id = useId()
    return (
        <div className="flex items-start gap-6">
            <div id={id} className="w-28 shrink-0 pt-1 text-[13px] text-gray-700">{label}</div>
            <div className="flex flex-col gap-1.5">
                <div role="radiogroup" aria-labelledby={id} className="inline-flex rounded-md bg-black/[0.05] p-0.5">
                    {options.map(o => (
                        <button
                            key={o.value}
                            type="button"
                            role="radio"
                            aria-checked={value === o.value}
                            onClick={() => onChange(o.value)}
                            className={cn(
                                'h-6 rounded-[5px] px-3 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ide-accent/50',
                                value === o.value ? 'bg-ide-editor text-gray-900 shadow-[0_1px_2px_rgb(0_0_0/0.12)]' : 'text-gray-600 hover:text-gray-900',
                            )}
                        >
                            {o.label}
                        </button>
                    ))}
                </div>
                {options.find(o => o.value === value)?.hint && (
                    <div className="text-[12px] text-gray-500">{options.find(o => o.value === value)!.hint}</div>
                )}
            </div>
        </div>
    )
}

/** A few transcript lines in the chosen wording, so the effect is visible before closing. */
function TranscriptPreview({ lang }: { lang: TranscriptLang }) {
    const t = TRANSCRIPT_TEXT[lang]
    const [, done] = t.verbs[0]
    return (
        <div aria-hidden className="ml-[136px] rounded-md bg-[var(--bg-side)] px-3 py-2.5 font-mono text-[12px] leading-[22px] text-gray-700">
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

const SECTIONS = [
    { id: 'appearance', label: '外观', Icon: Palette },
    { id: 'transcript', label: '对话显示', Icon: MessagesSquare },
] as const

type SectionId = typeof SECTIONS[number]['id']

const THEME_OPTIONS: Option<ThemePref>[] = [
    { value: 'system', label: '跟随系统' },
    { value: 'light', label: '浅色' },
    { value: 'dark', label: '深色' },
]

const LANG_OPTIONS: Option<TranscriptLang>[] = [
    { value: 'en', label: 'English', hint: '与 pi 终端界面（pi-cc-extensions）用词一致' },
    { value: 'zh', label: '中文', hint: '工具结果、diff、运行状态等提示改为中文' },
]

export const SettingsDialog = observer(() => {
    const [section, setSection] = useState<SectionId>('transcript')
    return (
        <Dialog open={appStore.settingsOpen} onOpenChange={open => appStore.setSettingsOpen(open)}>
            <DialogContent className="h-[440px] max-w-[720px] flex-row gap-0 overflow-hidden p-0">
                <nav aria-label="设置分类" className="flex w-44 shrink-0 flex-col gap-0.5 bg-ide-panel p-2 pt-4">
                    <DialogTitle className="px-2 pb-2 text-[13px] font-semibold text-gray-900">设置</DialogTitle>
                    {SECTIONS.map(({ id, label, Icon }) => (
                        <button
                            key={id}
                            type="button"
                            aria-current={section === id ? 'page' : undefined}
                            onClick={() => setSection(id)}
                            className={cn('flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ide-accent/50', section === id ? 'bg-ide-sel text-gray-900' : 'text-gray-700 hover:bg-ide-hover')}
                        >
                            <Icon size={14} className="text-gray-500" />
                            {label}
                        </button>
                    ))}
                </nav>
                <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto p-6 pt-5">
                    <div>
                        <h2 className="text-[15px] font-semibold text-gray-900">{SECTIONS.find(s => s.id === section)!.label}</h2>
                        <DialogDescription className="mt-0.5 text-[12px] text-gray-500">
                            {section === 'appearance' ? '窗口配色。' : '对话里工具调用、diff、运行状态等内容的显示方式。界面其余部分不受影响。'}
                        </DialogDescription>
                    </div>
                    {section === 'appearance' && (
                        <Segmented label="主题" options={THEME_OPTIONS} value={appStore.themePref} onChange={v => appStore.setTheme(v)} />
                    )}
                    {section === 'transcript' && (
                        <>
                            <Segmented label="显示语言" options={LANG_OPTIONS} value={appStore.transcriptLang} onChange={v => appStore.setTranscriptLang(v)} />
                            <TranscriptPreview lang={appStore.transcriptLang} />
                        </>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
})
