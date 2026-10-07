import type { ApprovalMode } from '@shared/capabilities'
import { APPROVAL_MODES, CAPABILITIES, normalizeCapabilities } from '@shared/capabilities'
import path from 'node:path'

/** `-e` arguments for extensions the app's own features need (rewind), loaded whatever capabilities are on. */
export function hostExtensionArgs(extensionsDir: string): string[] {
    return ['-e', path.join(extensionsDir, 'rewind.ts')]
}

/**
 * `-e <file>` arguments loading the requested capabilities (unknown ids are dropped), plus the flags
 * they read: the approval mode a new session starts in.
 */
export function capabilityArgs(ids: unknown, extensionsDir: string, options: { approvalMode?: ApprovalMode } = {}): string[] {
    const wanted = new Set(normalizeCapabilities(ids))
    const args = CAPABILITIES.filter(c => wanted.has(c.id)).flatMap(c => ['-e', path.join(extensionsDir, c.entry)])
    if (wanted.has('approval') && options.approvalMode && APPROVAL_MODES.includes(options.approvalMode))
        args.push('--gui-approval', options.approvalMode)
    return args
}
