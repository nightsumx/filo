/** File types the review panel can show as themselves instead of as a text diff. */
export type PreviewKind = 'image' | 'svg' | 'pdf' | 'audio' | 'video'

const MIME: Record<string, { kind: PreviewKind, mime: string }> = {
    png: { kind: 'image', mime: 'image/png' },
    jpg: { kind: 'image', mime: 'image/jpeg' },
    jpeg: { kind: 'image', mime: 'image/jpeg' },
    gif: { kind: 'image', mime: 'image/gif' },
    webp: { kind: 'image', mime: 'image/webp' },
    avif: { kind: 'image', mime: 'image/avif' },
    bmp: { kind: 'image', mime: 'image/bmp' },
    ico: { kind: 'image', mime: 'image/x-icon' },
    svg: { kind: 'svg', mime: 'image/svg+xml' },
    pdf: { kind: 'pdf', mime: 'application/pdf' },
    mp3: { kind: 'audio', mime: 'audio/mpeg' },
    wav: { kind: 'audio', mime: 'audio/wav' },
    ogg: { kind: 'audio', mime: 'audio/ogg' },
    oga: { kind: 'audio', mime: 'audio/ogg' },
    m4a: { kind: 'audio', mime: 'audio/mp4' },
    aac: { kind: 'audio', mime: 'audio/aac' },
    flac: { kind: 'audio', mime: 'audio/flac' },
    mp4: { kind: 'video', mime: 'video/mp4' },
    m4v: { kind: 'video', mime: 'video/mp4' },
    webm: { kind: 'video', mime: 'video/webm' },
    mov: { kind: 'video', mime: 'video/quicktime' },
    ogv: { kind: 'video', mime: 'video/ogg' },
}

/** Preview kind and MIME type from the file name, or null for anything shown as text / "binary". */
export function previewOf(path: string): { kind: PreviewKind, mime: string } | null {
    const name = path.slice(path.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    if (dot <= 0)
        return null
    return MIME[name.slice(dot + 1).toLowerCase()] ?? null
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
