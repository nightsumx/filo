// Settings dialog (⌘,): pages listed on the left. Changes apply immediately, so there is no button bar.
import type { LangPref, Localized } from '@shared/i18n'
import type { EditorIntel, ThemePref, TranscriptLang } from '@shared/ipc'
import type { LucideIcon } from 'lucide-react'
import type { SettingsPageId } from '@/store/app'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Segmented, SettingRow, SettingsPage } from '@/components/ui/form'
import { systemLang, tr } from '@/lib/i18n'
import { TRANSCRIPT_TEXT } from '@/lib/transcriptText'
import { cn } from '@/lib/utils'
import { appStore } from '@/store/app'
import { Archive, Bot, Code, Cpu, Keyboard, KeyRound, Palette, Puzzle, Rocket, Route, ShieldCheck, Sparkles, SquareTerminal, Terminal } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { AgentsPage } from './Agents'
import { CapabilitiesPage } from './Capabilities'
import { ClaudeCodePage } from './ClaudeCode'
import { CodexPage } from './Codex'
import { GrokPage } from './Grok'
import { CompactionPage } from './Compaction'
import { PiPage } from './Pi'
import { ProvidersPage } from './Providers'
import { RoutesPage } from './Routes'
import { ShortcutsPage } from './Shortcuts'
import { SkillsPage } from './Skills'
import { TrustPage } from './Trust'

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

const EDITOR_INTEL_OPTIONS: { value: EditorIntel, label: Localized, hint: Localized }[] = [
    {
        value: 'light',
        label: { zh: '轻量', en: 'Light' },
        hint: { zh: '只有语法高亮和编辑，不加载 TypeScript：没有补全、悬停提示和错误波浪线，打开最快、最省内存。', en: 'Highlighting and editing only. TypeScript is not loaded: no completion, hover or error squiggles. Fastest and lightest.' },
    },
    {
        value: 'standard',
        label: { zh: '标准', en: 'Standard' },
        hint: { zh: '项目一显示就在后台把整个项目（包括 monorepo 里每个 tsconfig）读一遍、建好索引，不用等你打开文件。之后有类型、补全、跳转和错误提示；类型检查在后台线程跑，不卡界面。索引建好之前不显示错误波浪线。CSS / SCSS / Less、HTML、Vue 也有补全、悬停、检查和跳转（Vue 的 <script> 走同一个 TypeScript 项目，.vue 的 import 有类型）。', en: 'As soon as a project is shown, reads the whole project (every tsconfig in it, monorepo packages included) in the background, without waiting for a file to be opened. Then gives types, completion, navigation and errors. Type checking runs in a background thread, so the window stays responsive. No error squiggles until the index is built. CSS / SCSS / Less, HTML and Vue get completion, hover, checks and navigation too (a Vue <script> joins the same TypeScript project, and .vue imports are typed).' },
    },
    {
        value: 'full',
        label: { zh: '完整', en: 'Full' },
        hint: { zh: '在标准的基础上检查整个项目：没打开的文件有错误时在文件树里标红。查找引用和重命名覆盖所有文件（重命名会写回磁盘）。大项目会多占一些 CPU 和内存。', en: 'Standard, plus a check of the whole project: files with errors are marked red in the tree, even if they are not open. References and rename reach every file (rename writes to disk). Uses more CPU and memory on big projects.' },
    },
]

const EditorPage = observer(() => {
    const current = EDITOR_INTEL_OPTIONS.find(o => o.value === appStore.editorIntel) ?? EDITOR_INTEL_OPTIONS[1]
    return (
        <SettingsPage title={tr('编辑器', 'Editor')}>
            <SettingRow
                title={tr('代码智能', 'Code intelligence')}
                description={`${tr(current.hint)}${tr('随时可以改，已打开的文件立即生效。', ' Change it any time; open files follow at once.')}`}
                control={({ labelId }) => <Segmented labelledBy={labelId} value={appStore.editorIntel} options={EDITOR_INTEL_OPTIONS.map(o => ({ value: o.value, label: tr(o.label) }))} onChange={v => appStore.setEditorIntel(v)} />}
            />
        </SettingsPage>
    )
})

const PAGES: { id: SettingsPageId, label: Localized, icon: LucideIcon, page: React.FC }[] = [
    { id: 'appearance', label: { zh: '外观', en: 'Appearance' }, icon: Palette, page: AppearancePage },
    { id: 'editor', label: { zh: '编辑器', en: 'Editor' }, icon: Code, page: EditorPage },
    { id: 'providers', label: { zh: '供应商', en: 'Providers' }, icon: KeyRound, page: ProvidersPage },
    { id: 'pi', label: { zh: 'Pi', en: 'Pi' }, icon: Cpu, page: PiPage },
    { id: 'claude', label: { zh: 'Claude Code', en: 'Claude Code' }, icon: Terminal, page: ClaudeCodePage },
    { id: 'codex', label: { zh: 'Codex', en: 'Codex' }, icon: SquareTerminal, page: CodexPage },
    { id: 'grok', label: { zh: 'Grok Build', en: 'Grok Build' }, icon: Rocket, page: GrokPage },
    { id: 'routes', label: { zh: '路由', en: 'Routing' }, icon: Route, page: RoutesPage },
    { id: 'agents', label: { zh: 'Agent', en: 'Agents' }, icon: Bot, page: AgentsPage },
    { id: 'capabilities', label: { zh: '能力', en: 'Capabilities' }, icon: Puzzle, page: CapabilitiesPage },
    { id: 'skills', label: { zh: '技能', en: 'Skills' }, icon: Sparkles, page: SkillsPage },
    { id: 'compaction', label: { zh: '上下文压缩', en: 'Compaction' }, icon: Archive, page: CompactionPage },
    { id: 'trust', label: { zh: '项目信任', en: 'Project trust' }, icon: ShieldCheck, page: TrustPage },
    { id: 'shortcuts', label: { zh: '快捷键', en: 'Shortcuts' }, icon: Keyboard, page: ShortcutsPage },
]

/** Page list on the left, like the tree in JetBrains Settings; Up/Down move between pages. */
const PageList = observer(() => {
    const current = appStore.settingsPage
    return (
        <nav aria-label={tr('设置分类', 'Settings sections')} className="group/nav flex w-[180px] shrink-0 flex-col gap-px overflow-y-auto bg-[var(--jb-dialog-side)] px-2 pb-3 pt-12">
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
                className="h-[min(620px,max(400px,calc(100vh-170px)))] max-w-[780px] flex-row gap-0 overflow-hidden p-0"
                // Focus the dialog itself rather than the first control, so no focus ring shows on open.
                onOpenAutoFocus={(e) => {
                    e.preventDefault()
                    ;(e.currentTarget as HTMLElement).focus()
                }}
            >
                <DialogTitle className="absolute left-4 top-0 flex h-12 items-center text-[14px]">{tr('设置', 'Settings')}</DialogTitle>
                <DialogDescription className="sr-only">{tr('外观、供应商、路由、agent、能力、技能、上下文压缩、项目信任和快捷键，改动立即生效。', 'Appearance, provider, routing, agent, capability, skill, compaction, project trust and shortcuts; changes apply immediately.')}</DialogDescription>
                <PageList />
                <div className="min-w-0 flex-1 overflow-y-auto px-6 pb-5 scrollbar-trigger">
                    <Page />
                </div>
            </DialogContent>
        </Dialog>
    )
})
