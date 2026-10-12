import { segmentOutput } from '@/lib/termOutput'

/** Text of a block of lines; a trailing empty line needs one more break to take up its row. */
function blockText(lines: string[]): string {
    const text = lines.join('\n')
    return lines.at(-1) === '' ? `${text}\n` : text
}

/**
 * Output lines inside a `<pre>`. Block-art runs (terminal QR codes) are drawn at line-height 1 and
 * never wrapped, so their rows touch like in a terminal and a phone can scan them; they also take
 * the foreground color, since a dimmed QR code scans badly.
 */
export function TermLines({ lines }: { lines: string[] }) {
    return segmentOutput(lines).map((segment, i) => segment.art
        ? (
                <span key={i} className="block max-w-full overflow-x-auto whitespace-pre leading-none text-gray-900 [word-break:normal]">
                    {segment.lines.join('\n')}
                </span>
            )
        : <span key={i} className="block">{blockText(segment.lines)}</span>)
}
