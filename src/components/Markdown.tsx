// Adapted from chat/src/components/Markdown.tsx + markdownPlugins/builtins.tsx.
// Differences: no IM mention plugin, and no rehype-raw — agent output is untrusted, so raw HTML
// in it is shown as text instead of being rendered inside the app window.
import type { Components } from 'react-markdown'
import { cn } from '@/lib/utils'
import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock'

const remarkPlugins = [remarkGfm]

interface HastNode {
    type: string
    tagName?: string
    value?: string
    properties?: Record<string, unknown>
    children?: HastNode[]
}

/** Elements the caret goes after rather than inside: void tags, code (CodeBlock reads its text), links. */
const CARET_AFTER = new Set(['br', 'hr', 'img', 'input', 'code', 'a'])

/**
 * Streaming caret at the end of the last line of text, inside the deepest last block. Put after the
 * blocks it took a line of its own, which vanished when the message ended and moved the text.
 * None after a code block: inside it would be code, after it a line of its own again.
 */
function rehypeCaret() {
    return (tree: HastNode) => {
        let parent = tree
        for (;;) {
            const last = parent.children?.findLast(n => n.type !== 'text' || !!n.value?.trim())
            if (last?.tagName === 'pre')
                return
            if (last?.type !== 'element' || CARET_AFTER.has(last.tagName ?? ''))
                break
            parent = last
        }
        parent.children ??= []
        parent.children.push({ type: 'element', tagName: 'span', properties: { className: ['animate-pulse'] }, children: [{ type: 'text', value: '▍' }] })
    }
}

const streamingRehypePlugins = [rehypeCaret]

const components: Partial<Components> = {
    code: ({ children, className, node: _node, ...rest }) => {
        const match = /language-([\w+-]+)/.exec(className || '')
        const text = String(children)
        if (match || text.includes('\n'))
            return <CodeBlock language={match?.[1]} code={text} />
        return <code {...rest} className="align-text-top">{children}</code>
    },
    pre: ({ children }) => <>{children}</>,
    a: ({ href, children, node: _node, ...props }) => (
        <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    ),
}

export const Markdown = memo(({ content, className, streaming }: {
    content: string
    className?: string
    streaming?: boolean
}) => (
    <div
        className={cn(
            'markdown-body w-full overflow-hidden break-words select-text',
            'text-[var(--text-color-a)]',
            '[&_p]:my-1.5',
            '[--bgColor-default:transparent]',
            className,
        )}
    >
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={streaming ? streamingRehypePlugins : undefined} components={components}>
            {content}
        </ReactMarkdown>
    </div>
))
