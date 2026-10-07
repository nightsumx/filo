import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { appStore } from '@/store/app'
import { AlertTriangle, FolderPlus, Loader2, Plus } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { Fragment, useEffect, useRef } from 'react'
import { ReviewPanel } from './features/Review'
import { SearchDialog } from './features/Search'
import { SettingsDialog } from './features/Settings'
import { Sidebar } from './features/Sidebar'
import { StatusBar } from './features/StatusBar'
import { closeTabWithConfirm, TabBar } from './features/Tabs/TabBar'
import { ShortcutHints, ThreadPane } from './features/Thread'
import { MainToolbar } from './features/Toolbar'
import { Welcome } from './features/Welcome'
import { newThreadLabel, tr } from '@/lib/i18n'

const EnvError = observer(({ error }: { error: string }) => (
    <div className="app-drag flex h-full w-full flex-col items-center justify-center gap-4 px-8 text-center">
        <AlertTriangle size={28} className="text-amber-500" />
        <h1 className="!text-lg !font-semibold">{tr('没有找到可用的 pi', 'No working pi found')}</h1>
        <p className="max-w-md whitespace-pre-wrap text-[13px] text-gray-500 select-text">{error}</p>
        <Button variant="primary" onClick={() => void appStore.retryEnv()}>{tr('重试', 'Retry')}</Button>
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
            {panes.map((thread, i) => (
                <Fragment key={thread.id}>
                    {i > 0 && <div className="w-px shrink-0" />}
                    <ThreadPane thread={thread} focused={thread.key === appStore.activeKey} />
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
    return (
        <div className="flex min-h-0 flex-1 gap-[5px] px-[5px]">
            {appStore.sidebarOpen && <Sidebar />}
            <main className="ide-island flex min-w-0 flex-1 flex-col bg-ide-editor">
                <TabBar />
                <div className="flex min-h-0 flex-1">
                    <Panes />
                </div>
            </main>
            {appStore.reviewOpen && active && (
                <div className="ide-island w-[40%] min-w-[340px] max-w-[700px] shrink-0">
                    <ReviewPanel thread={active} onClose={appStore.toggleReview} />
                </div>
            )}
        </div>
    )
})

/** Tab and layout shortcuts. Ctrl+1–9 goes to a project (its window), ⌘1–9 to a tab. */
function useShortcuts() {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const key = e.key.toLowerCase()
            if (e.ctrlKey && !e.metaKey && e.key === 'Tab') {
                e.preventDefault()
                appStore.cycleTab(e.shiftKey ? -1 : 1)
                return
            }
            if (e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
                const project = appStore.projects[Number(e.key) - 1]
                if (project) {
                    e.preventDefault()
                    appStore.selectProject(project.cwd)
                }
                return
            }
            if (!e.metaKey || e.ctrlKey || e.altKey)
                return
            if (key === 't' && !e.shiftKey && appStore.activeProject) {
                e.preventDefault()
                appStore.newThread(appStore.activeProject)
            }
            else if (key === 'w' && !e.shiftKey && appStore.active) {
                e.preventDefault()
                void closeTabWithConfirm(appStore.active)
            }
            else if (/^[1-9]$/.test(e.key)) {
                e.preventDefault()
                appStore.focusTabAt(e.key === '9' ? -1 : Number(e.key) - 1)
            }
            else if (e.shiftKey && (e.key === '[' || e.key === '{' || e.key === ']' || e.key === '}')) {
                e.preventDefault()
                appStore.cycleTab(e.key === '[' || e.key === '{' ? -1 : 1)
            }
            else if (e.key === '\\') {
                e.preventDefault()
                appStore.toggleLayout()
            }
            else if (key === 'b' && !e.shiftKey) {
                e.preventDefault()
                appStore.toggleSidebar()
            }
            else if (key === 'f' && e.shiftKey) {
                e.preventDefault()
                appStore.setSearchOpen(!appStore.searchOpen)
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
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
                {env && !env.ok && <EnvError error={env.error} />}
                {env?.ok && appStore.windowProjects.length > 0 && (
                    <>
                        <MainToolbar />
                        <Workspace />
                        <StatusBar />
                    </>
                )}
                {env?.ok && appStore.windowProjects.length === 0 && (
                    <>
                        {/* Title bar strip: drags the window, clears the traffic lights. */}
                        <header className="app-drag h-[38px] shrink-0" />
                        <Welcome />
                    </>
                )}
            </div>
            <SettingsDialog />
            <SearchDialog />
            <Toaster position="top-center" />
        </TooltipProvider>
    )
})
