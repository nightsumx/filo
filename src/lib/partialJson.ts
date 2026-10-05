/**
 * Best-effort parse of a JSON prefix streamed through toolcall_delta, so a tool row can show
 * `npm test` while the arguments are still arriving. Returns undefined when nothing usable parses.
 */
export function parsePartialJson(text: string): Record<string, unknown> | undefined {
    const stack: string[] = []
    let inString = false
    let escaped = false
    for (const ch of text) {
        if (inString) {
            if (escaped)
                escaped = false
            else if (ch === '\\')
                escaped = true
            else if (ch === '"')
                inString = false
            continue
        }
        if (ch === '"')
            inString = true
        else if (ch === '{' || ch === '[')
            stack.push(ch === '{' ? '}' : ']')
        else if (ch === '}' || ch === ']')
            stack.pop()
    }

    let candidate = text
    if (inString)
        candidate += escaped ? '\\"' : '"'
    // Drop a dangling separator or a key without a value before closing.
    candidate = candidate.replace(/,\s*$/, '').replace(/,?\s*"[^"]*"\s*:\s*$/, '')
    candidate += stack.reverse().join('')
    try {
        const value = JSON.parse(candidate)
        return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
    }
    catch {
        return undefined
    }
}
