// The mark of the agent a thread runs, from LobeHub's icon set (MIT), in currentColor so it follows
// the theme like pi's π. Shown where a thread is named (project tree, tabs, the agent picker).
import claude from '@lobehub/icons-static-svg/icons/claudecode.svg?raw'
import codex from '@lobehub/icons-static-svg/icons/codex.svg?raw'
import cursor from '@lobehub/icons-static-svg/icons/cursor.svg?raw'
import gemini from '@lobehub/icons-static-svg/icons/geminicli.svg?raw'
import copilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg?raw'
import grok from '@lobehub/icons-static-svg/icons/grok.svg?raw'
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg?raw'
import type { AcpAgentId, AgentKind } from '@shared/agents'
import { cn } from '@/lib/utils'

/** Without the SVG's own <title>: its tooltip would cover the row's. */
function untitled(svg: string): string {
    const start = svg.indexOf('<title>')
    const end = svg.indexOf('</title>')
    return start < 0 || end < 0 ? svg : svg.slice(0, start) + svg.slice(end + '</title>'.length)
}

const ICONS: Record<AcpAgentId, string> = {
    claude: untitled(claude),
    codex: untitled(codex),
    copilot: untitled(copilot),
    cursor: untitled(cursor),
    gemini: untitled(gemini),
    grok: untitled(grok),
    opencode: untitled(opencode),
}

/** A 14px agent mark: pi's italic π, the others' brand glyph. Decorative; the label says the name. */
export function AgentIcon({ agent, dim, className }: { agent: AgentKind, dim?: boolean, className?: string }) {
    const color = dim ? 'text-gray-400' : 'text-gray-500'
    if (agent === 'pi')
        return <span aria-hidden className={cn('w-3.5 shrink-0 text-center font-serif text-[14px] italic leading-none select-none', color, className)}>π</span>
    // Bundled static SVGs (no user input); they size themselves to 1em.
    return <span aria-hidden className={cn('flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[13px] leading-none', color, className)} dangerouslySetInnerHTML={{ __html: ICONS[agent] }} />
}
