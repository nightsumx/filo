import type { ReviewDetails, SubagentDetails } from '@shared/capabilities'
import { describe, expect, it } from 'vitest'
import { branchFacts, buildReport, evidenceOf, exitCodeOf, feedbackText, matchEvidence, parseApplyArgs, reviewerTask } from '../packages/capabilities/lib/review'

const user = (text: string) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } })
const assistant = (text: string, calls: { name: string, arguments: object }[] = []) => ({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET REASONING' }, ...(text ? [{ type: 'text', text }] : []), ...calls.map((c, i) => ({ type: 'toolCall', id: `c${i}`, ...c }))] },
})
const run = { kind: 'subagent', status: 'done', title: 'Review', task: '', messages: [], tools: {}, steering: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, startedAt: 1, endedAt: 2 } as unknown as SubagentDetails
const changes = { scope: 'thread' as const, files: ['a.ts'], diff: '+x', unshown: [] }

describe('branchFacts', () => {
    it('collects requests, final replies and edited files, never the reasoning', () => {
        const facts = branchFacts([
            user('add a flag'),
            assistant('', [{ name: 'edit', arguments: { path: 'src/a.ts' } }, { name: 'read', arguments: { path: 'b.ts' } }]),
            assistant('Added the flag.', [{ name: 'write', arguments: { path: '/abs/c.ts' } }]),
            assistant('All tests pass.'),
            user('thanks'),
        ], '/repo')
        expect(facts.requests).toEqual(['add a flag', 'thanks'])
        expect(facts.claims).toEqual(['All tests pass.'])
        expect(facts.files).toEqual(['/repo/src/a.ts', '/abs/c.ts'])
        expect(facts.round).toBe(1)
        expect(JSON.stringify(facts)).not.toContain('SECRET')
    })

    it('keeps the first and latest messages within the budget', () => {
        const facts = branchFacts(Array.from({ length: 40 }, (_, i) => user(`${i} ${'x'.repeat(2000)}`)), '/repo')
        expect(facts.requests[0].startsWith('0 ')).toBe(true)
        expect(facts.requests[1]).toMatch(/earlier messages omitted/)
        expect(facts.requests.at(-1)!.startsWith('39 ')).toBe(true)
    })

    it('a later round knows what was sent back and how the agent answered', () => {
        const report = { kind: 'review', id: 'rv-1', round: 1, status: 'done', issues: [{ id: 'R1', title: 'Off by one' }], suggestions: [{ id: 'S1', title: 'Add a test' }] }
        const facts = branchFacts([
            user('go'),
            assistant('done'),
            { type: 'custom', customType: 'pi-kit-review', data: { ...report, status: 'failed', id: 'rv-0' } },
            { type: 'custom', customType: 'pi-kit-review', data: report },
            { type: 'custom_message', customType: 'pi-kit-review-feedback', content: 'x', details: { reviewId: 'rv-1', items: ['R1'], note: 'quick' } },
            assistant('Fixed R1 by clamping.'),
            { type: 'message', message: { role: 'custom', customType: 'pi-kit-review-feedback', content: 'x', details: { reviewId: 'rv-1', items: ['S1'] } } },
            assistant('Added the test.'),
        ], '/repo')
        expect(facts.round).toBe(2)
        expect(facts.previous!.sent).toEqual([{ id: 'R1', title: 'Off by one' }, { id: 'S1', title: 'Add a test' }])
        expect(facts.previous!.note).toBe('quick')
        expect(facts.previous!.replies).toEqual(['Fixed R1 by clamping.', 'Added the test.'])
        expect(reviewerTask(facts, changes)).toContain('R1: Off by one')
    })

    it('no previous section when nothing was sent back', () => {
        const facts = branchFacts([user('go'), { type: 'custom', customType: 'pi-kit-review', data: { kind: 'review', id: 'rv-1', round: 1, status: 'done', issues: [], suggestions: [] } }], '/repo')
        expect(facts.round).toBe(2)
        expect(facts.previous).toBeUndefined()
        expect(reviewerTask(facts, changes)).not.toContain('Previous review')
    })
})

describe('evidence', () => {
    it('reads the exit code from structured content, then the error text', () => {
        expect(exitCodeOf({ structuredContent: { exit_code: 2 } }, true)).toBe(2)
        expect(exitCodeOf({ content: [{ type: 'text', text: 'boom\n\nCommand exited with code 7' }] }, true)).toBe(7)
        expect(exitCodeOf({ content: [{ type: 'text', text: 'ok' }] }, false)).toBe(0)
        expect(exitCodeOf({ content: [{ type: 'text', text: 'Command timed out' }] }, true)).toBeUndefined()
    })

    it('keeps the tail of long output', () => {
        const e = evidenceOf('x', { content: [{ type: 'text', text: `${'a'.repeat(5000)}END` }] }, false)
        expect(e.output.endsWith('END')).toBe(true)
        expect(e.output.length).toBeLessThan(1600)
    })

    it('matches a repro by the command, whitespace aside, or inside a longer one', () => {
        const commands = [{ command: 'npm test', exitCode: 0, output: '' }, { command: 'cd pkg && npm   test', exitCode: 1, output: '' }]
        expect(matchEvidence('npm  test', commands)?.exitCode).toBe(0)
        expect(matchEvidence('cd pkg && npm test', commands)?.exitCode).toBe(1)
        expect(matchEvidence('npm run build', commands)).toBeUndefined()
        expect(matchEvidence(undefined, commands)).toBeUndefined()
    })
})

describe('buildReport and feedback', () => {
    const report = buildReport({ id: 'rv-1', round: 1, changes, commands: [{ command: 'node t.js', exitCode: 1, output: 'AssertionError' }], run }, {
        verdict: 'needs_work',
        summary: 's',
        issues: [
            { title: 'Breaks t', severity: 'high', file: 'a.ts', line: 3, detail: 'd', fix: 'f', repro: 'node t.js' },
            { title: 'Maybe slow', severity: 'low', detail: 'd2', line: 0 },
        ],
        suggestions: [{ title: 'Add a test', detail: 'd3' }],
    })

    it('numbers items and lets runtime evidence decide confirmed vs suspected', () => {
        expect(report.issues.map(i => [i.id, i.status, i.line])).toEqual([['R1', 'confirmed', 3], ['R2', 'suspected', undefined]])
        expect(report.issues[0].evidence?.output).toBe('AssertionError')
        expect(report.suggestions[0].id).toBe('S1')
    })

    it('no submission is a failed report', () => {
        const failed = buildReport({ id: 'rv-2', round: 1, changes, commands: [], run }, undefined)
        expect(failed).toMatchObject({ status: 'failed', issues: [] })
        expect(failed.error).toMatch(/without submitting/)
    })

    it('feedback carries the picked items with evidence and the note', () => {
        const text = feedbackText(report as ReviewDetails, { items: ['R1', 'S1'], note: 'go' })
        expect(text).toContain('### R1 [confirmed, high] Breaks t')
        expect(text).toContain('Where: a.ts:3')
        expect(text).toContain('`node t.js`, which exited with 1')
        expect(text).toContain('### S1 [suggestion] Add a test')
        expect(text).not.toContain('Maybe slow')
        expect(text).toContain('The user adds: go')
    })

    it('terminal apply args: ids and a note; no ids sends every issue', () => {
        expect(parseApplyArgs('r1 s1 do it carefully', report as ReviewDetails)).toEqual({ items: ['R1', 'S1'], note: 'do it carefully' })
        expect(parseApplyArgs('', report as ReviewDetails)).toEqual({ items: ['R1', 'R2'] })
    })
})
