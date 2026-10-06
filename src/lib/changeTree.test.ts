import type { GitFileChange } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import { buildChangeTree, dirPaths } from './changeTree'

const change = (path: string, additions = 1, deletions = 0): GitFileChange => ({ path, status: ' M', additions, deletions, binary: false })

/** Tree as indented lines: folders end with "/" and carry their totals. */
function outline(nodes: ReturnType<typeof buildChangeTree>, depth = 0): string[] {
    return nodes.flatMap(n => n.kind === 'dir'
        ? [`${'  '.repeat(depth)}${n.name}/ ${n.count} +${n.additions} -${n.deletions}`, ...outline(n.children, depth + 1)]
        : [`${'  '.repeat(depth)}${n.name}`])
}

describe('buildChangeTree', () => {
    it('groups by folder, folders before files, and sums each folder', () => {
        const tree = buildChangeTree([
            change('README.md', 2),
            change('src/store/app.ts', 10, 3),
            change('src/App.tsx', 1, 1),
            change('src/store/thread.ts', 4),
            change('electron/main.ts', 5, 5),
            change('electron/windows.ts', 7),
        ])
        expect(outline(tree)).toEqual([
            'electron/ 2 +12 -5',
            '  main.ts',
            '  windows.ts',
            'src/ 3 +15 -4',
            '  store/ 2 +14 -3',
            '    app.ts',
            '    thread.ts',
            '  App.tsx',
            'README.md',
        ])
    })

    it('joins chains of single-child folders into one row', () => {
        const tree = buildChangeTree([change('src/features/Review/index.tsx'), change('src/features/Review/tree.tsx'), change('src/lib/a.ts')])
        expect(outline(tree)).toEqual([
            'src/ 3 +3 -0',
            '  features/Review/ 2 +2 -0',
            '    index.tsx',
            '    tree.tsx',
            '  lib/ 1 +1 -0',
            '    a.ts',
        ])
        expect(dirPaths(tree)).toEqual(['src', 'src/features/Review', 'src/lib'])
    })

    it('a lone deep file sits under one joined folder row', () => {
        expect(outline(buildChangeTree([change('a/b/c/d.ts')]))).toEqual(['a/b/c/ 1 +1 -0', '  d.ts'])
    })
})
