import { describe, expect, it } from 'vitest'
import { elicitContent, elicitForm, parseCodexApps } from './codex'

describe('MCP elicitation forms', () => {
    const schema = {
        type: 'object',
        properties: {
            tags: { type: 'array', title: 'Tags', items: { anyOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] } },
            size: { type: 'string', title: 'Size', oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Large' }] },
            legacy: { type: 'string', enum: ['x', 'y'], enumNames: ['Ex', 'Why'] },
            ratio: { type: 'number', title: 'Ratio' },
        },
        required: ['size'],
    }

    it('shows titled choices, multi-select and legacy enum names; required first, with the message', () => {
        const { questions } = elicitForm('Set it up', schema)
        expect(questions.map(q => q.id)).toEqual(['size', 'tags', 'legacy', 'ratio'])
        expect(questions[0]).toEqual({ id: 'size', question: 'Set it up · Size', options: ['Small', 'Large'] })
        expect(questions[1]).toMatchObject({ id: 'tags', options: ['Alpha', 'Beta'], multiple: true })
        expect(questions[2]).toMatchObject({ options: ['Ex', 'Why'] })
        expect(questions[3].options).toEqual([])
    })

    it('sends the values behind the labels, typed; a typed non-number is refused', () => {
        const { fields } = elicitForm('', schema)
        expect(elicitContent(fields, {
            size: { selected: ['Large'] },
            tags: { selected: ['Alpha', 'Beta'] },
            legacy: { selected: ['Why'] },
            ratio: { selected: [], text: '0.5' },
        })).toEqual({ size: 'l', tags: ['a', 'b'], legacy: 'y', ratio: 0.5 })
        // Left out: not sent.
        expect(elicitContent(fields, { size: { selected: ['Small'] } })).toEqual({ size: 's' })
        expect(elicitContent(fields, { ratio: { selected: [], text: 'half' } })).toBeUndefined()
    })
})

describe('parseCodexApps', () => {
    it('reads the apps app/list returns: off only when config says so, name falling back to the id', () => {
        expect(parseCodexApps([
            { id: 'connector_a', name: 'Calendar', description: 'Your events', isAccessible: true, isEnabled: true },
            { id: 'connector_b', name: '', description: null, isAccessible: false, isEnabled: false },
            { id: 'connector_c', name: 'Mail' },
            { name: 'no id' },
            'junk',
        ])).toEqual([
            { id: 'connector_a', name: 'Calendar', description: 'Your events', accessible: true, enabled: true },
            { id: 'connector_b', name: 'connector_b', description: '', accessible: false, enabled: false },
            { id: 'connector_c', name: 'Mail', description: '', accessible: false, enabled: true },
        ])
        expect(parseCodexApps(undefined)).toEqual([])
    })
})
