import type { FileTab } from '@/store/fileTab'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path/posix'
import { clearTSServiceCache, setTsLibLoader } from 'lite-monaco'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { nodeProjectFs } from '../../../test/projectFs'
import { appStore } from '@/store/app'
import { codeIntel } from '@/store/codeIntel'
import { slashed } from '../tsProject'
import { useWebFs } from './fsys'
import { embeddedLink, webKit } from './session'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const root = slashed(realpathSync(mkdtempSync(`${tmpdir()}/web-session-`)))
const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
}
const at = (rel: string) => join(root, rel)
const tabOf = (rel: string) => ({ path: at(rel), cwd: root, name: rel, state: null }) as unknown as FileTab
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const COMP = '<template><div class="box">{{ label }}</div></template>\n<script setup lang="ts">\nconst label: string = "x"\nconst wrong: number = "no"\n</script>\n<style scoped>\n.box { colour: red }\n</style>\n'
const APP = '<template>\n  <section class="card" :class="extra">\n    <Comp :n="1" @click="go" />{{ title }}\n  </section>\n</template>\n\n<script setup lang="ts">\nimport Comp from "./Comp.vue"\nimport "./theme.scss"\nconst title = "t"\nfunction go() {}\nconst extra = Comp\n</script>\n\n<style lang="scss">\n$gap: 4px;\n.card { margin: $gap; }\n</style>\n'
const PAGE = '<!doctype html>\n<html><head><link rel="stylesheet" href="./site.css"><style>.local { color: red }</style></head>\n<body class="hero local" id="top"><script src="/src/main.ts"></script><script>\nconst n = 1\nn.toFix\n</script></body></html>\n'

beforeAll(() => {
    const libs = join(process.cwd(), 'node_modules/typescript/lib')
    setTsLibLoader(async () => new Map(readdirSync(libs).filter(f => /^lib\..*\.d\.ts$/.test(f)).map(f => [f, readFileSync(join(libs, f), 'utf8')] as const)))
    useWebFs({
        read: async (p) => {
            try {
                return readFileSync(p, 'utf8')
            }
            catch {
                return null
            }
        },
        list: async (d) => {
            try {
                return readdirSync(d, { withFileTypes: true }).map(e => ({ name: e.name, dir: e.isDirectory() }))
            }
            catch {
                return null
            }
        },
    })
    vi.stubGlobal('window', {
        addEventListener: () => {},
        pi: {
            ...nodeProjectFs,
            readFile: nodeProjectFs.read,
            projectSources: nodeProjectFs.sources,
            projectConfigs: nodeProjectFs.configs,
            listDir: async (dir: string) => ({ entries: (await nodeProjectFs.folders(dir)).map(name => ({ name, dir: true })) }),
        },
    })
    appStore.editorIntel = 'standard'
    put('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' }, include: ['src'] }))
    put('src/Comp.vue', COMP)
    put('src/App.vue', APP)
    put('src/theme.scss', '$brand: red;\n.card { color: $brand }\n')
    put('src/main.ts', 'import App from "./App.vue"\nexport const a: number = App\n')
    put('site.css', '.hero { margin: 0 }\n#top { color: blue }\n')
    put('index.html', PAGE)
    put('style.css', '@import "./other.css";\n:root { --gap: 4px }\n.a { margin: var(--gap); colour: red }\n')
    put('other.css', '.o{}')
})
afterAll(() => {
    codeIntel.closeProject(root)
    clearTSServiceCache()
    vi.unstubAllGlobals()
    rmSync(root, { recursive: true, force: true })
})

const labels = (items: { label: unknown }[]) => items.map(i => typeof i.label === 'string' ? i.label : (i.label as { label: string }).label)

describe('a stylesheet', () => {
    it('jumps to an imported file and to a custom property, and reports an unknown property', async () => {
        const text = readFileSync(at('style.css'), 'utf8')
        const kit = webKit(tabOf('style.css'), 'css', null)!
        await new Promise<void>((resolve) => {
            const stop = kit.start({ state: { doc: { toString: () => text }, field: () => [], update: () => ({}) }, onTransaction: () => () => {}, update: () => ({}), dispatch: () => resolve() } as never)
            setTimeout(() => {
                stop()
                resolve()
            }, 300)
        })
        const imp = kit.resolve(text, text.indexOf('other') + 2)
        expect(imp?.to.path).toBe(at('other.css'))
        expect(text.slice(imp!.span.from, imp!.span.to)).toBe('./other.css')
        const use = kit.resolve(text, text.indexOf('--gap)') + 3)
        expect(use?.to).toMatchObject({ path: at('style.css'), line: 2 })
        expect(kit.resolve(text, text.indexOf('margin') + 2)).toBeNull()
        const found = await kit.diagnose(text)
        expect(found.map(d => text.slice(d.from, d.to))).toContain('colour')
        const done = await kit.complete('.a { disp', 9)
        expect(labels(done.items)).toContain('display')
    })
})

describe('an html page', () => {
    it('jumps from a class to the rule in a linked stylesheet and in its own style block, and from a link to a file', async () => {
        const kit = webKit(tabOf('index.html'), 'html', null)!
        const stop = kit.start({ state: { doc: { toString: () => PAGE }, field: () => [], update: () => ({}) }, onTransaction: () => () => {}, dispatch: () => {} } as never)
        await wait(300)
        const hero = kit.resolve(PAGE, PAGE.indexOf('hero') + 1)
        expect(hero?.to).toMatchObject({ path: at('site.css'), line: 1, col: 1 })
        expect(PAGE.slice(hero!.span.from, hero!.span.to)).toBe('hero')
        const local = kit.resolve(PAGE, PAGE.indexOf('local"') + 1)
        expect(local?.to).toMatchObject({ path: at('index.html'), line: 2 })
        expect(kit.resolve(PAGE, PAGE.indexOf('top"') + 1)?.to).toMatchObject({ path: at('site.css'), line: 2 })
        expect(kit.resolve(PAGE, PAGE.indexOf('./site.css') + 3)?.to.path).toBe(at('site.css'))
        expect(kit.resolve(PAGE, PAGE.indexOf('/src/main.ts') + 3)?.to.path).toBe(at('src/main.ts'))
        // class names come from the sheets
        const page = PAGE.replace('<body class="hero local"', '<body class="he"')
        const inClass = await kit.complete(page, page.indexOf('he"') + 2)
        expect(labels(inClass.items)).toEqual(expect.arrayContaining(['hero', 'local']))
        stop()
    })

    it('completes inside a style block with the CSS service', async () => {
        const kit = webKit(tabOf('index.html'), 'html', null)!
        const page = '<style>\n.a { disp }\n</style>'
        const r = await kit.complete(page, page.indexOf('disp') + 4)
        expect(labels(r.items)).toContain('display')
    })
})

describe('a Vue component', () => {
    it('jumps from a tag to its file, from a name in the template to its declaration, and from a class to its rule', async () => {
        const kit = webKit(tabOf('src/App.vue'), 'vue', null)!
        const link = await embeddedLink(tabOf('src/App.vue'), 'vue', 'standard', APP)
        const stop = kit.start({ state: { doc: { toString: () => APP }, field: () => [], update: () => ({}) }, onTransaction: () => () => {}, dispatch: () => {} } as never)
        await wait(500)
        const tag = kit.resolve(APP, APP.indexOf('<Comp') + 2)
        expect(tag?.to).toMatchObject({ path: at('src/Comp.vue'), line: 1, col: 1 })
        const title = kit.resolve(APP, APP.indexOf('title }}') + 2)
        expect(title?.to).toMatchObject({ path: at('src/App.vue'), line: 10 })
        const handler = kit.resolve(APP, APP.indexOf('go"') + 1)
        expect(handler?.to).toMatchObject({ path: at('src/App.vue'), line: 11 })
        const card = kit.resolve(APP, APP.indexOf('card"') + 1)
        expect(card?.to).toMatchObject({ path: at('src/App.vue'), line: 17 })
        // in the script: an import leads to the component, a name to its declaration here, a stylesheet import to the file
        expect(kit.resolve(APP, APP.indexOf('./Comp.vue') + 3)?.to).toMatchObject({ path: at('src/Comp.vue') })
        expect(kit.resolve(APP, APP.indexOf('Comp\n')  + 1)?.to).toBeTruthy()
        expect(kit.resolve(APP, APP.indexOf('"./theme.scss"') + 3)?.to.path).toBe(at('src/theme.scss'))
        // in the style: a variable of the same block
        expect(kit.resolve(APP, APP.indexOf('$gap; }') + 2)?.to).toMatchObject({ path: at('src/App.vue'), line: 16 })
        stop()
        link?.release()
    })

    it('reports an unknown CSS property in the style block and a type error in the script, and nothing else', async () => {
        const tab = tabOf('src/Comp.vue')
        const link = await embeddedLink(tab, 'vue', 'standard', COMP)
        const kit = webKit(tab, 'vue', link)!
        const found = await kit.diagnose(COMP)
        const words = found.map(d => `${d.source}:${COMP.slice(d.from, d.to)}`).sort()
        expect(words).toEqual(['css:colour', 'vue-ts:wrong'])
        link?.release()
    })

    it('completes tags, directives, imported components, and script names', async () => {
        const kit = webKit(tabOf('src/App.vue'), 'vue', null)!
        const link = await embeddedLink(tabOf('src/App.vue'), 'vue', 'standard', APP)
        const tags = await kit.complete(APP.replace('<Comp :n', '<Co :n'), APP.indexOf('<Comp') + 3)
        expect(labels(tags.items)).toContain('Comp')
        const directive = await kit.complete(APP.replace('<section class', '<section v- class'), APP.indexOf('<section') + 12)
        expect(labels(directive.items)).toContain('v-if')
        const script = APP.replace('const extra = Comp', 'const extra = tit')
        const names = await kit.complete(script, script.indexOf('= tit') + 5)
        expect(labels(names.items)).toContain('title')
        link?.release()
    })
})

describe('the components other files import', () => {
    it('are typed by their script, in the project', async () => {
        const link = await codeIntel.attach(tabOf('src/main.ts'), 'typescript', 'standard', readFileSync(at('src/main.ts'), 'utf8'))
        const found = await link.check({ fileName: `/${at('src/main.ts').replace(/^\//, '')}`, text: readFileSync(at('src/main.ts'), 'utf8'), mode: 'full', wantTags: false, options: {} })
        // not "cannot find module": the component was found (vue itself is not installed here, so its type is any)
        expect(found?.diagnostics.some(d => d.message?.includes('Cannot find module \'./App.vue\''))).toBe(false)
        link.release()
    })
})
