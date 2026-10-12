import { describe, expect, it } from 'vitest'
import { startModel } from './startModel'

const m = (provider: string, id: string, name = id) => ({ provider, id, name })
const sonnet = m('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5')
const opus = m('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5')
const opusFast = m('anthropic', 'claude-opus-5.5-fast', 'Claude Opus 5.5 Fast')
const gpt = m('openai', 'gpt-5.5', 'GPT-5.5')

describe('startModel', () => {
    it('switches to the model last chosen for the agent while it is offered', () => {
        expect(startModel([sonnet, opus, gpt], opus, 'openai/gpt-5.5')).toBe(gpt)
        expect(startModel([sonnet, opus, gpt], gpt, 'openai/gpt-5.5')).toBeUndefined()
    })

    it('falls back to Opus 5.5, not its fast variant, when nothing usable is remembered', () => {
        expect(startModel([opusFast, sonnet, opus], sonnet, undefined)).toBe(opus)
        expect(startModel([opusFast, sonnet, opus], sonnet, 'openai/gpt-5.5')).toBe(opus)
        // ACP agents name models their own way (Claude Code: "opus" / "Opus 5.5").
        expect(startModel([m('Claude Code', 'default', 'Default'), m('Claude Code', 'opus', 'Opus 5.5')], undefined, undefined)?.id).toBe('opus')
    })

    it('keeps the agent on its own pick when it already runs Opus 5.5 or offers no Opus 5.5', () => {
        const bedrock = m('amazon-bedrock', 'anthropic.claude-opus-5-5-v1')
        expect(startModel([opus, bedrock], bedrock, undefined)).toBeUndefined()
        expect(startModel([sonnet, gpt], sonnet, undefined)).toBeUndefined()
        expect(startModel([], undefined, 'openai/gpt-5.5')).toBeUndefined()
    })
})
