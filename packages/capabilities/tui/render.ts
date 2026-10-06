// Transcript rendering for the capability tools in the terminal, in Claude Code's shape:
//   ⏺ Title(detail)
//     ⎿  result, with later lines indented under it
// The desktop app has its own views and never calls these.
import type { Theme } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'

/** The parts of pi's tool render context these helpers read. */
export interface RenderState {
    isError: boolean
    isPartial: boolean
    executionStarted: boolean
}

/** The ⏺ marker: dim while running, green when done, red on error. */
export function dot(theme: Theme, context: RenderState, done = context.executionStarted && !context.isPartial): string {
    return context.isError ? theme.fg('error', '⏺') : done ? theme.fg('success', '⏺') : theme.fg('dim', '⏺')
}

export function header(theme: Theme, context: RenderState, title: string, detail?: string, done?: boolean): Text {
    return new Text(`${dot(theme, context, done)} ${theme.bold(title)}${detail ? `(${detail})` : ''}`, 0, 0)
}

/** Lines hung under "  ⎿  ". */
export function hang(theme: Theme, lines: string[]): Text {
    return new Text(lines.map((line, i) => (i ? '     ' : theme.fg('dim', '  ⎿  ')) + line).join('\n'), 0, 0)
}

export const oneLine = (text: string, max = 80) => {
    const line = text.trim().split('\n')[0] ?? ''
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export const count = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export const duration = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000))
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
