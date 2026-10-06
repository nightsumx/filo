import type { FileEditor, RepoEdits } from '@shared/ipc'

export interface Conflict {
    /** Path relative to the repository root. */
    file: string
    /** The other sessions that changed it, latest first. */
    others: FileEditor[]
}

/** Uncommitted files this session edited. */
export function editedBy(files: RepoEdits['files'] | undefined, session: string | undefined): Set<string> {
    const own = new Set<string>()
    if (!files || !session)
        return own
    for (const [file, editors] of Object.entries(files)) {
        if (editors.some(e => e.session === session))
            own.add(file)
    }
    return own
}

/** Files this session edited that another session edited too since the last commit. */
export function conflictsOf(files: RepoEdits['files'] | undefined, session: string | undefined): Conflict[] {
    if (!files || !session)
        return []
    const conflicts: Conflict[] = []
    for (const [file, editors] of Object.entries(files)) {
        if (!editors.some(e => e.session === session))
            continue
        const others = editors.filter(e => e.session !== session)
        if (others.length)
            conflicts.push({ file, others })
    }
    return conflicts.sort((a, b) => a.file.localeCompare(b.file))
}
