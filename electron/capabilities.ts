import { CAPABILITIES, normalizeCapabilities } from '@shared/capabilities'
import path from 'node:path'

/** `-e <file>` arguments loading the requested capabilities; unknown ids are dropped. */
export function capabilityArgs(ids: unknown, extensionsDir: string): string[] {
    const wanted = new Set(normalizeCapabilities(ids))
    return CAPABILITIES.filter(c => wanted.has(c.id)).flatMap(c => ['-e', path.join(extensionsDir, c.entry)])
}
