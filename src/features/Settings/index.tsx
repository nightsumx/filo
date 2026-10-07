// Settings dialog (⌘,): pages listed on the left. Changes apply immediately, so there is no button bar.
import type { LangPref, Localized } from '@shared/i18n'
import type { ThemePref, TranscriptLang } from '@shared/ipc'
import type { LucideIcon } from 'lucide-react'
import type { SettingsPageId } from '@/store/app'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Segmented, SettingRow, SettingsPage } from '@/components/ui/form'
import { systemLang, tr } from '@/lib/i18n'
import { TRANSCRIPT_TEXT } from '@/lib/transcriptText'
import { cn } from '@/lib/utils'
import { appStore } from '@/store/app'
import { Archive, Bot, KeyRound, Palette, Puzzle } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { AgentsPage } from './Agents'
import { CapabilitiesPage } from './Capabilities'
import { CompactionPage } from './Compaction'
import { ProvidersPage } from './Providers'

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
                {`${t.workedFor(done, t.duration(192_000))} · $0.42`}
            </div>
        </div>
    )
}

const THEME_OPTIONS: { value: ThemePref, label: Localized }[] = [
    { value: 'system', label: { zh: '跟随系统', en: 'System' } },
    { value: 'light', label: { zh: '浅色', en: 'Light' } },
    { value: 'dark', label: { zh: '深色', en: 'Dark' } },
]

/** Language names stay in their own language, so the right one is findable from either. */
const UI_LANG_OPTIONS: { value: LangPref, label: string }[] = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: 'English' },
]

const TRANSCRIPT_LANG_OPTIONS: { value: TranscriptLang, label: string }[] = [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '中文' },
]

const TRANSCRIPT_LANG_HINTS: Record<TranscriptLang, Localized> = {
    en: { zh: '与 pi 终端界面（pi-cc-extensions）用词一致。', en: 'Same wording as pi in the terminal (pi-cc-extensions).' },
    zh: { zh: '工具结果、diff、运行状态等提示改为中文。', en: 'Tool results, diffs and run status in Chinese.' },
}

const AppearancePage = observer(() => {
    const system = systemLang() === 'zh' ? '中文' : 'English'
    return (
        <SettingsPage title={tr('外观', 'Appearance')}>
            <SettingRow
                title={tr('语言', 'Language')}
                description={appStore.langPref === 'system'
                    ? tr(`跟随系统，当前是${system}。`, `Follows the system, now ${system}.`)
                    : tr('菜单、按钮和提示的语言。', 'Language of menus, buttons and messages.')}
                control={({ labelId }) => (
                    <Segmented
                        labelledBy={labelId}
                        value={appStore.langPref}
                        options={[{ value: 'system', label: tr('跟随系统', 'System') }, ...UI_LANG_OPTIONS]}
                        onChange={v => appStore.setLangPref(v)}
                    />
                )}
            />
            <SettingRow
                title={tr('主题', 'Theme')}
                control={({ labelId }) => <Segmented labelledBy={labelId} value={appStore.themePref} options={THEME_OPTIONS.map(o => ({ value: o.value, label: tr(o.label) }))} onChange={v => appStore.setTheme(v)} />}
            />
            <TranscriptLangRow />
        </SettingsPage>
    )
})

const TranscriptLangRow = observer(() => (
        <SettingRow
            title={tr('对话记录用词', 'Transcript wording')}
            description={`${tr(TRANSCRIPT_LANG_HINTS[appStore.transcriptLang])}${tr('只影响对话记录。', ' Only affects the transcript.')}`}
            control={({ labelId }) => <Segmented labelledBy={labelId} value={appStore.transcriptLang} options={TRANSCRIPT_LANG_OPTIONS} onChange={v => appStore.setTranscriptLang(v)} />}
        >
            <div className="mt-2.5">
                <TranscriptPreview lang={appStore.transcriptLang} />
            </div>
        </SettingRow>
))

const PAGES: { id: SettingsPageId, label: Localized, icon: LucideIcon, page: React.FC }[] = [
    { id: 'appearance', label: { zh: '外观', en: 'Appearance' }, icon: Palette, page: AppearancePage },
    { id: 'providers', label: { zh: '模型供应商', en: 'Model providers' }, icon: KeyRound, page: ProvidersPage },
    { id: 'agents', label: { zh: 'Agent', en: 'Agents' }, icon: Bot, page: AgentsPage },
    { id: 'capabilities', label: { zh: '能力', en: 'Capabilities' }, icon: Puzzle, page: CapabilitiesPage },
    { id: 'compaction', label: { zh: '上下文压缩', en: 'Compaction' }, icon: Archive, page: CompactionPage },
]

/** Page list on the left, like the tree in JetBrains Settings; Up/Down move between pages. */
const PageList = observer(() => {
    const current = appStore.settingsPage
    return (
        <nav aria-label={tr('设置分类', 'Settings sections')} className="group/nav flex w-[180px] shrink-0 flex-col gap-px bg-[var(--jb-dialog-side)] px-2 pb-3 pt-12">
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
                    {tr(label)}
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
                <DialogTitle className="absolute left-4 top-0 flex h-12 items-center text-[14px]">{tr('设置', 'Settings')}</DialogTitle>
                <DialogDescription className="sr-only">{tr('外观、模型供应商、能力和上下文压缩设置，改动立即生效。', 'Appearance, model provider, capability and compaction settings; changes apply immediately.')}</DialogDescription>
                <PageList />
                <div className="min-w-0 flex-1 overflow-y-auto px-6 pb-5 scrollbar-trigger">
                    <Page />
                </div>
            </DialogContent>
        </Dialog>
    )
})
