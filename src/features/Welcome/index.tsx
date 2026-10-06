// Welcome window, as in WebStorm: shown by a window with no project (first launch, or after its last
// project was closed). Picking a project opens it in this window; one already open elsewhere brings
// that window forward instead.
import type { Project } from '@/store/app'
import { Button } from '@/components/ui/button'
import { tr } from '@/lib/i18n'
import { appStore } from '@/store/app'
import { FolderOpen } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import { ProjectItem } from '../Toolbar'

export const Welcome = observer(() => {
    const projects = appStore.projects
    const [index, setIndex] = useState(0)
    const [branches, setBranches] = useState<Record<string, string | null>>({})
    const listRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        listRef.current?.focus()
    }, [])

    const cwds = projects.map(p => p.cwd).join('\n')
    useEffect(() => {
        let cancelled = false
        void window.pi.gitBranches(projects.map(p => p.cwd)).then(b => !cancelled && setBranches(b))
        return () => {
            cancelled = true
        }
    // Refetched when the list changes, not on every render.
    }, [cwds])

    useEffect(() => {
        listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
    }, [index])

    const pick = (p: Project | undefined) => p && appStore.selectProject(p.cwd)

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : -1
            setIndex(i => (i + step + projects.length) % Math.max(1, projects.length))
        }
        else if (e.key === 'Enter') {
            e.preventDefault()
            pick(projects[index])
        }
    }

    return (
        <div className="flex min-h-0 flex-1 px-[5px] pb-[5px]">
            <main className="ide-island flex min-w-0 flex-1 justify-center overflow-y-auto bg-ide-editor">
                <div className="flex w-full max-w-[520px] flex-col px-6 pb-10 pt-[12vh]">
                    <div className="flex items-center justify-between gap-3 pb-4">
                        <h1 className="!text-[15px] !font-semibold text-gray-900">{tr('项目', 'Projects')}</h1>
                        <Button variant="outline" size="sm" onClick={() => void appStore.addProject()}>
                            <FolderOpen size={14} />
                            {tr('打开文件夹…', 'Open folder…')}
                        </Button>
                    </div>
                    {projects.length > 0
                        ? (
                                <div ref={listRef} tabIndex={-1} role="listbox" aria-label={tr('最近的项目', 'Recent projects')} onKeyDown={onKeyDown} className="outline-none">
                                    {projects.map((p, i) => (
                                        <ProjectItem
                                            key={p.cwd}
                                            project={p}
                                            branch={branches[p.cwd]}
                                            active={i === index}
                                            current={false}
                                            shortcut={i < 9 ? i + 1 : undefined}
                                            onHover={() => setIndex(i)}
                                            onPick={() => pick(p)}
                                            onRemove={appStore.isOpen(p.cwd) ? undefined : () => void appStore.removeProject(p.cwd)}
                                        />
                                    ))}
                                </div>
                            )
                        : <p className="text-[13px] text-gray-500">{tr('打开一个项目文件夹开始。', 'Open a project folder to start.')}</p>}
                </div>
            </main>
        </div>
    )
})
