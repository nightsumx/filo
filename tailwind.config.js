import typography from '@tailwindcss/typography'
import tailwindcssAnimate from 'tailwindcss-animate'
import defaults from 'tailwindcss/colors'
import plugin from 'tailwindcss/plugin'

/*
 * Dark theme without touching every className: white, black, gray and the accent hues resolve to CSS
 * variables. Light keeps Tailwind's own values; under `.dark` the scales flip (50 <-> 950, 500 stays),
 * so `bg-white` becomes the dark surface, `bg-black/5` a light overlay and `text-gray-400` stays muted.
 * Use `always-white` / `always-black` for colours that must not flip (text on blue buttons, scrims).
 */
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const HUES = ['red', 'orange', 'amber', 'yellow', 'green', 'emerald', 'blue']
const rgb = hex => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)).join(' ')
const gray = v => `${v} ${v} ${v}`
/** JetBrains "Islands" dark neutrals (slightly cool), lightest last; tuned against the #1e1f22 editor. */
const DARK_GRAY = { 50: '34 35 39', 100: '43 45 48', 200: '57 59 64', 300: '78 81 87', 400: '111 115 122', 500: '134 138 145', 600: '157 161 168', 700: '180 184 191', 800: '206 208 214', 900: '223 225 229', 950: '240 241 242' }
/**
 * Light neutrals, pure grey like the Codex app's (its gray-50 #f9f9f9, ink #0d0d0d). Each step keeps
 * the OKLab lightness of the JetBrains Int UI Light scale it replaced, so contrast between steps is
 * unchanged and 500 / 700 sit next to Codex's tertiary (#878787) and secondary (#575757) text.
 * 900 / 950 are Codex's ink (#0d0d0d) and black.
 */
const LIGHT_GRAY = { 50: '248 248 248', 100: '236 236 236', 200: '225 225 225', 300: '204 204 204', 400: '164 164 164', 500: '134 134 134', 600: '112 112 112', 700: '84 84 84', 800: '57 57 57', 900: '13 13 13', 950: '0 0 0' }
const SURFACE = { light: { 'white': '255 255 255', 'black': '0 0 0', 'elevated': '255 255 255' }, dark: { 'white': '30 31 34', 'black': '255 255 255', 'elevated': '43 45 48' } }

/*
 * White shows a hue at full strength; a dark surface swallows part of it. Tailwind's hues are tuned
 * for white pages, so next to the muted JetBrains neutrals they shout (red-500 status text, emerald
 * diff rows). The light theme keeps each shade's OKLCH lightness and hue and scales its chroma by
 * LIGHT_CHROMA; dark keeps Tailwind's values, which already read calm there.
 */
const LIGHT_CHROMA = 0.78
const toLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
/** sRGB hex → OKLab with a and b scaled by k (chroma × k) → "r g b" (Björn Ottosson's OKLab matrices). */
const damp = (hex, k) => {
    const [r, g, b] = [1, 3, 5].map(i => toLinear(Number.parseInt(hex.slice(i, i + 2), 16) / 255))
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    const A = (1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s) * k
    const B = (0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s) * k
    const l3 = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
    const m3 = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
    const s3 = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3
    return [
        4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
        -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
        -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
    ].map(c => Math.round(Math.min(1, Math.max(0, toGamma(c))) * 255)).join(' ')
}

const scale = name => Object.fromEntries(SHADES.map(s => [s, `rgb(var(--${name}-${s}) / <alpha-value>)`]))
const paletteVars = (dark) => {
    const vars = {}
    for (const hue of [...HUES, 'gray']) {
        for (const [i, s] of SHADES.entries()) {
            vars[`--${hue}-${s}`] = hue === 'gray'
                ? (dark ? DARK_GRAY : LIGHT_GRAY)[s]
                : dark ? rgb(defaults[hue][SHADES[SHADES.length - 1 - i]]) : damp(defaults[hue][s], LIGHT_CHROMA)
        }
    }
    for (const [k, v] of Object.entries(SURFACE[dark ? 'dark' : 'light']))
        vars[`--${k}`] = v
    return vars
}
const palette = plugin(({ addBase, addVariant }) => {
    addBase({ ':root': paletteVars(false), '.dark': paletteVars(true) })
    // The light theme only (there is no .light class: light is the absence of .dark).
    addVariant('light', ':root:not(.dark) &')
})

/** @type {import('tailwindcss').Config} */
export default {
    darkMode: ['class'],
    content: [
        './index.html',
        './src/**/*.{ts,tsx}',
    ],
    theme: {
        extend: {
            fontFamily: {
                sans: ['"Inter Variable"', '-apple-system', 'BlinkMacSystemFont', '"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft Yahei UI"', 'sans-serif', '"Apple Color Emoji"'],
                mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', 'ui-monospace', '"SF Mono"', 'Menlo', '"PingFang SC"', 'monospace'],
            },
            colors: {
                'white': 'rgb(var(--white) / <alpha-value>)',
                'black': 'rgb(var(--black) / <alpha-value>)',
                'elevated': 'rgb(var(--elevated) / <alpha-value>)',
                'always-white': '#fff',
                'always-black': '#000',
                // IDE chrome (see --ide-* in index.css): window frame, tool-window islands, editor island.
                'ide': {
                    frame: 'var(--ide-frame)',
                    panel: 'var(--ide-panel)',
                    editor: 'var(--ide-editor)',
                    border: 'var(--ide-border)',
                    line: 'var(--ide-line)',
                    hover: 'var(--ide-hover)',
                    sel: 'var(--ide-sel)',
                    'sel-muted': 'var(--ide-sel-muted)',
                    tab: 'var(--ide-tab)',
                    block: 'var(--ide-block)',
                    prompt: 'var(--ide-prompt)',
                    accent: 'rgb(var(--ide-accent-rgb) / <alpha-value>)',
                    success: 'var(--ide-success)',
                    'accent-hover': 'var(--ide-accent-hover)',
                    fg: 'var(--ide-fg)',
                    muted: 'var(--ide-muted)',
                    dim: 'var(--ide-dim)',
                },
                'gray': scale('gray'),
                ...Object.fromEntries(HUES.map(hue => [hue, scale(hue)])),
                'color-a': 'rgb(var(--black) / 0.88)',
                'color-b': 'rgb(var(--black) / 0.6)',
                'color-c': 'rgb(var(--black) / 0.35)',
                'color-d': 'rgb(var(--black) / 0.12)',
                'icon-color': 'rgb(var(--black) / 0.55)',
                'bg-hover': 'rgb(var(--black) / 0.06)',
                'bg-active': 'rgb(var(--black) / 0.12)',
                'bg-header': 'rgba(245, 245, 245, 1)',
                'warning': {
                    DEFAULT: 'hsl(var(--warning))',
                    foreground: 'hsl(var(--warning-foreground))',
                },
                'success': {
                    DEFAULT: 'hsl(var(--success))',
                    foreground: 'hsl(var(--success-foreground))',
                },
                'info': {
                    DEFAULT: 'hsl(var(--info))',
                    foreground: 'hsl(var(--info-foreground))',
                },
                'split': '#eee',
                'background': 'hsl(var(--background))',
                'foreground': 'hsl(var(--foreground))',
                'card': {
                    DEFAULT: 'hsl(var(--card))',
                    foreground: 'hsl(var(--card-foreground))',
                },
                'popover': {
                    DEFAULT: 'hsl(var(--popover))',
                    foreground: 'hsl(var(--popover-foreground))',
                },
                'primary': {
                    DEFAULT: 'hsl(var(--primary))',
                    foreground: 'hsl(var(--primary-foreground))',
                },
                'secondary': {
                    DEFAULT: 'hsl(var(--secondary))',
                    foreground: 'hsl(var(--secondary-foreground))',
                },
                'muted': {
                    DEFAULT: 'hsl(var(--muted))',
                    foreground: 'hsl(var(--muted-foreground))',
                },
                'accent': {
                    DEFAULT: 'hsl(var(--accent))',
                    foreground: 'hsl(var(--accent-foreground))',
                },
                'destructive': {
                    DEFAULT: 'hsl(var(--destructive))',
                    foreground: 'hsl(var(--destructive-foreground))',
                },
                'border': 'hsl(var(--border))',
                'input': 'hsl(var(--input))',
                'ring': 'hsl(var(--ring))',
                'chart': {
                    1: 'hsl(var(--chart-1))',
                    2: 'hsl(var(--chart-2))',
                    3: 'hsl(var(--chart-3))',
                    4: 'hsl(var(--chart-4))',
                    5: 'hsl(var(--chart-5))',
                },
            },
            keyframes: {
                wiggle: {
                    '0%, 100%': { transform: 'rotate(-0.6deg)' },
                    '50%': { transform: 'rotate(0.6deg)' },
                },
            },
            animation: {
                wiggle: 'wiggle 0.4s ease-in-out infinite',
            },
            borderRadius: {
                lg: 'var(--radius)',
                md: 'calc(var(--radius) - 2px)',
                sm: 'calc(var(--radius) - 4px)',
            },
        },
    },
    plugins: [
        palette,
        typography,
        tailwindcssAnimate,
    ],
}
