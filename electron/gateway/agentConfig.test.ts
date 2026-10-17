import { describe, expect, it } from 'vitest'
import { BLOCK_END, BLOCK_START, grokBlock, withGrokBlock } from './agentConfig'

const groups: any[] = [{ id: '4g9qhv', name: '组 1', api: 'anthropic-messages' }]
const block = grokBlock(groups, 'http://127.0.0.1:1')

// What Grok saved after a Filo model was picked: the same table, unquoted, outside the block.
const saved = `[ui]
yolo = false

[models]
default = "grok-4.7"

[model.filo-4g9qhv]
model = "4g9qhv"
base_url = "http://127.0.0.1:62656/v1"

[marketplace]
auto = true
`

describe('Grok config with Filo\'s models', () => {
    it('keeps one table of each name, so Grok can read the file', () => {
        const next = withGrokBlock(`${saved}\n${BLOCK_START}\n${block}\n${BLOCK_END}\n`, block)
        expect(next.match(/filo-4g9qhv/g)).toHaveLength(1)
        expect(next).toContain('[model."filo-4g9qhv"]')
        expect(next).toContain('[models]\ndefault = "grok-4.7"')
        expect(next).toContain('[marketplace]\nauto = true')
    })

    it('is stable when applied again, and taking the block out takes the saved copy too', () => {
        const once = withGrokBlock(saved, block)
        expect(withGrokBlock(once, block)).toBe(once)
        const off = withGrokBlock(once, undefined)
        expect(off).not.toContain('filo-')
        expect(off).toContain('[ui]\nyolo = false')
        expect(off).toContain('[marketplace]')
    })

    it('leaves other model tables and a file without Filo alone', () => {
        const text = '[model.mine]\nmodel = "x"\n\n[[marketplace.sources]]\nname = "a"\n'
        expect(withGrokBlock(text, undefined)).toBe(text)
    })
})
