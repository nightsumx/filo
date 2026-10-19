import { describe, expect, it } from 'vitest'
import { cssComplete, cssDefinition, cssHover, cssLinks, cssSelectors, cssValidate } from './css'
import { toCompletionItems, toSquiggles } from './lsp'

const P = '/p/a.scss'

describe('css service', () => {
    it('completes properties and values', async () => {
        const text = '.a { col'
        const { doc, list } = await cssComplete(P, 'scss', text, text.length)
        const labels = toCompletionItems(doc, list).map(i => typeof i.label === 'string' ? i.label : i.label.label)
        expect(labels).toContain('color')
        const value = '.a { display: fl'
        const v = await cssComplete(P, 'css', value, value.length)
        expect(toCompletionItems(v.doc, v.list).map(i => i.label)).toContain('flex')
    })

    it('hovers a property', () => {
        const text = '.a { display: flex }'
        const { hover } = cssHover(P, 'css', text, text.indexOf('display') + 2)
        expect(JSON.stringify(hover?.contents)).toContain('display')
    })

    it('reports unknown properties and bad syntax', () => {
        const text = '.a { colour: red; }\n.b { color: }\n'
        const { doc, diagnostics } = cssValidate(P, 'css', text)
        const out = toSquiggles(doc, diagnostics, 'css')
        expect(out.some(d => text.slice(d.from, d.to) === 'colour' && d.severity === 'warning')).toBe(true)
    })

    it('finds a scss variable and mixin in the same file', () => {
        const text = '$gap: 4px;\n@mixin m { color: red }\n.a { margin: $gap; @include m; }\n'
        const use = text.indexOf('$gap;') + 1
        expect(cssDefinition(P, 'scss', text, use)).toMatchObject({ from: text.indexOf('$gap') })
        const inc = text.indexOf('m;')
        expect(cssDefinition(P, 'scss', text, inc)).toMatchObject({ from: text.indexOf('@mixin') })
    })

    it('links @import and @use to files', () => {
        const text = '@import "./b.css";\n@use "../c";\n'
        const links = cssLinks('/p/sub/a.scss', 'scss', text)
        expect(links.map(l => l.path)).toContain('/p/sub/b.css')
    })

    it('lists the selectors', () => {
        const names = cssSelectors(P, 'css', '.a { } #b .c { }').map(s => s.name)
        expect(names).toEqual(expect.arrayContaining(['.a']))
    })
})
