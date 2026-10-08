import type { GitFileDiff } from '@shared/ipc'
import type { PreviewKind } from '@/lib/filePreview'
import { CodeBlock } from '@/components/CodeBlock'
import { Markdown } from '@/components/Markdown'
import { parseDelimited } from '@/lib/filePreview'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { memo, useMemo, useState } from 'react'
import { Caption, note, sideLabel, VersionSwitch } from './previewParts'

/** Tables stop here; the diff view still has every line. */
const MAX_ROWS = 500

/**
 * A text file rendered: Markdown, HTML (sandboxed, no scripts, no network), CSV / TSV as a table,
 * a Jupyter notebook as its cells and outputs. Two versions switch rather than sit side by side.
 */
export function TextPreview({ kind, name, diff, deleted, added }: { kind: PreviewKind, name: string, diff: GitFileDiff, deleted: boolean, added: boolean }) {
    // Only the versions that exist; one when nothing changed in the text (a rename).
    const sides = useMemo(() => {
        const list: { key: 'old' | 'new', text: string }[] = []
        if (!added && (deleted || diff.oldText !== diff.newText))
            list.push({ key: 'old', text: diff.oldText })
        if (!deleted)
            list.push({ key: 'new', text: diff.newText })
        return list
    }, [diff, added, deleted])
    const [index, setIndex] = useState(sides.length - 1)
    const side = sides[Math.min(index, sides.length - 1)]
    if (!side)
        return <div className={note}>{tr('空文件', 'Empty file')}</div>
    const both = sides.length > 1
    return (
        <div>
            <VersionSwitch labels={sides.map(s => sideLabel(s.key, both))} value={index} onChange={setIndex} />
            <Rendered key={side.key} kind={kind} name={name} text={side.text} />
        </div>
    )
}

const Rendered = memo(function Rendered({ kind, name, text }: { kind: PreviewKind, name: string, text: string }) {
    if (!text.trim())
        return <div className={note}>{tr('空文件', 'Empty file')}</div>
    if (kind === 'markdown') {
        return (
            <div className="max-h-[640px] overflow-y-auto rounded-md bg-ide-block px-4 py-3">
                <Markdown content={text} className="text-[13px]" />
            </div>
        )
    }
    if (kind === 'html') {
        // sandbox="" : no scripts, forms, popups or navigation; the page's CSP blocks remote loads.
        return <iframe sandbox="" srcDoc={text} title={name} className="h-[520px] w-full rounded-md bg-always-white" />
    }
    if (kind === 'csv' || kind === 'tsv')
        return <Table text={text} separator={kind === 'tsv' ? '\t' : ','} />
    if (kind === 'notebook')
        return <Notebook text={text} />
    return null
})

function Table({ text, separator }: { text: string, separator: string }) {
    const { rows, more } = useMemo(() => parseDelimited(text, separator, MAX_ROWS + 1), [text, separator])
    const [head, ...body] = rows
    const shown = body.slice(0, MAX_ROWS)
    const width = Math.max(...rows.map(r => r.length))
    return (
        <div>
            <Caption detail={more || body.length > MAX_ROWS ? tr(`前 ${MAX_ROWS} 行，共 ${width} 列`, `First ${MAX_ROWS} rows, ${width} columns`) : tr(`${body.length} 行，${width} 列`, `${body.length} rows, ${width} columns`)} />
            <div className="max-h-[520px] overflow-auto rounded-md bg-ide-block">
                {/* Rows alternate fills instead of drawing grid lines. */}
                <table className="w-max min-w-full border-collapse text-[12px] tabular-nums">
                    <thead className="sticky top-0 bg-ide-block">
                        <tr>
                            {Array.from({ length: width }, (_, i) => (
                                <th key={i} scope="col" className="max-w-[20rem] truncate px-2.5 py-1.5 text-left font-semibold text-gray-800" title={head?.[i]}>{head?.[i] ?? ''}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((row, r) => (
                            <tr key={r} className={cn(r % 2 === 0 && 'bg-black/[0.035]')}>
                                {Array.from({ length: width }, (_, i) => (
                                    <td key={i} className="max-w-[20rem] truncate px-2.5 py-1 text-gray-700" title={row[i]}>{row[i] ?? ''}</td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

interface NbOutput {
    output_type: string
    name?: string
    text?: string | string[]
    data?: Record<string, string | string[] | object>
    ename?: string
    evalue?: string
    traceback?: string[]
}
interface NbCell {
    cell_type: 'markdown' | 'code' | 'raw'
    source: string | string[]
    execution_count?: number | null
    outputs?: NbOutput[]
}

const joined = (v: unknown): string => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '')
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g
const outputText = 'whitespace-pre-wrap break-words px-1 font-mono text-[12px] leading-relaxed'

/** One output; HTML and JavaScript outputs are untrusted, so their plain-text form is shown instead. */
function Output({ output }: { output: NbOutput }) {
    if (output.output_type === 'stream')
        return <pre className={cn(outputText, output.name === 'stderr' ? 'text-red-500' : 'text-gray-700')}>{joined(output.text)}</pre>
    if (output.output_type === 'error') {
        return (
            <pre className={cn(outputText, 'text-red-500')}>
                {[`${output.ename ?? 'Error'}: ${output.evalue ?? ''}`, ...(output.traceback ?? []).map(l => l.replace(ANSI, ''))].join('\n')}
            </pre>
        )
    }
    const data = output.data ?? {}
    for (const mime of ['image/png', 'image/jpeg', 'image/gif']) {
        if (data[mime])
            return <img src={`data:${mime};base64,${joined(data[mime]).replace(/\s/g, '')}`} alt="" className="max-w-full rounded bg-always-white" />
    }
    if (data['image/svg+xml'])
        return <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(joined(data['image/svg+xml']))}`} alt="" className="max-w-full rounded bg-always-white" />
    if (data['text/markdown'])
        return <Markdown content={joined(data['text/markdown'])} className="text-[13px]" />
    if (data['text/plain'])
        return <pre className={cn(outputText, 'text-gray-700')}>{joined(data['text/plain'])}</pre>
    return null
}

function Notebook({ text }: { text: string }) {
    const nb = useMemo(() => {
        try {
            const parsed = JSON.parse(text)
            return Array.isArray(parsed?.cells) ? parsed as { cells: NbCell[], metadata?: any } : null
        }
        catch {
            return null
        }
    }, [text])
    if (!nb)
        return <div className={note}>{tr('无法解析这个笔记本', 'This notebook could not be parsed')}</div>
    const language = nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? 'python'
    return (
        <div className="flex max-h-[720px] flex-col gap-2 overflow-y-auto rounded-md bg-ide-block px-3 py-2">
            {nb.cells.map((cell, i) => {
                const source = joined(cell.source)
                if (cell.cell_type === 'markdown')
                    return <Markdown key={i} content={source} className="text-[13px]" />
                if (cell.cell_type === 'raw')
                    return <pre key={i} className={cn(outputText, 'text-gray-600')}>{source}</pre>
                return (
                    <div key={i} className="flex flex-col gap-1">
                        <span className="font-mono text-[11px] tabular-nums text-gray-400">{`In [${cell.execution_count ?? ' '}]`}</span>
                        {/* CodeBlock's own fill would vanish on the block; the editor fill sets it apart. */}
                        <div className="[&>div]:!my-0 [&>div]:!bg-ide-editor">
                            <CodeBlock language={language} code={source} />
                        </div>
                        {cell.outputs?.map((o, j) => <Output key={j} output={o} />)}
                    </div>
                )
            })}
        </div>
    )
}
