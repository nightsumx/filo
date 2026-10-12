import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

const CARET = '<span class="animate-pulse">▍</span>'
const html = (content: string, streaming = true) => renderToStaticMarkup(createElement(Markdown, { content, streaming }))

describe('Markdown streaming caret', () => {
    it('ends the last line of text instead of taking a line of its own', () => {
        expect(html('one\n\ntwo')).toContain(`<p>two${CARET}</p>`)
        expect(html('- a\n- **b**')).toContain(`<strong>b${CARET}</strong>`)
        expect(html('| x |\n|---|\n| y |')).toContain(`y${CARET}</td>`)
    })

    it('goes after code and links, never inside them; none after a code block', () => {
        expect(html('run `ls`')).toContain(`<code class="align-text-top">ls</code>${CARET}</p>`)
        expect(html('see [docs](https://x.y)')).toContain(`</a>${CARET}</p>`)
        expect(html('```ts\nconst a = 1\n```')).not.toContain(CARET)
    })

    it('shows alone before any text, and not at all once the message ends', () => {
        expect(html('')).toContain(CARET)
        expect(html('done', false)).not.toContain(CARET)
    })
})
