import type { PiEvent } from '@shared/pi'
import { buildTurns } from '../../src/lib/timeline'
import { describe, expect, it } from 'vitest'
import { AcpTranscript } from './transcript'

// Update shapes recorded from codex-acp 2.1.1 (a plain, non-AIR client).
const say = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const think = (text: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })
const listFiles = { sessionUpdate: 'tool_call', toolCallId: 'call_1', name: 'exec_command', kind: 'read', title: 'List files', status: 'in_progress' }
const listDone = { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed', rawOutput: { exit_code: 0 }, _meta: { terminal_output_delta: { data: 'seed.txt\n', terminal_id: 'call_1' } } }
const editFiles = {
    sessionUpdate: 'tool_call',
    toolCallId: 'call_2',
    kind: 'edit',
    title: 'Editing files',
    status: 'in_progress',
    content: [
        { type: 'diff', oldText: null, newText: 'hi\n', path: '/w/hello.txt', _meta: { kind: 'add' } },
        { type: 'diff', oldText: 'seed\n', newText: 'seeded\n', path: '/w/seed.txt', _meta: { kind: 'update' } },
    ],
}

function record() {
    const events: PiEvent[] = []
    let t = 1000
    const transcript = new AcpTranscript('s:', { emit: e => events.push(e), now: () => t++ })
    return { transcript, events }
}

describe('acpTranscript', () => {
    it('turns a run into pi messages: thinking + text, tools with results, edits per file', () => {
        const { transcript } = record()
        transcript.userPrompt('do it')
        for (const u of [think('Plan'), think(' first'), say('Listing.'), listFiles, listDone, editFiles, { sessionUpdate: 'tool_call_update', toolCallId: 'call_2', status: 'completed' }, say('Done.')])
            transcript.update(u)
        transcript.finish('end_turn', { inputTokens: 100, cachedReadTokens: 40, outputTokens: 7, thoughtTokens: 3, totalTokens: 107 })

        const messages = transcript.messages.map(m => m.message)
        expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant', 'toolResult', 'toolResult', 'assistant'])
        const first = messages[1] as any
        expect(first.content).toEqual([
            { type: 'thinking', thinking: 'Plan first' },
            { type: 'text', text: 'Listing.' },
            { type: 'toolCall', id: 'call_1', name: 'list', arguments: { description: 'List files' } },
        ])
        expect(first.stopReason).toBe('toolUse')
        expect(messages[2]).toMatchObject({ toolCallId: 'call_1', content: [{ type: 'text', text: 'seed.txt\n' }], isError: false })
        expect((messages[3] as any).content).toEqual([
            { type: 'toolCall', id: 'call_2', name: 'write', arguments: { path: '/w/hello.txt', content: 'hi\n' } },
            { type: 'toolCall', id: 'call_2#1', name: 'edit', arguments: { path: '/w/seed.txt', oldText: 'seed\n', newText: 'seeded\n' } },
        ])
        const last = messages[6] as any
        expect(last.content).toEqual([{ type: 'text', text: 'Done.' }])
        expect(last.stopReason).toBe('stop')
        expect(last.usage).toMatchObject({ input: 60, cacheRead: 40, output: 7, reasoning: 3, totalTokens: 107 })

        // The timeline pairs every call with its result.
        const turns = buildTurns(transcript.snapshot().map(i => ({ key: i.entryId, message: i.message, endedAt: i.endedAt })))
        expect(turns).toHaveLength(1)
        const tools = turns[0].steps.filter(s => s.kind === 'tool')
        expect(tools.map(s => s.kind === 'tool' && [s.call.name, !!s.result, s.running])).toEqual([['list', true, false], ['write', true, false], ['edit', true, false]])
    })

    it('streams pi events the renderer applies: message_start, deltas, toolcall_end, tool execution', () => {
        const { transcript, events } = record()
        transcript.userPrompt('go')
        transcript.update(say('Hel'))
        transcript.update(say('lo'))
        transcript.update({ sessionUpdate: 'tool_call', toolCallId: 'c', kind: 'execute', title: 'npm test', status: 'in_progress', rawInput: { command: ['npm', 'test'], cwd: '/w' } })
        transcript.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c', _meta: { terminal_output_delta: { data: 'ok\n' } } })
        transcript.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed', rawOutput: { exit_code: 1 } })
        transcript.finish('end_turn')

        const types = events.map(e => e.type === 'message_update' ? `update:${e.assistantMessageEvent.type}` : e.type)
        expect(types).toEqual([
            'message_start', // user
            'message_end',
            'message_start', // assistant
            'update:text_start',
            'update:text_delta',
            'update:text_delta',
            'update:text_end',
            'update:toolcall_end',
            'tool_execution_start',
            'tool_execution_update',
            'message_end', // assistant closes before its result
            'tool_execution_end',
            'message_start', // toolResult
            'message_end',
        ])
        const call = events.find(e => e.assistantMessageEvent?.type === 'toolcall_end')!.assistantMessageEvent.toolCall
        expect(call).toEqual({ type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'npm test' } })
        expect(events.find(e => e.type === 'tool_execution_end')).toMatchObject({ toolCallId: 'c', isError: true, result: { content: [{ type: 'text', text: 'ok\n' }] } })
    })

    it('replays a loaded session: user chunks become user messages, completed calls their results', () => {
        const { transcript } = record()
        transcript.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first ' } })
        transcript.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'prompt' } })
        transcript.update({ ...listFiles, status: 'completed' })
        transcript.update({ ...listDone, status: undefined })
        transcript.update(say('Answer'))
        transcript.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'second' } })
        transcript.update(say('Again'))
        transcript.finish('end_turn')

        const messages = transcript.messages.map(m => m.message)
        expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant', 'user', 'assistant'])
        expect((messages[0] as any).content).toEqual([{ type: 'text', text: 'first prompt' }])
        // A replayed call is announced completed; its output follows in the next update.
        expect(messages[2]).toMatchObject({ toolCallId: 'call_1', isError: false, content: [{ type: 'text', text: 'seed.txt\n' }] })
        expect(transcript.snapshot().map(i => i.entryId)).toEqual(['s:0', 's:1', 's:2', 's:3', 's:4', 's:5'])
    })

    it('a plan update is a todo call carrying the whole list', () => {
        const { transcript } = record()
        transcript.userPrompt('plan it')
        transcript.update({ sessionUpdate: 'plan', entries: [{ content: 'Read', status: 'completed', priority: 'high' }, { content: 'Write', status: 'in_progress', priority: 'high' }, { content: 'Test', status: 'pending', priority: 'low' }] })
        transcript.finish('end_turn')
        const result = transcript.messages.map(m => m.message).find(m => m.role === 'toolResult') as any
        expect(result.toolName).toBe('todo')
        expect(result.details).toEqual({ kind: 'todo', items: [{ text: 'Read', status: 'done' }, { text: 'Write', status: 'in_progress' }, { text: 'Test', status: 'pending' }] })
    })

    it('cancel ends unfinished calls and marks the run aborted', () => {
        const { transcript } = record()
        transcript.userPrompt('long')
        transcript.update({ sessionUpdate: 'tool_call', toolCallId: 'x', kind: 'execute', title: 'sleep 100', status: 'in_progress' })
        transcript.finish('cancelled')
        const messages = transcript.messages.map(m => m.message) as any[]
        expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
        expect(messages[2]).toMatchObject({ toolCallId: 'x', isError: true, content: [{ type: 'text', text: 'Interrupted' }] })
        expect(messages[3].stopReason).toBe('aborted')
        expect(transcript.running).toBe(false)
    })

    it('a failed prompt shows as an error message', () => {
        const { transcript } = record()
        transcript.userPrompt('hi')
        transcript.finish(undefined, undefined, 'Reconnecting... high demand')
        const last = transcript.messages.at(-1)!.message as any
        expect(last).toMatchObject({ role: 'assistant', stopReason: 'error', errorMessage: 'Reconnecting... high demand' })
    })
})
