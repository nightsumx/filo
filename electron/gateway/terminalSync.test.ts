import { describe, expect, it } from 'vitest'
import { BLOCK_START } from './agentConfig'
import { applyJson, claudeEdits, CODEX_SET_ASIDE, codexToml, restoreJson } from './terminalSync'

describe('json keys', () => {
    it('sets keys, and restores exactly what was there, parents included', () => {
        const original = '{\n    "model": "opus",\n    "env": {\n        "ANTHROPIC_API_KEY": "sk-user"\n    }\n}\n'
        const { text, stash } = applyJson(original, claudeEdits('http://127.0.0.1:1', 'tok'))
        expect(JSON.parse(text)).toEqual({ model: 'opus', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'tok' } })
        expect(text).toContain('\n    "model"')
        expect(restoreJson(text, stash)).toBe(original)

        const bare = '{\n  "model": "opus"\n}\n'
        const applied = applyJson(bare, claudeEdits('http://127.0.0.1:1', 'tok'))
        expect(restoreJson(applied.text, applied.stash)).toBe(bare)
        expect(applyJson('', claudeEdits('o', 't')).text).toContain('"ANTHROPIC_AUTH_TOKEN": "t"')
        // No newline at the end stays so.
        const tight = '{\n  "model": "opus"\n}'
        const again = applyJson(tight, claudeEdits('o', 't'))
        expect(again.text.endsWith('}')).toBe(true)
        expect(restoreJson(again.text, again.stash)).toBe(tight)
    })

    it('keeps the first `before` when applied again, and leaves values someone changed since', () => {
        const original = '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://relay.example"\n  }\n}\n'
        const first = applyJson(original, claudeEdits('http://127.0.0.1:1', 'tok'))
        const again = applyJson(first.text, claudeEdits('http://127.0.0.1:2', 'tok'), first.stash)
        expect(again.stash[0].before).toBe('https://relay.example')
        expect(restoreJson(again.text, again.stash)).toBe(original)

        // The user pointed it elsewhere meanwhile: that stays; the token the app set still goes.
        const edited = JSON.parse(again.text)
        edited.env.ANTHROPIC_BASE_URL = 'https://other.example'
        const restored = JSON.parse(restoreJson(JSON.stringify(edited), again.stash))
        expect(restored.env).toEqual({ ANTHROPIC_BASE_URL: 'https://other.example' })
    })

    it('refuses a file that is not a JSON object rather than overwrite it', () => {
        expect(() => applyJson('{ broken', claudeEdits('o', 't'))).toThrow()
        expect(() => applyJson('[1]', claudeEdits('o', 't'))).toThrow()
    })
})

describe('codex config.toml', () => {
    const user = 'model = "gpt-5"\nmodel_provider = "openai"\n\n[model_providers.other]\nname = "x"\nmodel_provider = "not top level"\n'

    it('puts the provider at the top and sets the user\'s own aside, then undoes both', () => {
        const routed = codexToml(user, 'http://127.0.0.1:9', 'tok')
        expect(routed.startsWith(BLOCK_START)).toBe(true)
        expect(routed).toContain('model_provider = "filo"\nmodel_providers.filo = { name = "Filo", base_url = "http://127.0.0.1:9/v1", wire_api = "responses", experimental_bearer_token = "tok" }')
        expect(routed).toContain(`${CODEX_SET_ASIDE}model_provider = "openai"`)
        expect(routed).toContain('\nmodel_provider = "not top level"')
        expect(codexToml(routed)).toBe(user)
        // Applied again (another port), still one block and one set-aside line.
        const again = codexToml(routed, 'http://127.0.0.1:10', 'tok')
        expect(again.split(BLOCK_START)).toHaveLength(2)
        expect(again.split(CODEX_SET_ASIDE)).toHaveLength(2)
        expect(codexToml(again)).toBe(user)
    })

    it('handles an empty or missing file', () => {
        const routed = codexToml('', 'http://127.0.0.1:9', 'tok')
        expect(routed.startsWith(BLOCK_START)).toBe(true)
        expect(codexToml(routed)).toBe('')
        expect(codexToml('\nmodel = "x"\n', 'o', 't').endsWith('\n\nmodel = "x"\n')).toBe(true)
        expect(codexToml(codexToml('\nmodel = "x"\n', 'o', 't'))).toBe('\nmodel = "x"\n')
    })
})
