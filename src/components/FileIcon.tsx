// File type icons for the file tree and editor tabs, after the JetBrains set: each kind has its own mark,
// drawn thin on a 16px grid. Language files are a rounded badge with their letters in the language's colour,
// formats (JSON, Markdown, HTML, images, ...) are line drawings. Colours are mid-tones that read on both themes.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type IconKind =
    | { badge: string, bg: string, fg?: string }
    | { mark: 'react' | 'json' | 'markdown' | 'html' | 'text' | 'image' | 'shell' | 'config' | 'ignore' | 'git' | 'eslint' | 'bun' | 'lock' | 'generic' }

const BLUE = '#4d7fe6'
const YELLOW = '#f0c33c'
const DARK = '#2b2d30'

const BADGES: Record<string, IconKind> = {
    ts: { badge: 'TS', bg: BLUE },
    js: { badge: 'JS', bg: YELLOW, fg: DARK },
    py: { badge: 'PY', bg: '#3f7fb5' },
    rs: { badge: 'RS', bg: '#d2693a' },
    go: { badge: 'GO', bg: '#2fb0cf' },
    java: { badge: 'J', bg: '#d9772b' },
    kt: { badge: 'KT', bg: '#8b6ce0' },
    swift: { badge: 'SW', bg: '#ef5a3c' },
    c: { badge: 'C', bg: '#5d82c7' },
    cpp: { badge: 'C+', bg: '#5d82c7' },
    cs: { badge: 'C#', bg: '#7a54b8' },
    rb: { badge: 'RB', bg: '#cc3b33' },
    php: { badge: 'PHP', bg: '#7b87bd' },
    lua: { badge: 'LU', bg: '#3f5fb0' },
    sql: { badge: 'SQL', bg: '#7f8fa3' },
    css: { badge: '#', bg: '#4f9be8' },
    scss: { badge: 'S', bg: '#dc5f98' },
    less: { badge: 'L', bg: '#4a6db0' },
    vue: { badge: 'V', bg: '#46b27e' },
    svelte: { badge: 'S', bg: '#ee6a3a' },
    dart: { badge: 'D', bg: '#3fb6d4' },
    zig: { badge: 'Z', bg: '#f0a43c', fg: DARK },
    xml: { badge: 'XML', bg: '#7f8fa3' },
    wasm: { badge: 'WA', bg: '#8168e8' },
    dockerfile: { badge: 'D', bg: '#4f9be8' },
    makefile: { badge: 'M', bg: '#7f8fa3' },
    toml: { badge: 'T', bg: '#9c6b4e' },
}

const EXT: Record<string, IconKind> = {
    ts: BADGES.ts,
    mts: BADGES.ts,
    cts: BADGES.ts,
    js: BADGES.js,
    mjs: BADGES.js,
    cjs: BADGES.js,
    tsx: { mark: 'react' },
    jsx: { mark: 'react' },
    json: { mark: 'json' },
    jsonc: { mark: 'json' },
    json5: { mark: 'json' },
    jsonl: { mark: 'json' },
    md: { mark: 'markdown' },
    mdx: { mark: 'markdown' },
    html: { mark: 'html' },
    htm: { mark: 'html' },
    txt: { mark: 'text' },
    rst: { mark: 'text' },
    log: { mark: 'text' },
    py: BADGES.py,
    pyi: BADGES.py,
    rs: BADGES.rs,
    go: BADGES.go,
    java: BADGES.java,
    kt: BADGES.kt,
    kts: BADGES.kt,
    swift: BADGES.swift,
    c: BADGES.c,
    h: BADGES.c,
    cc: BADGES.cpp,
    cpp: BADGES.cpp,
    hpp: BADGES.cpp,
    cs: BADGES.cs,
    rb: BADGES.rb,
    php: BADGES.php,
    lua: BADGES.lua,
    sql: BADGES.sql,
    css: BADGES.css,
    scss: BADGES.scss,
    sass: BADGES.scss,
    less: BADGES.less,
    vue: BADGES.vue,
    svelte: BADGES.svelte,
    dart: BADGES.dart,
    zig: BADGES.zig,
    xml: BADGES.xml,
    wasm: BADGES.wasm,
    sh: { mark: 'shell' },
    zsh: { mark: 'shell' },
    bash: { mark: 'shell' },
    fish: { mark: 'shell' },
    ps1: { mark: 'shell' },
    bat: { mark: 'shell' },
    yaml: { mark: 'config' },
    yml: { mark: 'config' },
    toml: BADGES.toml,
    ini: { mark: 'config' },
    conf: { mark: 'config' },
    env: { mark: 'config' },
    lock: { mark: 'lock' },
    lockb: { mark: 'bun' },
}
for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'heic', 'icns'])
    EXT[ext] = { mark: 'image' }

const NAMES: Record<string, IconKind> = {
    'dockerfile': BADGES.dockerfile,
    'makefile': BADGES.makefile,
    'license': { mark: 'text' },
    'licence': { mark: 'text' },
    'bun.lock': { mark: 'bun' },
    'bun.lockb': { mark: 'bun' },
    '.gitignore': { mark: 'ignore' },
    '.dockerignore': { mark: 'ignore' },
    '.npmignore': { mark: 'ignore' },
    '.eslintignore': { mark: 'ignore' },
    '.prettierignore': { mark: 'ignore' },
    '.gitattributes': { mark: 'git' },
    '.gitmodules': { mark: 'git' },
    '.gitkeep': { mark: 'git' },
    '.editorconfig': { mark: 'config' },
    '.npmrc': { mark: 'config' },
    '.nvmrc': { mark: 'config' },
}

/** Which mark a file gets: by exact name first (LICENSE, .gitignore, bun.lock), then by what the name ends with. */
export function iconKind(name: string): IconKind {
    const lower = name.toLowerCase()
    const exact = NAMES[lower]
    if (exact)
        return exact
    if (/^eslint\.config\.|^\.eslintrc/.test(lower))
        return { mark: 'eslint' }
    if (/^\.env(\.|$)/.test(lower))
        return { mark: 'config' }
    const dot = lower.lastIndexOf('.')
    return (dot > 0 ? EXT[lower.slice(dot + 1)] : undefined) ?? { mark: 'generic' }
}

/** `a.test.ts`, `b.spec.tsx`, `test_c.py`: the file kind with a run mark. */
export function isTestFile(name: string): boolean {
    return /\.(?:test|spec)\.[^.]+$/i.test(name) || /^test_.+\.py$/i.test(name) || /_test\.(?:go|py)$/i.test(name)
}

const GRAY = 'var(--ide-icon, currentColor)'

function Line({ d, color = GRAY, width = 1.1 }: { d: string, color?: string, width?: number }) {
    return <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
}

function Badge({ text, bg, fg = '#fff' }: { text: string, bg: string, fg?: string }) {
    const size = text.length === 1 ? 9 : text.length === 2 ? 7.2 : 5.4
    return (
        <>
            <rect x="1" y="1" width="14" height="14" rx="3.2" fill={bg} />
            <text x="8" y="8" dy="0.36em" textAnchor="middle" fontSize={size} fontWeight="700" fill={fg} fontFamily="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif" letterSpacing={text.length > 1 ? -0.2 : 0}>{text}</text>
        </>
    )
}

const MARKS: Record<string, () => ReactNode> = {
    react: () => (
        <g fill="none" stroke="#3fa9d9" strokeWidth="1">
            <ellipse cx="8" cy="8" rx="6.6" ry="2.5" />
            <ellipse cx="8" cy="8" rx="6.6" ry="2.5" transform="rotate(60 8 8)" />
            <ellipse cx="8" cy="8" rx="6.6" ry="2.5" transform="rotate(120 8 8)" />
            <circle cx="8" cy="8" r="1.2" fill="#3fa9d9" stroke="none" />
        </g>
    ),
    json: () => <Line color="#a58be8" width={1.3} d="M6 2.5c-1.6 0-2.1.7-2.1 1.9v1.3c0 1-.4 1.6-1.4 2.3 1 .7 1.4 1.3 1.4 2.3v1.3c0 1.2.5 1.9 2.1 1.9M10 2.5c1.6 0 2.1.7 2.1 1.9v1.3c0 1 .4 1.6 1.4 2.3-1 .7-1.4 1.3-1.4 2.3v1.3c0 1.2-.5 1.9-2.1 1.9" />,
    markdown: () => <Line color="#5b8def" width={1.4} d="M1.5 11.5v-7l2.4 3 2.4-3v7M12 4.5v6.6M9.9 9.1l2.1 2.3 2.1-2.3" />,
    html: () => <Line color="#6aa95a" width={1.4} d="M5.4 4.4 1.9 8l3.5 3.6M10.6 4.4 14.1 8l-3.5 3.6" />,
    text: () => <Line d="M2.5 3.5h11M2.5 6.5h11M2.5 9.5h11M2.5 12.5h7" width={1.2} />,
    image: () => (
        <>
            <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" fill="none" stroke="#5aa98a" strokeWidth="1.1" />
            <circle cx="5.4" cy="6.2" r="1.1" fill="#5aa98a" />
            <Line color="#5aa98a" d="M2.2 12 6.4 8.4l2.6 2.4 1.9-1.6 3.1 2.8" />
        </>
    ),
    shell: () => <Line color="#6aa95a" width={1.3} d="M3 4.5 7 8l-4 3.5M8.5 12h4.5" />,
    config: () => (
        <>
            <Line d="M2.5 5h1.9M7.6 5h5.9M2.5 11h5.9M11.6 11h1.9" />
            <circle cx="6" cy="5" r="1.6" fill="none" stroke={GRAY} strokeWidth="1.1" />
            <circle cx="10" cy="11" r="1.6" fill="none" stroke={GRAY} strokeWidth="1.1" />
        </>
    ),
    ignore: () => (
        <>
            <circle cx="8" cy="8" r="5.7" fill="none" stroke={GRAY} strokeWidth="1.2" />
            <Line width={1.2} d="m4 12 8-8" />
        </>
    ),
    git: () => (
        <>
            <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.6" transform="rotate(45 8 8)" fill="none" stroke="#e8683c" strokeWidth="1.1" />
            <circle cx="8" cy="8" r="1.1" fill="#e8683c" />
        </>
    ),
    eslint: () => (
        <>
            <path d="M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8z" fill="none" stroke="#7c7ce8" strokeWidth="1.1" strokeLinejoin="round" />
            <path d="M8 5 10.4 6.4v3.2L8 11 5.6 9.6V6.4z" fill="#7c7ce8" />
        </>
    ),
    bun: () => (
        <>
            <ellipse cx="8" cy="8.6" rx="6.4" ry="5.4" fill="#f4dcc4" stroke="#c9a98a" strokeWidth="0.8" />
            <circle cx="5.7" cy="8.4" r="0.9" fill="#3a2e28" />
            <circle cx="10.3" cy="8.4" r="0.9" fill="#3a2e28" />
            <Line color="#3a2e28" width={0.8} d="M7 10.4q1 .8 2 0" />
        </>
    ),
    lock: () => (
        <>
            <rect x="3.4" y="7" width="9.2" height="6.8" rx="1.4" fill="none" stroke={GRAY} strokeWidth="1.1" />
            <Line d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
        </>
    ),
    generic: () => <Line d="M4 1.8h5.2l3.3 3.3V13.6a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.4a.6.6 0 0 1 .6-.6zM9.2 1.8v3.3h3.3" />,
}

export function FileIcon({ name, className, size = 14 }: { name: string, className?: string, size?: number }) {
    const kind = iconKind(name)
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" className={cn('shrink-0', className)} aria-hidden>
            {'badge' in kind ? <Badge text={kind.badge} bg={kind.bg} fg={kind.fg} /> : MARKS[kind.mark]()}
            {isTestFile(name) && (
                <>
                    <circle cx="12.6" cy="12.6" r="3" fill="#59a869" stroke="var(--ide-panel, #fff)" strokeWidth="0.8" />
                    <path d="m11.8 11.3 1.7 1.3-1.7 1.3z" fill="#fff" />
                </>
            )}
        </svg>
    )
}

/** Folders are one outline, open or not: the chevron says which. Orange for ones outside the project's sources (git-ignored). */
export function FolderIcon({ className, size = 14, excluded }: { className?: string, size?: number, excluded?: boolean }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" className={cn('shrink-0', className)} aria-hidden>
            <Line color={excluded ? 'var(--ide-icon-excluded)' : GRAY} width={1.2} d="M1.9 4.2a1.1 1.1 0 0 1 1.1-1.1h3l1.4 1.6H13a1.1 1.1 0 0 1 1.1 1.1v6.1A1.1 1.1 0 0 1 13 13H3a1.1 1.1 0 0 1-1.1-1.1z" />
        </svg>
    )
}
