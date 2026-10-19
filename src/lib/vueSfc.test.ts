import { describe, expect, it } from 'vitest'
import { blank, blocks, intoComponent, vueScript, vueTail } from './vueSfc'

const SFC = '<template>\n  <div :a="b > c">{{ x }}</div>\n</template>\n\n<script setup lang="ts" generic="T extends Array<string>">\nconst x: T = []\n</script>\n\n<style scoped lang="scss">\n.a { color: red }\n</style>\n'

describe('blocks', () => {
    it('finds script and style blocks with their content, language and flags', () => {
        const found = blocks(SFC)
        expect(found.map(b => b.tag)).toEqual(['script', 'style'])
        const [script, style] = found
        expect(SFC.slice(script.from, script.to)).toBe('\nconst x: T = []\n')
        expect(script).toMatchObject({ lang: 'ts', setup: true, src: null })
        expect(style).toMatchObject({ lang: 'scss', scoped: true })
        expect(SFC.slice(style.from, style.to)).toContain('.a { color: red }')
    })

    it('skips what is in a comment, and a block that has a src', () => {
        const text = '<!-- <script>nope</script> -->\n<script src="./a.ts"></script>\n<script>\nlet y = 1\n</script>'
        const found = blocks(text)
        expect(found.length).toBe(2)
        expect(found[0].src).toBe('./a.ts')
        expect(text.slice(found[1].from, found[1].to)).toBe('\nlet y = 1\n')
    })
})

describe('vueScript', () => {
    it('keeps the script where it is and blanks the rest, line for line', () => {
        const { code, ts, ranges } = vueScript(SFC)
        expect(ts).toBe(true)
        expect(ranges.length).toBe(1)
        const own = code.slice(0, SFC.length)
        expect(own.split('\n').map(l => l.length)).toEqual(SFC.split('\n').map(l => l.length))
        expect(own).toContain('const x: T = []')
        expect(own).not.toContain('template')
        expect(own).not.toContain('color')
        expect(vueTail(code)).toEqual({ end: SFC.length, ts: true })
    })

    it('adds the macros for script setup and a default export when there is none', () => {
        expect(vueScript(SFC).code).toContain('declare function defineProps')
        expect(vueScript(SFC).code).toContain('export default {}')
        const own = vueScript('<script>\nexport default { name: "a" }\n</script>\n').code
        expect(own).not.toContain('export default {} as')
        expect(own).not.toContain('declare function defineProps')
    })

    it('reads a template-only component, and marks plain JavaScript', () => {
        expect(vueScript('<template><i/></template>').code).toContain('export default {}')
        expect(vueScript('<script>\nlet a = 1\n</script>').ts).toBe(false)
        expect(vueTail(vueScript('<script>\nlet a = 1\n</script>').code)?.ts).toBe(false)
        expect(vueTail('const a = 1')).toBeNull()
    })
})

describe('intoComponent', () => {
    it('puts a change in the script back into the component', () => {
        const was = vueScript(SFC).code
        const now = was.replace('const x: T = []', 'const y: T = []')
        expect(intoComponent(SFC, was, now)).toBe(SFC.replace('const x: T = []', 'const y: T = []'))
        // a longer one too
        const longer = was.replace('const x: T = []', 'const renamed: T = []')
        expect(intoComponent(SFC, was, longer)).toBe(SFC.replace('const x: T = []', 'const renamed: T = []'))
    })

    it('refuses a change outside the script, and several scripts', () => {
        const was = vueScript(SFC).code
        expect(intoComponent(SFC, was, was.replace('  ', 'x '))).toBeNull()
        const two = '<script>\nexport default {}\n</script>\n<script setup>\nlet a = 1\n</script>\n'
        const w2 = vueScript(two).code
        expect(intoComponent(two, w2, w2.replace('let a', 'let b'))).toBeNull()
    })
})

describe('blank', () => {
    it('keeps line breaks', () => {
        expect(blank('ab\ncd', [{ from: 3, to: 4 }])).toBe('  \nc ')
    })
})
