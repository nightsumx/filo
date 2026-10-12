import type { PiModel } from '@shared/pi'

export const modelKey = (m: { provider: string, id: string }) => `${m.provider}/${m.id}`

/** Lowercase letters and digits only: "claude-opus-5-5", "claude-opus-5.5" and "Opus 5.5" all hold "opus55". */
const squash = (s: string) => [...s.toLowerCase()].filter(c => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')).join('')

/** Opus 5.5 under any provider's naming; the fast variant is a different price, not the default. */
function isOpus55(model: PiModel) {
    return [model.id, model.name].some((s) => {
        const t = squash(s ?? '')
        return t.includes('opus55') && !t.includes('fast')
    })
}

/**
 * The model a new thread switches to once its agent has started: the one last chosen for that
 * agent (`remembered`, a modelKey) while it is still offered, else Opus 5.5. Undefined: the agent
 * already runs it, or offers neither, so it keeps its own pick.
 */
export function startModel(models: readonly PiModel[], current: PiModel | undefined, remembered: string | undefined): PiModel | undefined {
    const wanted = models.find(m => modelKey(m) === remembered)
        ?? (current && isOpus55(current) ? current : models.find(isOpus55))
    return wanted && (!current || modelKey(wanted) !== modelKey(current)) ? wanted : undefined
}
