import type { ImageContent } from '@shared/pi'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useState } from 'react'

const src = (img: ImageContent) => `data:${img.mimeType};base64,${img.data}`

/**
 * A thumbnail that opens its image full-window on click. `images` is the group the thumbnail
 * belongs to (one message's attachments, one tool result), so ←/→ step through its siblings.
 */
export function ImageThumb({ images, index, alt, className }: { images: ImageContent[], index: number, alt: string, className?: string }) {
    const [open, setOpen] = useState<number | null>(null)
    return (
        <>
            <button
                type="button"
                aria-label={tr('查看大图', 'View full size')}
                onClick={() => setOpen(index)}
                className="block w-fit max-w-full cursor-zoom-in rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ide-accent/50"
            >
                <img src={src(images[index])} alt={alt} className={className} draggable={false} />
            </button>
            {open !== null && <ImageLightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
        </>
    )
}

function ImageLightbox({ images, index, onIndex, onClose }: { images: ImageContent[], index: number, onIndex: (i: number) => void, onClose: () => void }) {
    // Fit to the window first; clicking the image shows it at its natural size and scrolls.
    const [actual, setActual] = useState(false)
    const [natural, setNatural] = useState({ w: 0, h: 0 })
    const many = images.length > 1
    const step = (d: number) => {
        setActual(false)
        onIndex((index + d + images.length) % images.length)
    }
    // Zooming only means something when the fitted image is smaller than the file.
    const zoomable = natural.w > window.innerWidth - 96 || natural.h > window.innerHeight - 96
    return (
        <DialogPrimitive.Root open onOpenChange={o => !o && onClose()}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-always-black/85 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
                <DialogPrimitive.Content
                    aria-describedby={undefined}
                    // Sits over the frameless title bar, so it must not drag the window.
                    className="app-no-drag fixed inset-0 z-50 outline-none"
                    onKeyDown={(e) => {
                        if (!many)
                            return
                        if (e.key === 'ArrowLeft')
                            step(-1)
                        else if (e.key === 'ArrowRight')
                            step(1)
                    }}
                >
                    <DialogPrimitive.Title className="sr-only">{tr('图片', 'Image')} {index + 1} / {images.length}</DialogPrimitive.Title>
                    <div
                        className={cn('absolute inset-0', actual ? 'overflow-auto' : 'flex items-center justify-center p-12')}
                        onClick={e => e.target === e.currentTarget && onClose()}
                    >
                        <img
                            key={index}
                            src={src(images[index])}
                            alt=""
                            draggable={false}
                            onLoad={e => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                            onClick={() => zoomable ? setActual(a => !a) : onClose()}
                            className={cn(
                                'select-none',
                                actual ? 'm-auto block max-w-none cursor-zoom-out' : 'max-h-full max-w-full object-contain',
                                !actual && (zoomable ? 'cursor-zoom-in' : 'cursor-default'),
                            )}
                        />
                    </div>
                    {many && (
                        <>
                            <NavBtn side="left" label={tr('上一张', 'Previous')} onClick={() => step(-1)} />
                            <NavBtn side="right" label={tr('下一张', 'Next')} onClick={() => step(1)} />
                            <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded bg-always-black/50 px-2 py-0.5 text-[12px] tabular-nums text-always-white/80">
                                {index + 1} / {images.length}
                            </div>
                        </>
                    )}
                    <DialogPrimitive.Close
                        aria-label={tr('关闭', 'Close')}
                        className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-md bg-always-black/40 text-always-white/80 hover:bg-always-black/60 hover:text-always-white focus:outline-none focus-visible:ring-2 focus-visible:ring-always-white/40"
                    >
                        <X size={16} />
                    </DialogPrimitive.Close>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    )
}

function NavBtn({ side, label, onClick }: { side: 'left' | 'right', label: string, onClick: () => void }) {
    const Icon = side === 'left' ? ChevronLeft : ChevronRight
    return (
        <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={cn(
                'absolute top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md bg-always-black/40 text-always-white/80 hover:bg-always-black/60 hover:text-always-white focus:outline-none focus-visible:ring-2 focus-visible:ring-always-white/40',
                side === 'left' ? 'left-3' : 'right-3',
            )}
        >
            <Icon size={18} />
        </button>
    )
}
