// File tree colours from git status, as in WebStorm: changed files blue, new ones green, conflicts
// amber, and every folder on the way to a change blue too.

export type FileMark = 'modified' | 'added' | 'conflict'

/** One porcelain XY status as a mark; deletions have no row in the tree, so none. */
export function markOf(status: string): FileMark | null {
    const [x, y] = [status[0] ?? ' ', status[1] ?? ' ']
    if (x === 'U' || y === 'U' || status === 'AA' || status === 'DD')
        return 'conflict'
    if (status === '??' || x === 'A')
        return 'added'
    if (x === 'D' && y === ' ')
        return null
    return 'modified'
}

/**
 * Absolute path → mark for a repository's changes. `root` is the repository root, `paths` are
 * relative to it with "/" separators (git's form), `sep` is the OS's separator. Folders between a
 * change and the root are marked modified (a deleted file marks its folder too).
 */
export function fileMarks(root: string, files: readonly { path: string, status: string }[], sep = '/'): Map<string, FileMark> {
    const marks = new Map<string, FileMark>()
    const base = root.endsWith(sep) ? root.slice(0, -1) : root
    for (const file of files) {
        const parts = file.path.split('/').filter(Boolean)
        const mark = markOf(file.status)
        if (mark && parts.length)
            marks.set(base + sep + parts.join(sep), mark)
        let dir = base
        for (const part of parts.slice(0, -1)) {
            dir = dir + sep + part
            if (!marks.has(dir))
                marks.set(dir, 'modified')
        }
    }
    return marks
}
