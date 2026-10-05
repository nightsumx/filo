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
        <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
            {content}
        </ReactMarkdown>
        {streaming && <span className="animate-pulse">▍</span>}
    </div>
))
