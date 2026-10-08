import type { GitFileChange } from '@shared/ipc'
import type { PreviewKind } from '@/lib/filePreview'
import { ImageLightbox } from '@/components/ImageView'
import { diffEntries, formatBytes } from '@/lib/filePreview'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { Caption, note, sideLabel, VersionSwitch } from './previewParts'

/** One version of the file: its bytes as a blob: URL for the preview elements, and its real size. */
interface Side {
    key: 'old' | 'new'
    label: string
    url: string
    data: Uint8Array
    size: number
}

type Loaded<T>
    = | { state: 'loading' }
        | { state: 'error', message: string }
        | { state: 'tooLarge', size: number }
        | { state: 'ready', value: T }

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length)
        return false
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false
    }
    return true
}

interface FileRef { cwd: string, file: GitFileChange, tick: number }

/**
 * Loads both versions through `fetch` and turns them into blob-URL sides, revoked when the row
 * closes or reloads. A side identical to the other (a pure rename) is shown once.
 */
function useSides({ cwd, file, tick }: FileRef, mime: string, fetch: typeof window.pi.gitFileBytes | typeof window.pi.gitFileThumbs): Loaded<Side[]> {
    const [loaded, setLoaded] = useState<Loaded<Side[]>>({ state: 'loading' })
    useEffect(() => {
        let cancelled = false
        const urls: string[] = []
        setLoaded({ state: 'loading' })
        fetch(cwd, file.path, file.status, file.origPath)
            .then((got) => {
                if (cancelled)
                    return
                if ('tooLarge' in got && got.tooLarge) {
                    setLoaded({ state: 'tooLarge', size: Math.max(got.oldSize, got.newSize) })
                    return
                }
                const old = got.old && got.new && sameBytes(got.old, got.new) ? null : got.old
                const both = !!old && !!got.new
                const side = (key: Side['key'], data: Uint8Array, size: number): Side => {
                    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }))
                    urls.push(url)
                    return { key, label: sideLabel(key, both), url, data, size }
                }
                setLoaded({ state: 'ready', value: [
                    old && side('old', old, got.oldSize),
                    got.new && side('new', got.new, got.newSize),
                ].filter((s): s is Side => !!s) })
            })
            .catch(e => !cancelled && setLoaded({ state: 'error', message: String(e?.message ?? e) }))
        return () => {
            cancelled = true
            urls.forEach(u => URL.revokeObjectURL(u))
        }
    }, [cwd, file.path, file.status, file.origPath, mime, tick, fetch])
    return loaded
}

/** The loading / error / too-large states every preview shares; `render` gets the loaded value. */
function Status<T>({ loaded, render }: { loaded: Loaded<T>, render: (value: T) => React.ReactNode }) {
    if (loaded.state === 'loading')
        return <div className={note}>{tr('加载中…', 'Loading…')}</div>
    if (loaded.state === 'error')
        return <div className="px-1 py-2 text-[12px] text-red-500">{loaded.message}</div>
    if (loaded.state === 'tooLarge')
        return <div className={note}>{tr(`文件较大（${formatBytes(loaded.size)}），不预览`, `Large file (${formatBytes(loaded.size)}); not previewed`)}</div>
    return <>{render(loaded.value)}</>
}

/** Transparent pixels show as a faint checkerboard, as in image viewers; the tint follows the theme. */
const checkerboard = {
    backgroundImage: 'conic-gradient(rgb(var(--black) / 0.06) 25%, transparent 0 50%, rgb(var(--black) / 0.06) 0 75%, transparent 0)',
    backgroundSize: '16px 16px',
}

/** Images up to this many pixels on each side fill their tile instead of sitting tiny in it. */
const SMALL_IMAGE = 64

/** Images side by side; click one for the full-window viewer. `measure` adds the pixel size. */
function ImageSides({ sides, name, measure }: { sides: Side[], name: string, measure: boolean }) {
    const [dims, setDims] = useState<Record<string, string>>({})
    // Icons and sprites are scaled up to the tile with hard pixel edges, so they can be seen at all.
    const [small, setSmall] = useState<Record<string, boolean>>({})
    const [open, setOpen] = useState<number | null>(null)
    return (
        <>
            <div className={cn('grid gap-2', sides.length > 1 && 'grid-cols-2')}>
                {sides.map((side, i) => (
                    <figure key={side.key} className="min-w-0">
                        <Caption label={side.label} detail={measure ? dims[side.key] : undefined} size={side.size} />
                        <button
                            type="button"
                            aria-label={tr(`查看大图：${name}${side.label && `（${side.label}）`}`, `View full size: ${name}${side.label && ` (${side.label})`}`)}
                            onClick={() => setOpen(i)}
                            // Documents are opaque pages; only images get the transparency checkerboard.
                            style={measure ? checkerboard : undefined}
                            className={cn('flex w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-md bg-ide-block p-2 outline-none focus-visible:ring-2 focus-visible:ring-ide-accent/50', measure ? 'h-48' : 'h-72')}
                        >
                            <img
                                src={side.url}
                                alt={side.label || name}
                                draggable={false}
                                onLoad={(e) => {
                                    const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                                    setDims(d => ({ ...d, [side.key]: w && h ? `${w} × ${h}` : '' }))
                                    setSmall(d => ({ ...d, [side.key]: measure && !!w && !!h && w <= SMALL_IMAGE && h <= SMALL_IMAGE }))
                                }}
                                className={cn('object-contain', small[side.key] ? 'h-full w-full [image-rendering:pixelated]' : 'max-h-full max-w-full')}
                            />
                        </button>
                    </figure>
                ))}
            </div>
            {open !== null && (
                <ImageLightbox
                    srcs={sides.map(s => s.url)}
                    labels={sides.length > 1 ? sides.map(s => s.label) : undefined}
                    index={open}
                    onIndex={setOpen}
                    onClose={() => setOpen(null)}
                />
            )}
        </>
    )
}

/** PDF and video take the panel's width, so two versions are a switch rather than side by side. */
function useVersion(sides: Side[]) {
    const [index, setIndex] = useState(sides.length - 1)
    const side = sides[Math.min(index, sides.length - 1)]
    const labels = sides.map(s => s.label)
    return { side, switcher: <VersionSwitch labels={labels} value={index} onChange={setIndex} /> }
}

function PdfSides({ sides, name }: { sides: Side[], name: string }) {
    const { side, switcher } = useVersion(sides)
    return (
        <div>
            {switcher}
            <Caption size={side.size} />
            <iframe key={side.url} src={`${side.url}#navpanes=0&view=FitH`} title={name} className="h-[520px] w-full rounded-md bg-ide-block" />
        </div>
    )
}

function VideoSides({ sides, name }: { sides: Side[], name: string }) {
    const { side, switcher } = useVersion(sides)
    const [dims, setDims] = useState<Record<string, string>>({})
    return (
        <div>
            {switcher}
            <Caption detail={dims[side.key]} size={side.size} />
            <video
                key={side.url}
                src={side.url}
                controls
                preload="metadata"
                aria-label={name}
                onLoadedMetadata={(e) => {
                    const { videoWidth: w, videoHeight: h, duration } = e.currentTarget
                    const time = Number.isFinite(duration) ? `${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, '0')}` : ''
                    setDims(d => ({ ...d, [side.key]: [w && h ? `${w} × ${h}` : '', time].filter(Boolean).join(' · ') }))
                }}
                className="max-h-80 w-full rounded-md bg-always-black"
            />
        </div>
    )
}

function AudioSides({ sides, name }: { sides: Side[], name: string }) {
    return (
        <div className="flex flex-col gap-2">
            {sides.map(side => (
                <div key={side.key}>
                    <Caption label={side.label} size={side.size} />
                    <audio src={side.url} controls preload="metadata" aria-label={side.label ? `${name} (${side.label})` : name} className="h-8 w-full" />
                </div>
            ))}
        </div>
    )
}

let fontSeq = 0

/** A font's glyphs at a few sizes. Loaded from its bytes (FontFace), so no font URL is fetched. */
function FontSample({ side }: { side: Side }) {
    const [family, setFamily] = useState<string | null>(null)
    const [failed, setFailed] = useState(false)
    useEffect(() => {
        const name = `filo-preview-${++fontSeq}`
        const face = new FontFace(name, side.data.slice().buffer)
        let live = true
        face.load().then(() => {
            if (!live)
                return
            document.fonts.add(face)
            setFamily(name)
        }, () => live && setFailed(true))
        return () => {
            live = false
            document.fonts.delete(face)
        }
    }, [side.data])
    return (
        <div>
            <Caption label={side.label} size={side.size} />
            {failed
                ? <div className={note}>{tr('无法加载这个字体', 'This font could not be loaded')}</div>
                : (
                        <div className={cn('flex flex-col gap-1 overflow-hidden rounded-md bg-ide-block px-3 py-2.5 text-gray-900', !family && 'invisible')} style={family ? { fontFamily: `"${family}"` } : undefined}>
                            <div className="text-[34px] leading-tight">Aa Bb Cc 0123</div>
                            <div className="text-[18px] leading-snug">The quick brown fox jumps over the lazy dog</div>
                            <div className="text-[14px] leading-snug">ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 !?&@#%</div>
                            <div className="text-[14px] leading-snug">敏捷的棕色狐狸跳过了懒狗</div>
                        </div>
                    )}
        </div>
    )
}

function BytesPreview({ ctx, kind, mime, name }: { ctx: FileRef, kind: PreviewKind, mime: string, name: string }) {
    const loaded = useSides(ctx, mime, window.pi.gitFileBytes)
    return (
        <Status
            loaded={loaded}
            render={(sides) => {
                if (!sides.length)
                    return <div className={note}>{tr('空文件', 'Empty file')}</div>
                if (kind === 'pdf')
                    return <PdfSides sides={sides} name={name} />
                if (kind === 'video')
                    return <VideoSides sides={sides} name={name} />
                if (kind === 'audio')
                    return <AudioSides sides={sides} name={name} />
                if (kind === 'font')
                    return <div className="flex flex-col gap-2">{sides.map(s => <FontSample key={s.key} side={s} />)}</div>
                return <ImageSides sides={sides} name={name} measure />
            }}
        />
    )
}

/** Documents, HEIC, PSD...: the QuickLook thumbnail Finder would show, with the file's own size. */
function QuickLookPreview({ ctx, name }: { ctx: FileRef, name: string }) {
    const loaded = useSides(ctx, 'image/png', window.pi.gitFileThumbs)
    return (
        <Status
            loaded={loaded}
            render={sides => sides.length
                ? <ImageSides sides={sides} name={name} measure={false} />
                : <div className={note}>{tr('macOS 没能生成这个文件的预览', 'macOS could not make a preview of this file')}</div>}
        />
    )
}

/** Unchanged entries of a changed archive stay folded under one row; past this many, so does the rest. */
const MAX_ENTRY_ROWS = 1000

function ArchivePreview({ ctx: { cwd, file, tick } }: { ctx: FileRef }) {
    const [loaded, setLoaded] = useState<Loaded<Awaited<ReturnType<typeof window.pi.gitFileEntries>>>>({ state: 'loading' })
    const [showSame, setShowSame] = useState(false)
    useEffect(() => {
        let cancelled = false
        window.pi.gitFileEntries(cwd, file.path, file.status, file.origPath)
            .then(value => !cancelled && setLoaded({ state: 'ready', value }))
            .catch(e => !cancelled && setLoaded({ state: 'error', message: String(e?.message ?? e) }))
        return () => {
            cancelled = true
        }
    }, [cwd, file.path, file.status, file.origPath, tick])
    return (
        <Status
            loaded={loaded}
            render={(got) => {
                const entries = diffEntries(got.old, got.new)
                const changed = entries.filter(e => e.change !== 'same')
                const compare = !!got.old && !!got.new
                const same = entries.length - changed.length
                const rows = (compare && !showSame ? changed : entries).slice(0, MAX_ENTRY_ROWS)
                const count = got.new ? got.newCount : got.oldCount
                const capped = Math.max(got.oldCount, got.newCount) > entries.length || entries.length > MAX_ENTRY_ROWS
                return (
                    <div>
                        <Caption detail={compare
                            ? tr(`${count} 项 · 新增 ${changed.filter(e => e.change === 'added').length} · 删除 ${changed.filter(e => e.change === 'removed').length}`, `${count} entries · ${changed.filter(e => e.change === 'added').length} added · ${changed.filter(e => e.change === 'removed').length} removed`)
                            : tr(`${count} 项`, `${count} entries`)}
                        />
                        <div className="max-h-80 overflow-y-auto rounded-md bg-ide-block py-1 font-mono text-[12px]">
                            {compare && !changed.length && !showSame && <div className="px-2.5 py-0.5 text-gray-500">{tr('文件列表没有变化（内容可能变了）', 'Same entries (their contents may differ)')}</div>}
                            {rows.map(e => (
                                <div key={e.name} className={cn('flex gap-2 px-2.5 leading-5', e.change === 'added' && 'bg-[var(--diff-add-row)]', e.change === 'removed' && 'bg-[var(--diff-del-row)]')}>
                                    <span className={cn('w-2 shrink-0', e.change === 'added' ? 'text-emerald-600' : 'text-red-500')} aria-hidden>{e.change === 'added' ? '+' : e.change === 'removed' ? '−' : ''}</span>
                                    <span className={cn('min-w-0 truncate', e.name.endsWith('/') ? 'text-gray-500' : 'text-gray-800')} title={e.name}>
                                        {e.change !== 'same' && <span className="sr-only">{e.change === 'added' ? tr('新增 ', 'added ') : tr('删除 ', 'removed ')}</span>}
                                        {e.name}
                                    </span>
                                </div>
                            ))}
                            {compare && same > 0 && (
                                <button type="button" onClick={() => setShowSame(v => !v)} className="mx-1 mt-0.5 rounded px-1.5 py-0.5 font-sans text-gray-500 hover:bg-black/[0.05] hover:text-gray-800">
                                    {showSame ? tr('只看变化', 'Changes only') : tr(`显示未变的 ${same} 项`, `Show ${same} unchanged`)}
                                </button>
                            )}
                            {capped && <div className="px-2.5 pt-0.5 font-sans text-gray-400">{tr(`只列出前 ${Math.min(entries.length, MAX_ENTRY_ROWS)} 项`, `Only the first ${Math.min(entries.length, MAX_ENTRY_ROWS)} are listed`)}</div>}
                        </div>
                    </div>
                )
            }}
        />
    )
}

/**
 * A changed file shown as itself: images, SVG, PDF, audio, video and fonts from their bytes,
 * archives as their entry list, documents and other macOS types as a QuickLook thumbnail. Both the
 * committed version and the working copy where both exist.
 */
export function FilePreview({ cwd, file, kind, mime, tick }: { cwd: string, file: GitFileChange, kind: PreviewKind, mime: string, tick: number }) {
    const ctx = { cwd, file, tick }
    const name = file.path.slice(file.path.lastIndexOf('/') + 1)
    if (kind === 'archive')
        return <ArchivePreview ctx={ctx} />
    if (kind === 'quicklook')
        return <QuickLookPreview ctx={ctx} name={name} />
    return <BytesPreview ctx={ctx} kind={kind} mime={mime} name={name} />
}
