export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** pi-ai's getSupportedThinkingLevels (not importable here: neither package depends on pi-ai). */
export function thinkingLevels(model: any): (typeof THINKING_LEVELS)[number][] {
    if (!model)
        return [...THINKING_LEVELS]
    if (!model.reasoning)
        return ['off']
    return THINKING_LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level]
        if (mapped === null)
            return false
        return level === 'xhigh' || level === 'max' ? mapped !== undefined : true
    })
}
