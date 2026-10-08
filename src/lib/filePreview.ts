/**
 * How the review panel shows a file besides its text diff:
 * - image / svg / pdf / audio / video / font: the browser renders the bytes
 * - markdown / html / csv / tsv / notebook: rendered from the text
 * - archive: the entry list (bsdtar)
 * - quicklook: a macOS QuickLook thumbnail (documents, HEIC, PSD, RAW...)
 */
export type PreviewKind = 'image' | 'svg' | 'pdf' | 'audio' | 'video' | 'font' | 'markdown' | 'html' | 'csv' | 'tsv' | 'notebook' | 'archive' | 'quicklook'

/** Kinds that are text too: the row can switch between the diff and the rendered file. */
export const TEXT_PREVIEWS: ReadonlySet<PreviewKind> = new Set(['svg', 'markdown', 'html', 'csv', 'tsv', 'notebook'])

const byExt: Record<string, { kind: PreviewKind, mime: string }> = {}
const add = (kind: PreviewKind, mime: string, ...exts: string[]) => exts.forEach(e => (byExt[e] = { kind, mime }))
add('image', 'image/png', 'png', 'apng')
add('image', 'image/jpeg', 'jpg', 'jpeg', 'jfif')
add('image', 'image/gif', 'gif')
add('image', 'image/webp', 'webp')
add('image', 'image/avif', 'avif')
add('image', 'image/bmp', 'bmp')
add('image', 'image/x-icon', 'ico', 'cur')
add('svg', 'image/svg+xml', 'svg')
add('pdf', 'application/pdf', 'pdf')
add('audio', 'audio/mpeg', 'mp3')
add('audio', 'audio/wav', 'wav')
add('audio', 'audio/ogg', 'ogg', 'oga', 'opus')
add('audio', 'audio/mp4', 'm4a')
add('audio', 'audio/aac', 'aac')
add('audio', 'audio/flac', 'flac')
add('video', 'video/mp4', 'mp4', 'm4v')
add('video', 'video/webm', 'webm')
add('video', 'video/quicktime', 'mov')
add('video', 'video/ogg', 'ogv')
add('font', 'font/ttf', 'ttf')
add('font', 'font/otf', 'otf')
add('font', 'font/woff', 'woff')
add('font', 'font/woff2', 'woff2')
add('markdown', 'text/markdown', 'md', 'markdown', 'mdx', 'mdown', 'mkd')
add('html', 'text/html', 'html', 'htm', 'xhtml')
add('csv', 'text/csv', 'csv')
add('tsv', 'text/tab-separated-values', 'tsv', 'tab')
add('notebook', 'application/x-ipynb+json', 'ipynb')
add('archive', 'application/zip', 'zip', 'jar', 'war', 'ear', 'aar', 'apk', 'ipa', 'whl', 'nupkg', 'vsix', 'xpi', 'crx')
add('archive', 'application/x-tar', 'tar', 'tgz', 'tbz', 'tbz2', 'txz', 'tzst', '7z', 'rar', 'cpio', 'xar', 'pkg', 'iso', 'deb', 'rpm', 'cab', 'lha', 'lzh')
// QuickLook ships generators for these; on anything else qlmanage hangs, so the list is closed.
add('quicklook', 'application/octet-stream',
    'doc', 'docx', 'dot', 'dotx', 'rtf', 'rtfd', 'odt', 'xls', 'xlsx', 'xlsm', 'ods', 'ppt', 'pptx', 'odp',
    'pages', 'numbers', 'key', 'epub', 'heic', 'heif', 'tif', 'tiff', 'psd', 'jp2', 'tga', 'exr', 'hdr',
    'icns', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'usdz')

/** Double extensions for compressed tarballs: "x.tar.gz" is an archive, a bare "x.gz" is not. */
const TARBALL = /\.tar\.(?:gz|bz2|xz|zst|lz|lzma|z)$/i

/** Preview kind and MIME type from the file name, or null for files shown as their diff only. */
export function previewOf(path: string): { kind: PreviewKind, mime: string } | null {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (TARBALL.test(name))
        return byExt.tar
    const dot = name.lastIndexOf('.')
    if (dot <= 0)
        return null
    return byExt[name.slice(dot + 1).toLowerCase()] ?? null
}

/** 1536 → "1.5 KB"; binary units, one decimal under 10. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024)
        return `${bytes} B`
    const units = ['KB', 'MB', 'GB']
    let value = bytes / 1024
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit++
    }
    return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[unit]}`
}

/**
 * CSV / TSV rows (RFC 4180: quoted fields, doubled quotes, newlines inside quotes, CRLF), stopping
 * after `limit` rows. `more` tells whether rows were left over.
 */
export function parseDelimited(text: string, separator: string, limit = Infinity): { rows: string[][], more: boolean } {
    const rows: string[][] = []
    let row: string[] = []
    let field = ''
    let quoted = false
    let i = text.charCodeAt(0) === 0xFEFF ? 1 : 0
    const endRow = () => {
        row.push(field)
        rows.push(row)
        row = []
        field = ''
    }
    for (; i < text.length; i++) {
        const c = text[i]
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"'
                    i++
                }
                else {
                    quoted = false
                }
            }
            else {
                field += c
            }
            continue
        }
        if (c === '"' && field === '') {
            quoted = true
        }
        else if (c === separator) {
            row.push(field)
            field = ''
        }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n')
                i++
            endRow()
            if (rows.length >= limit)
                return { rows, more: i + 1 < text.length }
        }
        else {
            field += c
        }
    }
    if (field !== '' || row.length)
        endRow()
    return { rows, more: false }
}

/** Added / removed / kept entries between two archive listings, in name order. */
export function diffEntries(before: string[] | null, after: string[] | null): { name: string, change: 'added' | 'removed' | 'same' }[] {
    const old = new Set(before ?? [])
    const neu = new Set(after ?? [])
    const both = before && after
    return [...new Set([...old, ...neu])].sort().map(name => ({
        name,
        change: !both ? 'same' : !old.has(name) ? 'added' : !neu.has(name) ? 'removed' : 'same',
    }))
}
