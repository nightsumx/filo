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

    // Shapes recorded from claude-agent-acp 0.86.0: the call is announced empty, its arguments and
    // diff come in an update, and a command's content is its description until the output replaces it.
    it('reads Claude Code calls: late arguments, fenced command output, Anthropic-style usage', () => {
        const { transcript, events } = record()
        transcript.userPrompt('please edit files')
        const meta = (toolName: string) => ({ claudeCode: { toolName } })
        for (const u of [
            think('I should look first.'),
            { _meta: meta('Bash'), toolCallId: 'toolu_1', sessionUpdate: 'tool_call', name: 'Bash', rawInput: {}, status: 'pending', title: 'Terminal', kind: 'execute', content: [] },
            { _meta: meta('Bash'), toolCallId: 'toolu_1', sessionUpdate: 'tool_call_update', rawInput: { command: 'ls', description: 'List files' }, title: 'ls', content: [{ type: 'content', content: { type: 'text', text: 'List files' } }] },
            { _meta: meta('Edit'), toolCallId: 'toolu_2', sessionUpdate: 'tool_call', name: 'Edit', rawInput: {}, status: 'pending', title: 'Edit', kind: 'edit', content: [], locations: [] },
            { _meta: meta('Edit'), toolCallId: 'toolu_2', sessionUpdate: 'tool_call_update', rawInput: { file_path: '/w/seed.txt', old_string: 'seed line', new_string: 'seed line edited' }, title: 'Edit seed.txt', content: [{ type: 'diff', path: '/w/seed.txt', oldText: 'seed line', newText: 'seed line edited' }], locations: [{ path: '/w/seed.txt' }] },
            { _meta: meta('Bash'), toolCallId: 'toolu_1', sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: 'seed.txt', content: [{ type: 'content', content: { type: 'text', text: '```console\nseed.txt\n```' } }] },
            { _meta: meta('Edit'), toolCallId: 'toolu_2', sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: 'The file /w/seed.txt has been updated successfully.' },
            say('All done.'),
        ])
            transcript.update(u)
        transcript.finish('end_turn', { inputTokens: 2000, outputTokens: 80, cachedReadTokens: 400, cachedWriteTokens: 0, totalTokens: 2480 })

        const messages = transcript.messages.map(m => m.message) as any[]
        const calls = messages.flatMap(m => m.role === 'assistant' ? m.content.filter((b: any) => b.type === 'toolCall') : [])
        expect(calls).toEqual([
            { type: 'toolCall', id: 'toolu_1', name: 'bash', arguments: { command: 'ls' } },
            { type: 'toolCall', id: 'toolu_2', name: 'edit', arguments: { path: '/w/seed.txt', oldText: 'seed line', newText: 'seed line edited' } },
        ])
        const results = messages.filter(m => m.role === 'toolResult')
        expect(results.map(r => [r.toolCallId, r.content[0]?.text])).toEqual([['toolu_1', 'seed.txt'], ['toolu_2', 'The file /w/seed.txt has been updated successfully.']])
        // The description never shows as the command's output while it runs.
        expect(events.some(e => e.type === 'tool_execution_update' && JSON.stringify(e).includes('List files'))).toBe(false)
        // Anthropic counts cache reads apart from input: 2000 + 400 + 80 = 2480.
        expect(messages.at(-1).usage).toMatchObject({ input: 2000, cacheRead: 400, output: 80 })
    })

    it('reads usage by the agent\'s convention when it is declared', () => {
        const run = (inputIncludesCache?: boolean) => {
            const transcript = new AcpTranscript('', { inputIncludesCache })
            transcript.userPrompt('x')
            transcript.update(say('y'))
            transcript.finish('end_turn', { inputTokens: 100, cachedReadTokens: 40, outputTokens: 10, totalTokens: 150 })
            return (transcript.messages.at(-1)!.message as any).usage.input
        }
        expect(run(true)).toBe(60)
        expect(run(false)).toBe(100)
        expect(run()).toBe(100)
    })

    // Grok Build 1.0.46: the call is announced with no kind, then gains one with a diff.
    it('reads a Grok Build write that gains its kind and diff in updates', () => {
        const { transcript } = record()
        transcript.userPrompt('change a.txt')
        const id = 'call-1-0'
        for (const u of [
            say('I\'ll write it.'),
            { sessionUpdate: 'tool_call', toolCallId: id, title: 'write', rawInput: { file_path: '/w/a.txt', content: 'hello\n' } },
            { sessionUpdate: 'tool_call_update', toolCallId: id, kind: 'edit', title: 'Write `/w/a.txt`', content: [{ type: 'diff', path: '/w/a.txt', oldText: '', newText: 'hello\n' }], locations: [{ path: '/w/a.txt' }] },
            { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'diff', path: '/w/a.txt', oldText: 'hi\n', newText: 'hello\n' }], rawOutput: { type: 'SearchReplace' } },
            say('OK'),
        ])
            transcript.update(u)
        transcript.finish('end_turn', { inputTokens: 37039, outputTokens: 92, totalTokens: 37131, cachedReadTokens: 19072 })
        const messages = transcript.messages.map(m => m.message) as any[]
        expect(messages[1].content.at(-1)).toEqual({ type: 'toolCall', id, name: 'edit', arguments: { path: '/w/a.txt', oldText: 'hi\n', newText: 'hello\n' } })
        expect(messages[2]).toMatchObject({ role: 'toolResult', toolCallId: id, isError: false })
        // OpenAI-style totals (input already holds the cache reads).
        expect(messages.at(-1).usage).toMatchObject({ input: 37039 - 19072, cacheRead: 19072 })
    })
})
