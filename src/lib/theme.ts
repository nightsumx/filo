// Appearance. The main process owns the preference through nativeTheme.themeSource, which also
// drives `prefers-color-scheme` here, so "system" needs no extra wiring: this module only mirrors
// the resolved scheme onto <html class="dark"> and swaps the third-party stylesheets that ship
// separate light/dark files.
import mdDark from 'github-markdown-css/github-markdown-dark.css?inline'
import mdLight from 'github-markdown-css/github-markdown-light.css?inline'
import hljsDark from 'highlight.js/styles/github-dark.css?inline'
import hljsLight from 'highlight.js/styles/github.css?inline'
import { makeAutoObservable } from 'mobx'

const query = window.matchMedia('(prefers-color-scheme: dark)')

class ThemeState {
    /** Resolved scheme currently on screen. */
    dark = query.matches

    constructor() {
        makeAutoObservable(this)
    }

    set(dark: boolean) {
        this.dark = dark
    }
}

export const theme = new ThemeState()

let vendorStyle: HTMLStyleElement | null = null

function apply(dark: boolean) {
    theme.set(dark)
    document.documentElement.classList.toggle('dark', dark)
    if (!vendorStyle) {
        vendorStyle = document.createElement('style')
        vendorStyle.dataset.theme = 'vendor'
        // First in <head> so app CSS (index.css) still overrides these sheets.
        document.head.prepend(vendorStyle)
    }
    vendorStyle.textContent = dark ? `${mdDark}\n${hljsDark}` : `${mdLight}\n${hljsLight}`
}

/** Call once before the first render. */
export function initTheme() {
    apply(query.matches)
    query.addEventListener('change', e => apply(e.matches))
}
