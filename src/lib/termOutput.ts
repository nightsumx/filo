// Command output as pi's TUI displays it (render-utils getTextOutput): ANSI escapes and carriage
// returns dropped. Plus the one GUI-only touch: runs of block-drawing lines (terminal QR codes,
// banners) are kept whole in the bash tail and drawn without line gaps, so a login QR can be scanned.

// CSI sequences (colors, cursor moves), OSC (titles, hyperlinks), and the remaining two-byte escapes.
const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-Z\\-_]/g

export function displayText(text: string): string {
    return text.replace(ANSI, '').replace(/\r/g, '')
}

/** Lines the bash tail shows under its result line (pi's TUI shows five). */
export const BASH_TAIL_LINES = 5
/** A block-art run this long is still pulled whole into the tail; past it, the tail stays short. */
const MAX_ART_LINES = 80

/** Only block elements (▀▄█▌▐░▒▓…) and spaces, with at least two blocks: one row of a QR code. */
export function isBlockArt(line: string): boolean {
    let blocks = 0
    for (const c of line) {
        if (c >= '\u2580' && c <= '\u259F')
            blocks++
        else if (c !== ' ' && c !== '\u00A0')
            return false
    }
    return blocks >= 2
}

/**
 * Last lines of the output. When they cut into a block-art run, the tail starts at the top of the
 * run instead, so a QR code printed just before "scan to log in" shows complete.
 */
export function tailLines(text: string, count = BASH_TAIL_LINES): string[] {
    const lines = text.replace(/\n+$/, '').split('\n')
    if (lines.length === 1 && !lines[0])
        return []
    let start = Math.max(0, lines.length - count)
    let end = -1
    for (let i = start; i < lines.length; i++) {
        if (isBlockArt(lines[i])) {
            end = i
            break
        }
    }
    if (end !== -1) {
        let top = end
        while (top > 0 && isBlockArt(lines[top - 1]))
            top--
        if (end - top < MAX_ART_LINES)
            start = Math.min(start, top)
    }
    return lines.slice(start)
}

export interface OutputSegment { art: boolean, lines: string[] }

/**
 * How many of `lines` a preview of `max` lines shows: `max`, or past it to the end of a block-art
 * run the cut would split (up to MAX_ART_LINES), since half a QR code is no QR code.
 */
export function headCount(lines: string[], max: number): number {
    if (lines.length <= max || !isBlockArt(lines[max - 1]) || !isBlockArt(lines[max]))
        return Math.min(max, lines.length)
    let end = max
    while (end < lines.length && isBlockArt(lines[end]) && end - max < MAX_ART_LINES)
        end++
    return end
}

/** Consecutive lines grouped into plain text and block art. */
export function segmentOutput(lines: string[]): OutputSegment[] {
    const segments: OutputSegment[] = []
    for (const line of lines) {
        const art = isBlockArt(line)
        const last = segments.at(-1)
        if (last && last.art === art)
            last.lines.push(line)
        else
            segments.push({ art, lines: [line] })
    }
    return segments
}
