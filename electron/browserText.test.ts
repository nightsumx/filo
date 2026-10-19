import type { AxNode } from './browserText'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { allowedScheme, consoleLevel, formatConsole, parseAddress, parseKey, renderOutline } from './browserText'

describe('parseAddress', () => {
    it('gives local hosts http and the rest https', () => {
        expect(parseAddress('localhost:3000')).toBe('http://localhost:3000/')
        expect(parseAddress('127.0.0.1:8080/x?y=1')).toBe('http://127.0.0.1:8080/x?y=1')
        expect(parseAddress('192.168.1.5')).toBe('http://192.168.1.5/')
        expect(parseAddress('example.com/a')).toBe('https://example.com/a')
        expect(parseAddress('http://example.com')).toBe('http://example.com/')
    })

    it('opens file paths as file URLs', () => {
        // On Windows a rooted path gets its drive, as the platform's own conversion does.
        expect(parseAddress('/tmp/site/index.html')).toBe(pathToFileURL('/tmp/site/index.html').href)
        expect(parseAddress('file:///tmp/a%20b.html')).toBe('file:///tmp/a%20b.html')
    })

    it('refuses schemes that run code or open other apps', () => {
        for (const bad of ['javascript:alert(1)', 'chrome://settings', 'mailto:a@b.c', 'slack://open', 'data:text/html,hi', 'about:config', 'devtools://x'])
            expect(() => parseAddress(bad), bad).toThrow(/not /)
    })

    it('searches for text that is no address only when asked to', () => {
        expect(parseAddress('how to center a div', true)).toBe('https://duckduckgo.com/?q=how%20to%20center%20a%20div')
        expect(parseAddress('react', true)).toContain('duckduckgo.com/?q=react')
        expect(() => parseAddress('react')).toThrow(/not an address/)
        expect(() => parseAddress('  ')).toThrow(/empty/)
    })

    it('keeps about:blank', () => {
        expect(parseAddress('about:blank')).toBe('about:blank')
        expect(allowedScheme('about:blank')).toBe(true)
        expect(allowedScheme('about:srcdoc')).toBe(false)
        expect(allowedScheme('javascript:1')).toBe(false)
        expect(allowedScheme('https://a.b')).toBe(true)
    })
})

describe('parseKey', () => {
    it('names keys the way a person writes them', () => {
        expect(parseKey('Enter', true)).toMatchObject({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r' })
        expect(parseKey('escape', true)).toMatchObject({ key: 'Escape', windowsVirtualKeyCode: 27 })
        expect(parseKey('ArrowDown', true).text).toBeUndefined()
        expect(parseKey('F5', true).windowsVirtualKeyCode).toBe(116)
        expect(parseKey('a', true)).toMatchObject({ key: 'a', code: 'KeyA', text: 'a' })
        expect(parseKey('Shift+a', true)).toMatchObject({ key: 'A', modifiers: 8, text: 'A' })
        expect(parseKey('5', true)).toMatchObject({ code: 'Digit5', windowsVirtualKeyCode: 53 })
    })

    it('shortcuts type nothing and carry the editing command', () => {
        expect(parseKey('Meta+A', true)).toMatchObject({ modifiers: 4, commands: ['selectAll'] })
        expect(parseKey('Control+a', false).text).toBeUndefined()
        expect(parseKey('ControlOrMeta+C', true).modifiers).toBe(4)
        expect(parseKey('ControlOrMeta+C', false).modifiers).toBe(2)
        expect(parseKey('Meta+Shift+Z', true).commands).toEqual(['redo'])
        expect(parseKey('Control+Enter', true).text).toBeUndefined()
    })

    it('accepts + as the key', () => {
        expect(parseKey('+', true).key).toBe('+')
        expect(parseKey('Control++', true)).toMatchObject({ key: '+', modifiers: 2 })
    })

    it('says what is wrong', () => {
        expect(() => parseKey('Hyper+a', true)).toThrow(/unknown modifier "Hyper"/)
        expect(() => parseKey('Foo', true)).toThrow(/unknown key "Foo"/)
        expect(() => parseKey('', true)).toThrow(/empty/)
    })
})

const text = (value: unknown) => ({ value })
let nextId = 0
/** One node of the accessibility tree; the page below links them the way CDP's flat list does. */
function node(role: string, name: string, extra: { value?: string, props?: Record<string, unknown>, ignored?: true } = {}): AxNode {
    const id = String(++nextId)
    return {
        nodeId: id,
        role: text(role),
        name: text(name),
        ...(extra.value !== undefined ? { value: text(extra.value) } : {}),
        backendDOMNodeId: 100 + Number(id),
        childIds: [],
        properties: Object.entries(extra.props ?? {}).map(([k, v]) => ({ name: k, value: text(v) })),
        ...(extra.ignored ? { ignored: true } : {}),
    }
}
function adopt(parent: AxNode, ...kids: AxNode[]) {
    parent.childIds = kids.map(k => k.nodeId)
    for (const k of kids)
        k.parentId = parent.nodeId
}

function page(): AxNode[] {
    nextId = 0
    const heading = node('heading', 'Hello', { props: { level: 1 } })
    const headingText = node('StaticText', 'Hello')
    adopt(heading, headingText)
    const label = node('LabelText', '')
    const labelText = node('StaticText', 'Email ')
    adopt(label, labelText)
    const email = node('textbox', 'Email ', { value: 'a@b.c', props: { focusable: true } })
    const signIn = node('button', 'Sign in', { props: { focusable: true } })
    const signInText = node('StaticText', 'Sign in')
    adopt(signIn, signInText)
    const link = node('link', 'Docs', { props: { focusable: true, url: 'http://x.test/two' } })
    const wrapper = node('generic', '')
    const welcome = node('StaticText', 'Welcome back to the site')
    adopt(wrapper, welcome)
    const remember = node('checkbox', 'Remember me', { props: { checked: false, focusable: true } })
    const color = node('combobox', 'Color', { value: 'red', props: { focusable: true } })
    const popup = node('MenuListPopup', '')
    const red = node('MenuListOption', 'red', { props: { selected: true } })
    const blue = node('MenuListOption', 'blue', { props: { selected: false } })
    adopt(popup, red, blue)
    adopt(color, popup)
    const hidden = node('generic', '', { ignored: true })
    const inside = node('button', 'Inside ignored', { props: { focusable: true } })
    adopt(hidden, inside)
    const root = node('RootWebArea', 'Spike', { props: { focusable: true } })
    adopt(root, heading, label, email, signIn, link, wrapper, remember, color, hidden)
    return [root, heading, headingText, label, labelText, email, signIn, signInText, link, wrapper, welcome, remember, color, popup, red, blue, hidden, inside]
}

describe('renderOutline', () => {
    const refs = new Map<number, string>()
    const refOf = (id: number) => {
        if (!refs.has(id))
            refs.set(id, `e${refs.size + 1}`)
        return refs.get(id)!
    }

    it('keeps a control that sits inside its <label>, without repeating the label text', () => {
        nextId = 0
        const label = node('LabelText', '')
        const labelText = node('StaticText', 'Name ')
        const input = node('textbox', 'Name', { props: { focusable: true } })
        adopt(label, labelText, input)
        const root = node('RootWebArea', 'T')
        adopt(root, label)
        expect(renderOutline([root, label, labelText, input], { refOf: () => 'e1' }).text).toBe('- textbox "Name" [ref=e1]')
    })

    it('lists what a person would name, with refs on what can be acted on', () => {
        const { text: outline, truncated, refs: count } = renderOutline(page(), { refOf })
        expect(outline.split('\n')).toEqual([
            '- heading "Hello" [level=1]',
            '- textbox "Email" value="a@b.c" [ref=e1]',
            '- button "Sign in" [ref=e2]',
            '- link "Docs" href="http://x.test/two" [ref=e3]',
            '- text: "Welcome back to the site"',
            '- checkbox "Remember me" [checked=false] [ref=e4]',
            '- combobox "Color" value="red" [ref=e5]',
            '  - option "red" [selected] [ref=e6]',
            '  - option "blue" [selected=false] [ref=e7]',
            '- button "Inside ignored" [ref=e8]',
        ])
        expect(truncated).toBe(false)
        expect(count).toBe(8)
    })

    it('keeps a node\'s ref from one snapshot to the next', () => {
        const a = renderOutline(page(), { refOf }).text
        const b = renderOutline(page(), { refOf }).text
        expect(b).toBe(a)
    })

    it('can start at a node, and cuts long pages', () => {
        const nodes = page()
        const form = renderOutline(nodes, { refOf, from: nodes.find(n => n.name?.value === 'Color')!.backendDOMNodeId })
        expect(form.text.split('\n')[0]).toMatch(/^- combobox "Color"/)
        expect(form.text).not.toContain('Sign in')
        const cut = renderOutline(nodes, { refOf, limit: 90 })
        expect(cut.truncated).toBe(true)
        expect(cut.text.length).toBeLessThanOrEqual(90)
    })
})

describe('console', () => {
    it('maps levels and flattens lines', () => {
        expect(consoleLevel('warning')).toBe('warn')
        expect(consoleLevel('verbose')).toBe('log')
        expect(formatConsole([{ level: 'error', text: 'Uncaught TypeError\n  at x', source: 'app.js:3' }])).toBe('[error] Uncaught TypeError ⏎   at x (app.js:3)')
    })
})
