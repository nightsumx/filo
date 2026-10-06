// Code block for markdown fences. Header + copy button come from chat's CodeViewer
// (chat/src/features/Conversation/CodeViewer.tsx); Monaco is swapped for highlight.js, which is
// synchronous, needs no CDN loader and stays cheap when hundreds of blocks are on screen.
import copy from 'copy-to-clipboard'
import hljs from 'highlight.js/lib/common'
import { Check, Copy } from 'lucide-react'
import { memo, useMemo, useState } from 'react'

const aliases: Record<string, string> = {
    sh: 'bash',
    zsh: 'bash',
    shell: 'bash',
    console: 'bash',
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    yml: 'yaml',
    md: 'markdown',
    html: 'xml',
    vue: 'xml',
}

function CopyBtn({ text }: { text: string }) {
    const [copied, setCopied] = useState(false)
    return (
        <button
            type="button"
            onClick={() => {
                copy(text, {
                    format: 'text/plain',
                    onCopy() {
                        setCopied(true)
                        setTimeout(() => setCopied(false), 1500)
                    },
                })
            }}
            className="flex h-6 items-center gap-1 rounded px-1.5 text-[12px] text-gray-500 transition-colors select-none hover:bg-black/[0.06] hover:text-gray-800"
            aria-label="复制代码"
        >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? '已复制' : '复制'}
        </button>
    )
}

export const CodeBlock = memo(({ language, code }: { language?: string, code: string }) => {
    const text = code.replace(/\n$/, '')
    const lang = language ? aliases[language.toLowerCase()] ?? language.toLowerCase() : undefined
    // hljs escapes its input, so the HTML it returns is safe to inject.
    const html = useMemo(() => {
        if (text.length > 200_000)
            return null
        try {
            return lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang }).value : null
        }
        catch {
            return null
        }
    }, [text, lang])

    return (
        <div className="not-prose my-2 overflow-hidden rounded-md bg-ide-block">
            <div className="flex h-7 items-center justify-between pl-3 pr-1 text-[11.5px] text-gray-500">
                <span className="font-mono">{language || 'text'}</span>
                <CopyBtn text={text} />
            </div>
            <pre className="!m-0 !rounded-none !bg-transparent !px-3 !py-2.5 overflow-x-auto !text-[12.5px] !leading-relaxed font-mono select-text">
                {html != null
                    ? <code className="hljs !bg-transparent !p-0" dangerouslySetInnerHTML={{ __html: html }} />
                    : <code>{text}</code>}
            </pre>
        </div>
    )
})
