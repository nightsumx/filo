// One xterm.js instance per terminal, kept outside React: switching tabs or projects moves its element
// in and out of the panel instead of rebuilding it, so scrollback, selection and the WebGL renderer
// survive. A view attaches to main once, gets the screen so far as a snapshot, and from then on the
// output chunks numbered after it.
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ITheme } from '@xterm/xterm'
import { Terminal } from '@xterm/xterm'
import { theme } from '@/lib/theme'
import { reaction } from 'mobx'

const api = () => window.pi

const FONT = '"JetBrains Mono Variable", "JetBrains Mono", Menlo, "PingFang SC", monospace'
// Glyph metrics are measured when a terminal opens; with the web font still loading it would measure
// the fallback and keep the wrong cell size.
const fontReady = document.fonts.load(`13px "JetBrains Mono Variable"`).catch(() => [])

/** ANSI colours tuned for the IDE backgrounds; the background itself is the panel's (--ide-panel). */
const PALETTES: Record<'dark' | 'light', ITheme> = {
    dark: {
        foreground: '#bcbec4',
        cursor: '#ced0d6',
        cursorAccent: '#191a1c',
        selectionBackground: '#2e436e',
        selectionInactiveBackground: '#33353a',
        black: '#2b2d30',
        red: '#f0524f',
        green: '#5fb35f',
        yellow: '#d6a83a',
        blue: '#4a8fe7',
        magenta: '#b07cd8',
        cyan: '#2fb3b3',
        white: '#bcbec4',
        brightBlack: '#6f737a',
        brightRed: '#ff6b68',
        brightGreen: '#7fd47f',
        brightYellow: '#f2c55c',
        brightBlue: '#6fa8ff',
        brightMagenta: '#d39cf5',
        brightCyan: '#5fd7d7',
        brightWhite: '#ffffff',
    },
    light: {
        foreground: '#1d1d1f',
        cursor: '#1d1d1f',
        cursorAccent: '#ffffff',
        selectionBackground: '#b3d7ff',
        selectionInactiveBackground: '#e1e1e6',
        black: '#1d1d1f',
        red: '#c4312d',
        green: '#2b8a3e',
        yellow: '#9a6b00',
        blue: '#0b5cad',
        magenta: '#9c36b5',
        cyan: '#0b7f8c',
        white: '#6e6e73',
        brightBlack: '#86868b',
        brightRed: '#e03e3a',
        brightGreen: '#37a14b',
        brightYellow: '#b5830a',
        brightBlue: '#0071e3',
        brightMagenta: '#b44ad1',
        brightCyan: '#1597a6',
        brightWhite: '#aeaeb2',
    },
}

function xtermTheme(): ITheme {
    const background = getComputedStyle(document.documentElement).getPropertyValue('--ide-panel').trim()
    return { ...PALETTES[theme.dark ? 'dark' : 'light'], background }
}

/** Shortcuts the app handles even while a terminal has focus; xterm would swallow them otherwise. */
function appShortcut(e: KeyboardEvent) {
    if (e.ctrlKey && !e.metaKey && (e.key === 'Tab' || e.code === 'Backquote'))
        return true
    // ⌘ combos never mean anything to the shell; copy and paste come through the Edit menu.
    return e.metaKey && !['ArrowLeft', 'ArrowRight', 'Backspace'].includes(e.key)
}

/** macOS text-field motions, translated to what line editors (zsh, bash, fish) understand. */
const MOTIONS: Record<string, string> = {
    'Meta+ArrowLeft': '\x01',
    'Meta+ArrowRight': '\x05',
    'Meta+Backspace': '\x15',
    'Alt+ArrowLeft': '\x1Bb',
    'Alt+ArrowRight': '\x1Bf',
    'Alt+Backspace': '\x17',
}

export class TermView {
    readonly term: Terminal
    readonly element = document.createElement('div')
    private fitter = new FitAddon()
    private webgl: WebglAddon | null = null
    private opened = false
    /** Seq of the snapshot; null until it arrived (chunks wait in `queued` meanwhile). */
    private seq: number | null = null
    private queued: [number, string][] = []
    private attaching = false
    private disposed = false

    constructor(readonly id: string) {
        this.element.className = 'h-full w-full'
        this.term = new Terminal({
            fontFamily: FONT,
            fontSize: 12.5,
            lineHeight: 1.2,
            scrollback: 10_000,
            cursorBlink: true,
            allowProposedApi: true,
            macOptionClickForcesSelection: true,
            // Keeps output that picks dim colours readable on either background.
            minimumContrastRatio: 4.5,
            theme: xtermTheme(),
        })
        this.term.loadAddon(this.fitter)
        this.term.loadAddon(new WebLinksAddon((event, uri) => {
            event.preventDefault()
            void api().openExternal(uri)
        }))
        this.term.onData(data => api().terminalWrite(id, data))
        this.term.onBinary(data => api().terminalWrite(id, data))
        this.term.onResize(({ cols, rows }) => api().terminalResize(id, cols, rows))
        this.term.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown')
                return !appShortcut(e)
            const motion = MOTIONS[`${e.metaKey ? 'Meta+' : e.altKey ? 'Alt+' : ''}${e.key}`]
            if (motion && !e.shiftKey && !e.ctrlKey) {
                e.preventDefault()
                api().terminalWrite(id, motion)
                return false
            }
            return !appShortcut(e)
        })
    }

    /** Shows the view in `host`; the first time, opens xterm there and attaches to main. */
    mount(host: HTMLElement) {
        if (this.element.parentElement !== host)
            host.appendChild(this.element)
        if (!this.opened) {
            this.opened = true
            this.term.open(this.element)
            this.loadWebgl()
            void fontReady.then(() => {
                if (this.disposed)
                    return
                // Setting the font again re-measures the cells with the loaded face.
                this.term.options.fontFamily = FONT
                this.fit()
            })
        }
        this.fit()
        void this.attach()
    }

    unmount() {
        this.element.remove()
    }

    private loadWebgl() {
        try {
            const webgl = new WebglAddon()
            // A browser caps live WebGL contexts; one that is taken back falls back to the DOM renderer.
            webgl.onContextLoss(() => {
                webgl.dispose()
                this.webgl = null
            })
            this.term.loadAddon(webgl)
            this.webgl = webgl
        }
        catch {
            this.webgl = null
        }
    }

    fit() {
        if (!this.element.isConnected || !this.element.clientHeight)
            return
        try {
            this.fitter.fit()
        }
        catch {}
    }

    get size() {
        return { cols: this.term.cols, rows: this.term.rows }
    }

    private async attach() {
        if (this.attaching || this.seq !== null)
            return
        this.attaching = true
        // Main's terminal takes this view's size first, so the snapshot is laid out for it.
        api().terminalResize(this.id, this.term.cols, this.term.rows)
        try {
            const snapshot = await api().terminalAttach(this.id)
            if (this.disposed)
                return
            this.term.write(snapshot.data)
            this.seq = snapshot.seq
            for (const [seq, data] of this.queued) {
                if (seq > snapshot.seq)
                    this.term.write(data)
            }
            this.queued = []
        }
        catch {
            // The terminal is gone; the list update removes this view.
        }
        finally {
            this.attaching = false
        }
    }

    receive(seq: number, data: string) {
        if (this.seq === null)
            this.queued.push([seq, data])
        else if (seq > this.seq)
            this.term.write(data)
    }

    focus() {
        this.term.focus()
    }

    get focused() {
        return this.element.contains(document.activeElement)
    }

    /** Selection, else everything on screen and in scrollback. */
    async text(): Promise<string> {
        return this.term.hasSelection() ? this.term.getSelection() : api().terminalText(this.id, 400)
    }

    applyTheme() {
        this.term.options.theme = xtermTheme()
    }

    dispose() {
        this.disposed = true
        api().terminalDetach(this.id)
        this.webgl?.dispose()
        this.term.dispose()
        this.element.remove()
    }
}

const views = new Map<string, TermView>()

api().onTerminalData((id, seq, data) => views.get(id)?.receive(seq, data))
// Colours follow the appearance; --ide-panel changes with it, so read it after the class flips.
reaction(() => theme.dark, () => requestAnimationFrame(() => views.forEach(v => v.applyTheme())))

export function viewOf(id: string): TermView {
    let view = views.get(id)
    if (!view) {
        view = new TermView(id)
        views.set(id, view)
    }
    return view
}

export function existingView(id: string): TermView | undefined {
    return views.get(id)
}

/** Drops the views of terminals that ended or whose project left this window. */
export function pruneViews(keep: (id: string) => boolean) {
    for (const [id, view] of views) {
        if (!keep(id)) {
            view.dispose()
            views.delete(id)
        }
    }
}
