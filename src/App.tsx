import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { appStore, isFileTab } from '@/store/app'
import { browserStore } from '@/store/browser'
import { terminalStore } from '@/store/terminals'
import { AlertTriangle, FolderPlus, Loader2, Plus } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { Fragment, useEffect, useRef } from 'react'
import { EditorPane } from './features/Editor'
import { BrowserPanel, BrowserResizer } from './features/Browser'
import { ReviewPanel } from './features/Review'
import { SearchDialog } from './features/Search'
import { SettingsDialog } from './features/Settings'
import { Sidebar } from './features/Sidebar'
import { StatusBar } from './features/StatusBar'
import { SessionInfoDialog } from './features/Tabs/SessionInfo'
import { TerminalPanel, TerminalResizer, useTerminalViews } from './features/Terminal'
import { closeTabWithConfirm, TabBar } from './features/Tabs/TabBar'
import { ShortcutHints, ThreadPane } from './features/Thread'
import { MainToolbar } from './features/Toolbar'
import { Setup } from './features/Setup'
import { Welcome } from './features/Welcome'
import { newThreadLabel, tr } from '@/lib/i18n'
import { shortcutOf } from '@/lib/shortcuts'
import { projectDigit } from '@/platform'

const EnvError = observer(({ error }: { error: string }) => (
    <div className="app-drag flex h-full w-full flex-col items-center justify-center gap-4 px-8 text-center">
        <AlertTriangle size={28} className="text-amber-500" />
        <h1 className="!text-lg !font-semibold">{tr('没有找到可用的 pi', 'No working pi found')}</h1>
        <p className="max-w-md whitespace-pre-wrap text-[13px] text-gray-500 select-text">{error}</p>
        <div className="flex gap-2">
            <Button variant="outline" onClick={() => appStore.openSetup()}>{tr('打开设置向导', 'Open setup assistant')}</Button>
            <Button variant="primary" onClick={() => void appStore.retryEnv()}>{tr('重试', 'Retry')}</Button>
        </div>
    </div>
))

/** Open tabs tiled side by side; the container width decides how many fit. */
const Panes = observer(() => {
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const el = ref.current
        if (!el)
            return
        const observer = new ResizeObserver(([entry]) => appStore.setPaneCapacity(entry.contentRect.width))
        observer.observe(el)
        return () => observer.disconnect()
    }, [])

    const panes = appStore.visibleTabs
    const project = appStore.project

    return (
        <div ref={ref} className="flex min-w-0 flex-1">
            {panes.map((tab, i) => (
                <Fragment key={tab.id}>
                    {i > 0 && <div className="w-px shrink-0" />}
                    {isFileTab(tab)
                        ? <EditorPane tab={tab} focused={tab.key === appStore.activeKey} />
                        : <ThreadPane thread={tab} focused={tab.key === appStore.activeKey} />}
                </Fragment>
            ))}
            {panes.length === 0 && (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[13px] text-gray-500">
                    {project
                        ? (
                                <>
                                    <span>{tr(`${project.name} 没有打开的标签`, `No open tabs in ${project.name}`)}</span>
                                    <Button variant="outline" size="sm" onClick={() => appStore.newThread(project.cwd)}>
                                        <Plus size={14} />
                                        {newThreadLabel()}
                                    </Button>
                                    <ShortcutHints className="mt-6" />
                                </>
                            )
                        : (
                                <>
                                    <span>{appStore.projects.length ? tr('从左侧选择一个项目', 'Pick a project on the left') : tr('先添加一个项目文件夹', 'Add a project folder to start')}</span>
                                    {!appStore.projects.length && (
                                        <Button variant="outline" size="sm" onClick={() => void appStore.addProject()}>
                                            <FolderPlus size={14} />
                                            {tr('添加项目', 'Add project')}
                                        </Button>
                                    )}
                                </>
                            )}
                </div>
            )}
        </div>
    )
})

/** Islands under the main toolbar: project tool window, editor (tabs + panes), changes tool window. */
const Workspace = observer(() => {
    const active = appStore.active
    const column = useRef<HTMLDivElement>(null)
    const terminalOpen = terminalStore.open && terminalStore.tabs.length > 0
    useTerminalViews()
    const browserOpen = browserStore.open && browserStore.tabs.length > 0
    return (
        <div className="flex min-h-0 flex-1 gap-[5px] px-[5px]">
            {appStore.sidebarOpen && <Sidebar />}
            <div ref={column} className="flex min-w-0 flex-1 flex-col">
                <main className="ide-island flex min-h-0 min-w-0 flex-1 flex-col bg-ide-editor">
                    <TabBar />
                    <div className="flex min-h-0 flex-1">
                        <Panes />
                    </div>
                </main>
                {terminalOpen && (
                    <>
                        <TerminalResizer maxHeight={() => (column.current?.clientHeight ?? 600) - 160} />
                        <div className="ide-island shrink-0" style={{ height: `min(${terminalStore.height}px, calc(100% - 160px))` }}>
                            <TerminalPanel />
                        </div>
                    </>
                )}
            </div>
            {browserOpen && (
                <>
                    <BrowserResizer maxWidth={() => (column.current?.parentElement?.clientWidth ?? 1200) - 420} />
                    <div className="ide-island shrink-0" style={{ width: `min(${browserStore.width}px, 60%)` }}>
                        <BrowserPanel />
                    </div>
                </>
            )}
            {appStore.reviewOpen && active && (
                <div className="ide-island w-[40%] min-w-[340px] max-w-[700px] shrink-0">
                    <ReviewPanel thread={active} onClose={appStore.toggleReview} />
                </div>
            )}
        </div>
    )
})

/** Tab and layout shortcuts. ⌃1–9 goes to a project (its window), ⌘1–9 to a tab (src/platform.ts has them elsewhere). */
function useShortcuts() {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // Which key does what is src/lib/shortcuts.ts; this is what each one does.
            switch (shortcutOf('app', e)) {
                case 'next-tab':
                    e.preventDefault()
                    appStore.cycleTab(1)
                    break
                case 'previous-tab':
                    e.preventDefault()
                    appStore.cycleTab(-1)
                    break
                // ⌃` as in VS Code and JetBrains: open and focus the terminal, or hide it from inside.
                case 'terminal':
                    e.preventDefault()
                    terminalStore.toggle(e.target instanceof Element && !!e.target.closest('.xterm'))
                    break
                case 'browser':
                    e.preventDefault()
                    browserStore.toggle()
                    break
                case 'project': {
                    const project = appStore.projects[projectDigit(e) - 1]
                    if (project) {
                        e.preventDefault()
                        appStore.selectProject(project.cwd)
                    }
                    break
                }
                case 'new-thread':
                    if (appStore.activeProject) {
                        e.preventDefault()
                        appStore.newThread(appStore.activeProject)
                    }
                    break
                case 'close-tab':
                    if (appStore.activeTab) {
                        e.preventDefault()
                        void closeTabWithConfirm(appStore.activeTab)
                    }
                    break
                case 'focus-tab':
                    e.preventDefault()
                    appStore.focusTabAt(e.key === '9' ? -1 : Number(e.key) - 1)
                    break
                case 'layout':
                    e.preventDefault()
                    appStore.toggleLayout()
                    break
                case 'sidebar':
                    e.preventDefault()
                    appStore.toggleSidebar()
                    break
                case 'files':
                    e.preventDefault()
                    appStore.showSidebarView('files')
                    break
                case 'search':
                    e.preventDefault()
                    appStore.setSearchOpen(!appStore.searchOpen)
                    break
                case 'commands':
                    e.preventDefault()
                    if (appStore.active)
                        appStore.active.pickerOpen = true
                    break
            }
        }
        // Editor tabs save on their own shortly after typing stops; leaving the window saves now.
        const onBlur = () => void appStore.flushFiles()
        window.addEventListener('keydown', onKey)
        window.addEventListener('blur', onBlur)
        window.addEventListener('pagehide', onBlur)
        return () => {
            window.removeEventListener('keydown', onKey)
            window.removeEventListener('blur', onBlur)
            window.removeEventListener('pagehide', onBlur)
        }
    }, [])
}

export const App = observer(() => {
    useShortcuts()
    const env = appStore.env
    return (
        <TooltipProvider delayDuration={300}>
            <div className="flex h-full w-full flex-col overflow-hidden bg-ide-frame text-gray-900">
                {!env && (
                    <div className="app-drag flex flex-1 items-center justify-center">
                        <Loader2 size={20} className="animate-spin text-gray-400" />
                    </div>
                )}
                {env && !env.ok && !appStore.setupOpen && <EnvError error={env.error} />}
                {env && appStore.setupOpen && (
                    <>
                        <header className="app-drag h-[38px] shrink-0" />
                        <Setup />
                    </>
                )}
                {env?.ok && !appStore.setupOpen && appStore.windowProjects.length > 0 && (
                    <>
                        <MainToolbar />
                        <Workspace />
                        <StatusBar />
                    </>
                )}
                {env?.ok && !appStore.setupOpen && appStore.windowProjects.length === 0 && (
                    <>
                        {/* Title bar strip: drags the window, clears the traffic lights. */}
                        <header className="app-drag h-[38px] shrink-0" />
                        <Welcome />
                    </>
                )}
            </div>
            <SettingsDialog />
            <SearchDialog />
            <SessionInfoDialog />
            {/* Settings covers the top of the window up to its title: toasts go under it there, in the room its height leaves. */}
            <Toaster position={appStore.settingsOpen ? 'bottom-center' : 'top-center'} offset={appStore.settingsOpen ? 8 : undefined} visibleToasts={appStore.settingsOpen ? 1 : 3} />
        </TooltipProvider>
    )
})
