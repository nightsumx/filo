import { describe, expect, it } from 'vitest'
import { ACP_AGENTS, acpCaps, acpSessionKey, agentFeatures, parseAcpSessionKey } from './agents'

describe('acpCaps', () => {
    it('reads what the agent can do from initialize', () => {
        // codex-acp 2.1.1.
        expect(acpCaps({ agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { list: {}, fork: {}, delete: {} } }, _meta: { steering: { supported: true } } }))
            .toEqual({ images: true, steering: true, fork: true, delete: true, list: true, xai: false })
        // Grok Build 1.0.46: fork, delete and steering are x.ai extensions, announced by _meta.grokShell.
        const grok = { agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true }, sessionCapabilities: { list: {}, resume: {}, close: {} } }, _meta: { grokShell: true, agentVersion: '1.0.46' } }
        expect(acpCaps(grok)).toEqual({ images: false, steering: true, fork: true, delete: true, list: true, xai: true })
        expect(acpCaps({ ...grok, _meta: {} })).toEqual({ images: false, steering: false, fork: false, delete: false, list: true, xai: false })
        expect(acpCaps(undefined)).toEqual({ images: false, steering: false, fork: false, delete: false, list: false, xai: false })
    })
})

describe('agentFeatures', () => {
    it('keeps pi-only features to pi; ACP ones follow the agent', () => {
        expect(agentFeatures('pi')).toMatchObject({ capabilities: true, compaction: true, autoCompaction: true, fork: true, forkSession: false, images: true, configOptions: false })
        const caps = { images: false, steering: false, fork: true, delete: false, list: true, xai: true }
        expect(agentFeatures('grok', caps, [{ name: 'compact' }])).toMatchObject({ capabilities: false, compaction: true, autoCompaction: false, fork: false, forkSession: true, images: false, configOptions: true })
        expect(agentFeatures('codex', caps, [{ name: 'review' }]).compaction).toBe(false)
        // Unknown yet (agent not started): images allowed, fork not offered.
        expect(agentFeatures('codex')).toMatchObject({ images: true, forkSession: false })
    })
})

describe('acp session keys', () => {
    it('round-trips every agent', () => {
        for (const spec of ACP_AGENTS)
            expect(parseAcpSessionKey(acpSessionKey(spec.id, 'ses:1'))).toEqual({ agent: spec.id, sessionId: 'ses:1' })
        expect(parseAcpSessionKey('acp:nobody:1')).toBeNull()
    })

    it('every agent can be found or installed', () => {
        for (const spec of ACP_AGENTS)
            expect(spec.npm || spec.archive, spec.id).toBeTruthy()
    })
})
