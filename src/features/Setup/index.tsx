// The setup assistant, in the manner of macOS Setup Assistant: one window-filling page per step. Shown
// once (existing users too, see SETUP_VERSION) and again from Settings → Agents.
//   1. Tools: Node.js, pi, Claude Code, Codex, Grok. Each installs with its official
//      installer in a terminal shown on the page, so every step (and any question it asks) is visible.
//   2. The default agent for new threads; only an installed one can be picked.
import type { AgentKind } from '@shared/agents'
import type { SetupTool, SetupToolId } from '@shared/setup'
import { Button } from '@/components/ui/button'
import { Comment } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { agentsStore } from '@/store/agents'
import { appStore } from '@/store/app'
import { setupStore } from '@/store/setup'
import { AGENT_TOOL, DEFAULT_AGENT_CHOICES } from '@shared/setup'
import { Check, Loader2 } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import { viewOf } from '../Terminal/views'

const AGENT_NAMES: Record<string, string> = { pi: 'Pi', codex: 'Codex', claude: 'Claude Code', grok: 'Grok' }

/** What each tool is for, under its name. */
function purpose(id: SetupToolId): string {
    switch (id) {
        case 'node': return tr('很多命令行工具和 npm 包需要它。', 'Many command-line tools and npm packages need it.')
        case 'pi': return tr('Filo 运行的就是它，终端里的 pi 和 Filo 共用设置、模型和会话。', 'Filo runs it; pi in your terminal shares settings, models and sessions with Filo.')
        case 'claude': return tr('Anthropic 的编程 agent，用你自己的账号登录。', 'Anthropic\'s coding agent, signed in with your own account.')
        case 'codex': return tr('OpenAI 的编程 agent，用 ChatGPT 账号或 API key 登录。', 'OpenAI\'s coding agent, signed in with ChatGPT or an API key.')
        case 'grok': return tr('xAI 的编程 agent（Grok Build），用 xAI 账号登录。', 'xAI\'s coding agent (Grok Build), signed in with your xAI account.')
    }
}

export const Setup = observer(() => {
    useEffect(() => {
        setupStore.start()
        agentsStore.ensure()
    }, [])
    return (
        <div className="flex min-h-0 flex-1 px-[5px] pb-[5px]">
            <main className="ide-island flex min-w-0 flex-1 justify-center overflow-y-auto bg-ide-editor" aria-label={tr('设置向导', 'Setup assistant')}>
                <div className="flex min-h-full w-full max-w-[620px] flex-col px-6 pt-[5vh]">
                    {setupStore.page === 1 ? <ToolsPage /> : <AgentPage />}
                </div>
            </main>
        </div>
    )
})

/** Stays in view when installed tools' paths make the page taller than the window. */
const FOOTER = 'sticky bottom-0 flex items-center gap-3 bg-ide-editor pb-8'

function Heading({ step, title, subtitle }: { step: number, title: string, subtitle: string }) {
    return (
        <div className="pb-5">
            <div className="pb-2 text-[12px] tabular-nums text-[var(--jb-comment)]">{tr(`第 ${step} 步，共 2 步`, `Step ${step} of 2`)}</div>
            <h1 className="!text-[20px] !font-semibold text-gray-900">{title}</h1>
            <p className="pt-1.5 text-[13px] leading-5 text-gray-600">{subtitle}</p>
        </div>
    )
}

const ToolsPage = observer(() => {
    const probe = setupStore.probe
    return (
        <>
            <Heading
                step={1}
                title={tr('准备工具', 'Get your tools ready')}
                subtitle={tr('用各自的官方安装程序装到系统里，终端和 Filo 都能用。安装过程在下面的终端里进行，需要时在里面输入密码或回答提示。', 'Each installs with its official installer, system-wide, for your terminal and Filo alike. It runs in the terminal below; type your password or answer its prompts there when asked.')}
            />
            <div className="flex shrink-0 flex-col divide-y divide-[var(--jb-separator)]" aria-busy={!probe}>
                {!probe && (
                    <div className="flex items-center gap-2 py-3 text-[13px] text-gray-500">
                        <Loader2 size={14} className="animate-spin" />
                        {tr('正在检查…', 'Checking…')}
                    </div>
                )}
                {probe?.tools.map(tool => <ToolRow key={tool.id} tool={tool} />)}
            </div>
            {setupStore.terminal && <InstallTerminal />}
            <div className={cn(FOOTER, 'pt-6', !setupStore.terminal && 'mt-auto')}>
                <Button variant="ghost" size="sm" disabled={setupStore.probing || setupStore.installing} onClick={() => void setupStore.refresh()}>
                    {setupStore.probing && <Loader2 size={12} className="animate-spin" />}
                    {tr('重新检查', 'Check again')}
                </Button>
                <Button className="ml-auto" variant="primary" disabled={setupStore.installing} onClick={() => setupStore.setPage(2)}>
                    {tr('下一步', 'Continue')}
                </Button>
            </div>
        </>
    )
})

const ToolRow = observer(({ tool }: { tool: SetupTool }) => {
    const running = setupStore.terminal?.tool === tool.id && setupStore.installing
    const installed = !!tool.path
    return (
        <div className="flex items-center gap-4 py-3" data-setup-tool={tool.id} data-installed={installed}>
            <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 text-[13px] leading-5 text-gray-900">
                    {tool.label}
                    {installed && tool.version && <span className="text-[12px] tabular-nums text-[var(--jb-comment)]">{tool.version}</span>}
                </div>
                <Comment className="mt-0.5">{purpose(tool.id)}</Comment>
                {installed && <Comment className="mt-0.5 font-mono [overflow-wrap:anywhere]">{tool.path}</Comment>}
                {!installed && setupStore.notFound.includes(tool.id) && (
                    <Comment className="mt-0.5 text-amber-600 dark:text-amber-400">
                        {tr('安装程序已结束，但登录 shell 里还找不到它。看看终端里的输出，或打开新终端试试。', 'The installer ended, but your login shell does not find it yet. Check the output above, or try a new terminal.')}
                    </Comment>
                )}
                {!installed && !tool.install && (
                    <Comment className="mt-0.5">{tr('这台电脑上没有自动安装方式，请用系统的包管理器安装。', 'No automatic install on this computer; use your system\'s package manager.')}</Comment>
                )}
            </div>
            {installed
                ? (
                        <span className="flex shrink-0 items-center gap-1 text-[12px] text-ide-success">
                            <Check size={14} strokeWidth={2.25} aria-hidden />
                            {tr('已安装', 'Installed')}
                        </span>
                    )
                : tool.install && (
                    <Button
                        variant="outline"
                        size="sm"
                        title={tool.install}
                        disabled={setupStore.installing}
                        onClick={() => void setupStore.install(tool.id, TERMINAL_SIZE)}
                    >
                        {running && <Loader2 size={12} className="animate-spin" />}
                        {running ? tr('安装中…', 'Installing…') : tr('安装', 'Install')}
                    </Button>
                )}
        </div>
    )
})

/** The terminal box's size at the page's width, until it is laid out and fits itself. */
const TERMINAL_SIZE = { cols: 80, rows: 14 }

const InstallTerminal = observer(() => {
    const host = useRef<HTMLDivElement>(null)
    const id = setupStore.terminal!.id
    const info = setupStore.terminalInfo
    const label = setupStore.tool(setupStore.terminal!.tool)?.label ?? ''
    useEffect(() => {
        const view = viewOf(id)
        if (host.current)
            view.mount(host.current)
        view.focus()
        const fit = new ResizeObserver(() => view.fit())
        if (host.current)
            fit.observe(host.current)
        return () => {
            fit.disconnect()
            view.unmount()
        }
    }, [id])
    const exit = info?.exit
    const status = !exit
        ? tr(`正在安装 ${label}`, `Installing ${label}`)
        : exit.code === 0
            ? tr(`${label} 安装程序已结束`, `${label} installer finished`)
            : tr(`${label} 安装失败（退出码 ${exit.code}）`, `${label} install failed (exit code ${exit.code})`)
    return (
        <section className="mt-4 flex min-h-[200px] flex-1 flex-col overflow-hidden rounded-[8px] bg-ide-panel light:shadow-[0_0_0_1px_var(--jb-separator)]" aria-label={status}>
            <div className="flex h-8 items-center gap-2 px-3 text-[12px] text-gray-600">
                {!exit && <Loader2 size={12} className="animate-spin" />}
                <span role="status" className={cn('shrink-0 whitespace-nowrap', exit && exit.code !== 0 && 'text-[#e5534b]')}>{status}</span>
                <span className="ml-auto min-w-0 truncate font-mono text-[11px] text-[var(--jb-comment)]">{info?.command}</span>
            </div>
            <div ref={host} className="min-h-0 flex-1 px-2 pb-2" />
        </section>
    )
})

const AgentPage = observer(() => {
    const available = (agent: AgentKind) => !!setupStore.tool(AGENT_TOOL[agent]!)?.path
    const [choice, setChoice] = useState<AgentKind>(() => available(appStore.defaultAgent) ? appStore.defaultAgent : DEFAULT_AGENT_CHOICES.find(available) ?? 'pi')
    const finish = async () => {
        await setupStore.close()
        appStore.finishSetup(choice)
        void appStore.refreshEnv()
        // Claude Code connects through an ACP adapter the app installs once.
        const agent = agentsStore.get(choice)
        if (choice !== 'pi' && agent && !agent.available && agent.installable)
            void agentsStore.install(choice)
    }
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')
            return
        e.preventDefault()
        const choices = DEFAULT_AGENT_CHOICES.filter(available)
        const next = choices[(choices.indexOf(choice) + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]
        setChoice(next)
        document.querySelector<HTMLElement>(`[data-agent-choice="${next}"]`)?.focus()
    }
    return (
        <>
            <Heading
                step={2}
                title={tr('选择默认 agent', 'Choose your default agent')}
                subtitle={tr('新线程用它开始。每个线程仍可在输入框左下角换，之后也能在 设置 → Agent 里改。', 'New threads start with it. Any thread can still switch at the bottom left of the composer, and Settings → Agents changes it later.')}
            />
            <div role="radiogroup" aria-label={tr('默认 agent', 'Default agent')} onKeyDown={onKeyDown} className="flex flex-col gap-1.5">
                {DEFAULT_AGENT_CHOICES.map((agent) => {
                    const tool = setupStore.tool(AGENT_TOOL[agent]!)
                    const ok = available(agent)
                    const note = ok
                        ? tr(`已安装 ${tool?.version ?? ''}`.trim(), `Installed ${tool?.version ?? ''}`.trim())
                        : tr('未安装，可回上一步安装', 'Not installed; go back to install it')
                    const checked = choice === agent
                    return (
                        <button
                            key={agent}
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            aria-disabled={!ok}
                            tabIndex={checked ? 0 : -1}
                            data-agent-choice={agent}
                            onClick={() => ok && setChoice(agent)}
                            className={cn(
                                'flex items-center gap-3 rounded-[8px] px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ide-accent/50',
                                checked ? 'bg-ide-accent/[0.14]' : 'bg-[var(--jb-fill)]',
                                ok ? (!checked && 'hover:bg-[var(--jb-fill-hover)]') : 'cursor-default opacity-50',
                            )}
                        >
                            <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full', checked ? 'bg-ide-accent' : 'shadow-[inset_0_0_0_1.5px_var(--jb-field-border)]')} aria-hidden>
                                {checked && <span className="h-1.5 w-1.5 rounded-full bg-always-white" />}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className={cn('block text-[13px] leading-5', checked ? 'text-ide-accent dark:text-[#8fb3ff]' : 'text-gray-900')}>{AGENT_NAMES[agent]}</span>
                                <span className="block text-[12px] leading-[18px] text-[var(--jb-comment)]">{note}</span>
                            </span>
                        </button>
                    )
                })}
            </div>
            <div className={cn(FOOTER, 'mt-auto pt-8')}>
                <Button variant="ghost" size="sm" onClick={() => setupStore.setPage(1)}>{tr('上一步', 'Back')}</Button>
                <Button className="ml-auto" variant="primary" onClick={() => void finish()}>{tr('开始使用', 'Get started')}</Button>
            </div>
        </>
    )
})
