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
/** JetBrains light neutrals (Int UI light). */
const LIGHT_GRAY = { 50: '247 248 250', 100: '235 236 240', 200: '223 225 229', 300: '201 204 214', 400: '160 164 173', 500: '129 133 148', 600: '108 112 126', 700: '81 84 96', 800: '55 57 66', 900: '30 31 34', 950: '18 19 21' }
const SURFACE = { light: { 'white': '255 255 255', 'black': '0 0 0', 'elevated': '255 255 255' }, dark: { 'white': '30 31 34', 'black': '255 255 255', 'elevated': '43 45 48' } }

const scale = name => Object.fromEntries(SHADES.map(s => [s, `rgb(var(--${name}-${s}) / <alpha-value>)`]))
const paletteVars = (dark) => {
    const vars = {}
    for (const hue of [...HUES, 'gray']) {
        for (const [i, s] of SHADES.entries()) {
            vars[`--${hue}-${s}`] = hue === 'gray'
                ? (dark ? DARK_GRAY : LIGHT_GRAY)[s]
                : rgb(defaults[hue][dark ? SHADES[SHADES.length - 1 - i] : s])
        }
    }
    for (const [k, v] of Object.entries(SURFACE[dark ? 'dark' : 'light']))
        vars[`--${k}`] = v
    return vars
}
const palette = plugin(({ addBase }) => addBase({ ':root': paletteVars(false), '.dark': paletteVars(true) }))

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
                    accent: 'var(--ide-accent)',
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
