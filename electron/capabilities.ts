import { CAPABILITIES, normalizeCapabilities } from '@shared/capabilities'
import path from 'node:path'

/** `-e` arguments for extensions the app's own features need (pi's editor commands, rewind), loaded whatever capabilities are on. */
export function hostExtensionArgs(extensionsDir: string): string[] {
    return ['-e', path.join(extensionsDir, 'builtins.ts')]
}

/** `-e <file>` arguments loading the requested capabilities (unknown ids are dropped). */
export function capabilityArgs(ids: unknown, extensionsDir: string): string[] {
    const wanted = new Set(normalizeCapabilities(ids))
    return CAPABILITIES.filter(c => wanted.has(c.id)).flatMap(c => ['-e', path.join(extensionsDir, c.entry)])
}
