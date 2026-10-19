import { describe, expect, it } from 'vitest'
import { importedComponents, markupComplete, markupHover, markupLinks, regionAt, selectorAt, selectorNames, stylesheetLinks, tokenAt } from './html'
import { toCompletionItems } from './lsp'

const ctx = (lang: 'html' | 'vue' = 'html', extra = {}) => ({ path: '/p/src/a.html', cwd: '/p', lang, ...extra })
const labels = (items: { label: unknown }[]) => items.map(i => typeof i.label === 'string' ? i.label : (i.label as { label: string }).label)

describe('html service', () => {
    it('completes tags, attributes and values', async () => {
        let text = '<div><sec'
        let r = await markupComplete(ctx(), text, text.length)
        expect(labels(toCompletionItems(r.doc, r.list))).toContain('section')
        text = '<a hre'
        r = await markupComplete(ctx(), text, text.length)
        expect(labels(toCompletionItems(r.doc, r.list))).toContain('href')
        text = '<input type="che'
        r = await markupComplete(ctx(), text, text.length)
        expect(labels(toCompletionItems(r.doc, r.list))).toContain('checkbox')
    })

    it('hovers a tag', () => {
        const text = '<section>x</section>'
        expect(JSON.stringify(markupHover(ctx(), text, 3).hover?.contents)).toContain('section')
    })

    it('completes class names from the stylesheets', async () => {
        const text = '<div class="'
        const classes = { names: () => ({ class: ['card', 'card-title'], id: ['main'] }) }
        const r = await markupComplete(ctx('html', { classes }), text, text.length)
        expect(labels(r.list.items)).toEqual(expect.arrayContaining(['card', 'card-title']))
    })

    it('links src and href to files, and the page root is the project', () => {
        const text = '<link rel="stylesheet" href="./s.css"><script src="/src/main.ts"></script><img src="https://x/y.png">'
        const links = markupLinks(ctx(), text)
        expect(links.map(l => l.path).sort()).toEqual(['/p/src/main.ts', '/p/src/s.css'])
        expect(stylesheetLinks(ctx(), text)).toEqual(['/p/src/s.css'])
    })
})

describe('regions and tokens', () => {
    const SFC = '<template>\n  <Comp :a="b" @click="go">{{ msg }}</Comp>\n</template>\n<script setup lang="ts">\nimport Comp from "./Comp.vue"\nconst msg = 1\n</script>\n<style lang="scss">\n.a { color: red }\n</style>\n'
    it('tells markup from style and script blocks', () => {
        expect(regionAt(SFC, 'vue', SFC.indexOf('Comp :a'))).toEqual({ kind: 'markup' })
        expect(regionAt(SFC, 'vue', SFC.indexOf('const msg'))).toMatchObject({ kind: 'script', ts: true })
        expect(regionAt(SFC, 'vue', SFC.indexOf('color'))).toMatchObject({ kind: 'style', lang: 'scss' })
        expect(regionAt('<script type="text/template"><b></b></script>', 'html', 20)).toEqual({ kind: 'markup' })
    })

    it('finds the tag, class, id and expression under the pointer', () => {
        const page = '<div class="card big" id="main"></div>'
        expect(tokenAt(ctx(), page, page.indexOf('big') + 1)).toMatchObject({ kind: 'class', name: 'big' })
        expect(tokenAt(ctx(), page, page.indexOf('main') + 1)).toMatchObject({ kind: 'id', name: 'main' })
        expect(tokenAt(ctx(), page, 2)).toMatchObject({ kind: 'tag', name: 'div' })
        const vue = ctx('vue')
        expect(tokenAt(vue, SFC, SFC.indexOf('Comp :a') + 2)).toMatchObject({ kind: 'tag', name: 'Comp' })
        expect(tokenAt(vue, SFC, SFC.indexOf('msg }}') + 1)).toMatchObject({ kind: 'expression', name: 'msg' })
        expect(tokenAt(vue, SFC, SFC.indexOf('go"') + 1)).toMatchObject({ kind: 'expression', name: 'go' })
        expect(tokenAt(vue, '<i>{{ a.b }}</i>', 10)).toBeNull()
        expect(tokenAt(ctx('html'), '<i>{{ a }}</i>', 7)).toBeNull()
    })

    it('knows the components a script imports', () => {
        expect(importedComponents(SFC)).toMatchObject([{ name: 'Comp', spec: './Comp.vue' }])
    })

    it('completes vue directives, tags and imported components', async () => {
        const text = '<template><Co'
        const r = await markupComplete(ctx('vue'), `${text}\n</template><script setup>\nimport Comp from "./Comp.vue"\n</script>`, text.length)
        expect(labels(toCompletionItems(r.doc, r.list))).toContain('Comp')
        const attr = '<template><div v-'
        const a = await markupComplete(ctx('vue'), attr, attr.length)
        expect(labels(toCompletionItems(a.doc, a.list))).toEqual(expect.arrayContaining(['v-if', 'v-for']))
    })
})

describe('selectors', () => {
    const css = '/* .no { } */\n.card, .card-title { margin: 1.5em; color: #fff }\n#main > .big:hover { }\n@media (x) { .inner { } }\n'
    it('finds where a class or id starts', () => {
        expect(selectorAt(css, 'class', 'card')).toBe(css.indexOf('.card,'))
        expect(selectorAt(css, 'class', 'card-title')).toBe(css.indexOf('.card-title'))
        expect(selectorAt(css, 'class', 'big')).toBe(css.indexOf('.big'))
        expect(selectorAt(css, 'class', 'inner')).toBe(css.indexOf('.inner'))
        expect(selectorAt(css, 'id', 'main')).toBe(css.indexOf('#main'))
        expect(selectorAt(css, 'class', 'ca')).toBeNull()
        expect(selectorAt(css, 'class', '5em')).toBeNull()
    })

    it('lists the names a stylesheet defines, and not values or comments', () => {
        expect(selectorNames(css)).toEqual({ class: ['big', 'card', 'card-title', 'inner'], id: ['main'] })
    })
})
