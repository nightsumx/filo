// File type icons for the file tree and editor tabs: a few kinds, all in the muted icon colour.
import { cn } from '@/lib/utils'
import { File, FileCode, FileImage, FileJson, FileText } from 'lucide-react'

const CODE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'zsh', 'bash', 'lua', 'vue', 'svelte', 'html', 'css', 'scss', 'less', 'sql', 'yaml', 'yml', 'toml', 'xml'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'heic'])
const TEXT = new Set(['md', 'mdx', 'txt', 'rst', 'log'])

export function FileIcon({ name, className }: { name: string, className?: string }) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
    const Icon = ext === 'json' || ext === 'jsonl' ? FileJson : CODE.has(ext) ? FileCode : IMAGE.has(ext) ? FileImage : TEXT.has(ext) ? FileText : File
    return <Icon size={14} className={cn('shrink-0 text-gray-500', className)} aria-hidden />
}
