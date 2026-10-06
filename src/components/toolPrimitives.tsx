// DiffBlock copied from chat/src/skills/toolPrimitives.tsx; used by the review panel.
// langOf now comes from lib/toolMeta (highlight.js ids instead of Monaco ids).
import { generateDiffFile } from '@git-diff-view/file'
import { highlighter } from '@git-diff-view/lowlight'
import { DiffModeEnum, DiffView } from '@git-diff-view/react'
import { theme } from '@/lib/theme'
import { langOf } from '@/lib/toolMeta'
import { observer } from 'mobx-react-lite'
import { useMemo } from 'react'
import '@git-diff-view/react/styles/diff-view.css'

// observer() also memoizes; it re-renders when the theme flips.
export const DiffBlock = observer(({ path, oldStr, newStr, mode = 'unified', highlight = true }: { path: string, oldStr: string, newStr: string, mode?: 'unified' | 'split', highlight?: boolean }) => {
    const file = useMemo(() => {
        const lang = langOf(path)
        const diff = generateDiffFile(path || 'a', oldStr, path || 'a', newStr, lang, lang)
        diff.initRaw()
        return diff
    }, [path, oldStr, newStr])
    return (
        <div className="overflow-hidden rounded-md bg-ide-block text-[12px] select-text [&_.diff-table-wrapper]:!bg-transparent">
            <DiffView
                diffFile={file}
                diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
                diffViewTheme={theme.dark ? 'dark' : 'light'}
                diffViewHighlight={highlight}
                diffViewWrap
                diffViewFontSize={12}
                registerHighlighter={highlighter}
            />
        </div>
    )
})
