// Settings dialog (⌘,): pages listed on the left. Changes apply immediately, so there is no button bar.
import type { ThemePref, TranscriptLang } from '@shared/ipc'
import type { LucideIcon } from 'lucide-react'
import type { SettingsPageId } from '@/store/app'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Segmented, SettingRow, SettingsPage } from '@/components/ui/form'
import { TRANSCRIPT_TEXT } from '@/lib/transcriptText'
import { cn } from '@/lib/utils'
import { appStore } from '@/store/app'
import { Archive, Palette, Puzzle } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { CapabilitiesPage } from './Capabilities'
import { CompactionPage } from './Compaction'

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

const AppearancePage = observer(() => (
    <SettingsPage title="外观">
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
    </SettingsPage>
))

const PAGES: { id: SettingsPageId, label: string, icon: LucideIcon, page: React.FC }[] = [
    { id: 'appearance', label: '外观', icon: Palette, page: AppearancePage },
    { id: 'capabilities', label: '能力', icon: Puzzle, page: CapabilitiesPage },
    { id: 'compaction', label: '上下文压缩', icon: Archive, page: CompactionPage },
]

/** Page list on the left, like the tree in JetBrains Settings; Up/Down move between pages. */
const PageList = observer(() => {
    const current = appStore.settingsPage
    return (
        <nav aria-label="设置分类" className="group/nav flex w-[180px] shrink-0 flex-col gap-px bg-[var(--jb-dialog-side)] px-2 pb-3 pt-12">
            {PAGES.map(({ id, label, icon: Icon }, i) => (
                <button
                    key={id}
                    type="button"
                    aria-current={id === current ? 'page' : undefined}
                    tabIndex={id === current ? 0 : -1}
                    onClick={() => appStore.setSettingsPage(id)}
                    onKeyDown={(e) => {
                        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')
                            return
                        e.preventDefault()
                        const next = PAGES[(i + (e.key === 'ArrowDown' ? 1 : PAGES.length - 1)) % PAGES.length]
                        appStore.setSettingsPage(next.id)
                        ;(e.currentTarget.parentElement?.children[PAGES.indexOf(next)] as HTMLElement | undefined)?.focus()
                    }}
                    className={cn(
                        'flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px] text-gray-900 outline-none',
                        // Blue while the list has focus, gray otherwise, as in the project tree.
                        id === current ? 'bg-ide-sel-muted group-focus-within/nav:bg-ide-sel' : 'hover:bg-ide-hover',
                    )}
                >
                    <Icon size={14} className="shrink-0 text-gray-500" />
                    {label}
                </button>
            ))}
        </nav>
    )
})

/** Settings dialog (⌘,): page list on the left, the selected page on the right; changes apply at once. */
export const SettingsDialog = observer(() => {
    const Page = PAGES.find(p => p.id === appStore.settingsPage)?.page ?? AppearancePage
    return (
        <Dialog open={appStore.settingsOpen} onOpenChange={open => appStore.setSettingsOpen(open)}>
            <DialogContent
                className="h-[min(620px,88vh)] max-w-[780px] flex-row gap-0 overflow-hidden p-0"
                // Focus the dialog itself rather than the first control, so no focus ring shows on open.
                onOpenAutoFocus={(e) => {
                    e.preventDefault()
                    ;(e.currentTarget as HTMLElement).focus()
                }}
            >
                <DialogTitle className="absolute left-4 top-0 flex h-12 items-center text-[14px]">设置</DialogTitle>
                <DialogDescription className="sr-only">外观、能力和上下文压缩设置，改动立即生效。</DialogDescription>
                <PageList />
                <div className="min-w-0 flex-1 overflow-y-auto px-6 pb-5 scrollbar-trigger">
                    <Page />
                </div>
            </DialogContent>
        </Dialog>
    )
})
