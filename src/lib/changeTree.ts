import type { GitFileChange } from '@shared/ipc'

export interface ChangeDir {
    kind: 'dir'
    /** Display name; a chain of single-child folders shows as one row ("src/features/Review"), as in JetBrains. */
    name: string
    /** Full path from the repository root, without a trailing slash. */
    path: string
    children: ChangeNode[]
    additions: number
    deletions: number
    /** Changed files anywhere below. */
    count: number
}

export interface ChangeFile {
    kind: 'file'
    name: string
    file: GitFileChange
}

export type ChangeNode = ChangeDir | ChangeFile

/** Folders first, then files, each by name; JetBrains' Commit tree order. */
function sortNodes(nodes: ChangeNode[]) {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
}

/** Changed files grouped into a folder tree. Returns the root's children. */
export function buildChangeTree(files: readonly GitFileChange[]): ChangeNode[] {
    const root: ChangeDir = { kind: 'dir', name: '', path: '', children: [], additions: 0, deletions: 0, count: 0 }
    for (const file of files) {
        const parts = file.path.split('/')
        let dir = root
        for (const part of parts.slice(0, -1)) {
            dir.additions += file.additions
            dir.deletions += file.deletions
            dir.count++
            const path = dir.path ? `${dir.path}/${part}` : part
            let next = dir.children.find((n): n is ChangeDir => n.kind === 'dir' && n.path === path)
            if (!next) {
                next = { kind: 'dir', name: part, path, children: [], additions: 0, deletions: 0, count: 0 }
                dir.children.push(next)
            }
            dir = next
        }
        dir.additions += file.additions
        dir.deletions += file.deletions
        dir.count++
        dir.children.push({ kind: 'file', name: parts[parts.length - 1], file })
    }
    const compact = (node: ChangeNode): ChangeNode => {
        if (node.kind === 'file')
            return node
        let dir = node
        while (dir.children.length === 1 && dir.children[0].kind === 'dir') {
            const only: ChangeDir = dir.children[0]
            dir = { ...only, name: `${dir.name}/${only.name}` }
        }
        const children = dir.children.map(compact)
        sortNodes(children)
        return { ...dir, children }
    }
    const top = root.children.map(compact)
    sortNodes(top)
    return top
}

/** Every folder path in the tree, for "expand all". */
export function dirPaths(nodes: readonly ChangeNode[]): string[] {
    return nodes.flatMap(n => (n.kind === 'dir' ? [n.path, ...dirPaths(n.children)] : []))
}
