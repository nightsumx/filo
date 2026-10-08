import type { GitFileChange } from '@shared/ipc'
import type { PreviewKind } from '@/lib/filePreview'
import { ImageLightbox } from '@/components/ImageView'
import { formatBytes } from '@/lib/filePreview'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'

/** One version of the file, as a blob: URL the preview elements load. */
interface Side {
    key: 'old' | 'new'
    label: string
    url: string
    size: number
}

type Loaded
    = | { state: 'loading' }
        | { state: 'error', message: string }
        | { state: 'tooLarge', size: number }
        | { state: 'ready', sides: Side[] }

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length)
        return false
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false
    }
    return true
}

/** Fetches both sides of the file and holds them as blob URLs, revoked when the row closes or reloads. */
function useSides(cwd: string, file: GitFileChange, mime: string, tick: number): Loaded {
    const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
    useEffect(() => {
        let cancelled = false
        const urls: string[] = []
        window.pi.gitFileBytes(cwd, file.path, file.status, file.origPath)
            .then((bytes) => {
                if (cancelled)
                    return
                if (bytes.tooLarge) {
                    setLoaded({ state: 'tooLarge', size: Math.max(bytes.oldSize, bytes.newSize) })
                    return
                }
                // A pure rename (or a mode change) has nothing to compare: show it once.
                const old = bytes.old && bytes.new && sameBytes(bytes.old, bytes.new) ? null : bytes.old
                const both = !!old && !!bytes.new
                const side = (key: Side['key'], data: Uint8Array, size: number): Side => {
                    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }))
                    urls.push(url)
                    const label = !both ? '' : key === 'old' ? tr('之前', 'Before') : tr('之后', 'After')
                    return { key, label, url, size }
                }
                const sides = [
                    old && side('old', old, bytes.oldSize),
                    bytes.new && side('new', bytes.new, bytes.newSize),
                ].filter((s): s is Side => !!s)
                setLoaded({ state: 'ready', sides })
            })
            .catch(e => !cancelled && setLoaded({ state: 'error', message: String(e?.message ?? e) }))
        return () => {
            cancelled = true
            urls.forEach(u => URL.revokeObjectURL(u))
        }
    }, [cwd, file.path, file.status, file.origPath, mime, tick])
    return loaded
}

const note = 'px-1 py-2 text-[12px] text-gray-400'

/** Transparent pixels show as a faint checkerboard, as in image viewers; the tint follows the theme. */
const checkerboard = {
    backgroundImage: 'conic-gradient(rgb(var(--black) / 0.06) 25%, transparent 0 50%, rgb(var(--black) / 0.06) 0 75%, transparent 0)',
    backgroundSize: '16px 16px',
}

function Caption({ side, detail }: { side: Side, detail?: string }) {
    return (
        <div className="flex min-w-0 items-baseline gap-1.5 px-0.5 pb-1 text-[12px] tabular-nums">
            {side.label && <span className="shrink-0 font-medium text-gray-700">{side.label}</span>}
            <span className="truncate text-gray-500">{[detail, formatBytes(side.size)].filter(Boolean).join(' · ')}</span>
        </div>
    )
}

/** Images up to this many pixels on each side fill their tile instead of sitting tiny in it. */
const SMALL_IMAGE = 64

function ImageSides({ sides, name }: { sides: Side[], name: string }) {
    const [dims, setDims] = useState<Record<string, string>>({})
    // Icons and sprites are scaled up to the tile with hard pixel edges, so they can be seen at all.
    const [small, setSmall] = useState<Record<string, boolean>>({})
    const [open, setOpen] = useState<number | null>(null)
    return (
        <>
            <div className={cn('grid gap-2', sides.length > 1 && 'grid-cols-2')}>
                {sides.map((side, i) => (
                    <figure key={side.key} className="min-w-0">
                        <Caption side={side} detail={dims[side.key]} />
                        <button
                            type="button"
                            aria-label={tr(`查看大图：${name}${side.label && `（${side.label}）`}`, `View full size: ${name}${side.label && ` (${side.label})`}`)}
                            onClick={() => setOpen(i)}
                            style={checkerboard}
                            className="flex h-48 w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-md bg-ide-block p-2 outline-none focus-visible:ring-2 focus-visible:ring-ide-accent/50"
                        >
                            <img
                                src={side.url}
                                alt={side.label || name}
                                draggable={false}
                                onLoad={(e) => {
                                    const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                                    setDims(d => ({ ...d, [side.key]: w && h ? `${w} × ${h}` : '' }))
                                    setSmall(d => ({ ...d, [side.key]: !!w && !!h && w <= SMALL_IMAGE && h <= SMALL_IMAGE }))
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
function SideSwitch({ sides, value, onChange }: { sides: Side[], value: number, onChange: (i: number) => void }) {
    if (sides.length < 2)
        return null
    return (
        <div className="mb-1.5 flex gap-0.5" role="group" aria-label={tr('版本', 'Version')}>
            {sides.map((s, i) => (
                <button
                    key={s.key}
                    type="button"
                    aria-pressed={value === i}
                    onClick={() => onChange(i)}
                    className={cn('flex h-[22px] items-center rounded-md px-2 text-[12px]', value === i ? 'bg-black/[0.07] text-gray-900' : 'text-gray-500 hover:text-gray-800')}
                >
                    {s.label}
                </button>
            ))}
        </div>
    )
}

function PdfSides({ sides, name }: { sides: Side[], name: string }) {
    const [index, setIndex] = useState(sides.length - 1)
    const side = sides[index] ?? sides[0]
    return (
        <div>
            <SideSwitch sides={sides} value={index} onChange={setIndex} />
            <Caption side={{ ...side, label: '' }} />
            <iframe key={side.url} src={`${side.url}#navpanes=0&view=FitH`} title={name} className="h-[520px] w-full rounded-md bg-ide-block" />
        </div>
    )
}

function VideoSides({ sides, name }: { sides: Side[], name: string }) {
    const [index, setIndex] = useState(sides.length - 1)
    const [dims, setDims] = useState<Record<string, string>>({})
    const side = sides[index] ?? sides[0]
    return (
        <div>
            <SideSwitch sides={sides} value={index} onChange={setIndex} />
            <Caption side={{ ...side, label: '' }} detail={dims[side.key]} />
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
                    <Caption side={side} />
                    <audio src={side.url} controls preload="metadata" aria-label={side.label ? `${name} (${side.label})` : name} className="h-8 w-full" />
                </div>
            ))}
        </div>
    )
}

/**
 * A changed image, SVG, PDF, audio or video file shown as itself: the committed version and the
 * working copy (side by side for images, a switch for the rest), or the one that exists.
 */
export function FilePreview({ cwd, file, kind, mime, tick }: { cwd: string, file: GitFileChange, kind: PreviewKind, mime: string, tick: number }) {
    const loaded = useSides(cwd, file, mime, tick)
    const name = file.path.slice(file.path.lastIndexOf('/') + 1)
    if (loaded.state === 'loading')
        return <div className={note}>{tr('加载中…', 'Loading…')}</div>
    if (loaded.state === 'error')
        return <div className="px-1 py-2 text-[12px] text-red-500">{loaded.message}</div>
    if (loaded.state === 'tooLarge')
        return <div className={note}>{tr(`文件较大（${formatBytes(loaded.size)}），不预览`, `Large file (${formatBytes(loaded.size)}); not previewed`)}</div>
    const { sides } = loaded
    if (!sides.length)
        return <div className={note}>{tr('空文件', 'Empty file')}</div>
    if (kind === 'image' || kind === 'svg')
        return <ImageSides sides={sides} name={name} />
    if (kind === 'pdf')
        return <PdfSides sides={sides} name={name} />
    if (kind === 'video')
        return <VideoSides sides={sides} name={name} />
    return <AudioSides sides={sides} name={name} />
}
