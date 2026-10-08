import type { PiEvent } from '@shared/pi'
import { buildTurns } from '../../src/lib/timeline'
import { describe, expect, it } from 'vitest'
import { AcpTranscript, xaiUsage } from './transcript'

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

    it('reads Grok Build usage: input with cache, cache writes, reasoning and cost', () => {
        expect(xaiUsage({ inputTokens: 18567, outputTokens: 15, totalTokens: 18582, cachedReadTokens: 18432, cacheCreationTokens: 7, reasoningTokens: 14, costUsdTicks: 79407000 }))
            .toEqual({ inputTokens: 18567, outputTokens: 15, totalTokens: 18582, cachedReadTokens: 18432, cachedWriteTokens: 7, thoughtTokens: 14, cost: 0.0079407 })
    })
})

// Grok Build 1.0.46, from its stored sessions (paths shortened, long text cut): a call comes as
// `tool_call` titled with the tool name and `_meta["x.ai/tool"]`, then an update with its kind,
// title and `rawInput.variant`, then the result (content + rawOutput).
const xai = (name: string, kind: string, namespace = 'grok_build') => ({ 'x.ai/tool': { version: 1, name, kind, namespace, label: name, read_only: false } })
function grokCall(id: string, name: string, kind: string, rawInput: any, later: any, done: any, namespace?: string) {
    const { variant, ...input } = rawInput
    return [
        { sessionUpdate: 'tool_call', toolCallId: id, title: name, rawInput: input, _meta: xai(name, kind, namespace) },
        { sessionUpdate: 'tool_call_update', toolCallId: id, locations: [], rawInput, _meta: xai(name, kind, namespace), ...later },
        { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', ...done },
    ]
}
const textContent = (text: string) => [{ type: 'content', content: { type: 'text', text } }]

describe('acpTranscript with Grok Build', () => {
    function replay(updates: any[]) {
        const { transcript, events } = record()
        transcript.userPrompt('go')
        for (const u of updates)
            transcript.update(u)
        transcript.finish('end_turn')
        const messages = transcript.messages.map(m => m.message) as any[]
        const calls = messages.flatMap(m => m.role === 'assistant' ? m.content.filter((c: any) => c.type === 'toolCall') : [])
        const results = messages.filter(m => m.role === 'toolResult')
        return { messages, calls, results, events }
    }

    it('names calls by the x.ai tool and reads their output from rawOutput', () => {
        const grepStdout = [...Buffer.from('<workspace_result workspace_path="/w">')]
        const { calls, results } = replay([
            ...grokCall('c-0', 'grep', 'search', { variant: 'Grep', pattern: '里程碑|milestone', path: null, glob: '*.{md,ts,tsx,json}', '-i': false, type: null, head_limit: 50, multiline: false }, { kind: 'search', title: '里程碑|milestone' }, {
                content: textContent('found 2 matches'),
                rawOutput: { type: 'GrepSearch', stdout: grepStdout, stderr: [], exit_code: 0, match_count: 2, file_matches: [{ path: '/w/docs/plan.md', matches: [{ line_number: 206, content: '## 7. 里程碑' }, { line_number: 210, content: '| 里程碑 | 内容 |' }] }] },
            }),
            ...grokCall('c-1', 'list_dir', 'list', { variant: 'ListDir', target_directory: '/w' }, { kind: 'other', title: 'List `/w`', locations: [{ path: '/w' }] }, {
                rawOutput: { type: 'ListDir', Content: { content: '- /w/\n  - AGENTS.md\n', absolute_root_path: '/w' } },
            }),
            ...grokCall('c-2', 'read_file', 'read', { variant: 'ReadFile', target_file: '/w/docs/plan.md' }, { kind: 'read', title: 'Read `/w/docs/plan.md`', locations: [{ path: '/w/docs/plan.md' }] }, {
                content: textContent('1→# Plan\n'),
                rawOutput: { type: 'ReadFile', FileContent: { content: '1→# Plan\n', content_concise: '1→# Plan\n', absolute_path: '/w/docs/plan.md', offset: null, raw_output: '# Plan\n', total_lines: 1 } },
            }),
            ...grokCall('c-3', 'get_command_or_subagent_output', 'background_task_action', { variant: 'TaskOutput', task_ids: ['01a105fe'], timeout_ms: 180000 }, { kind: 'other', title: 'Get task output: 01a105fe' }, {
                title: 'python3 tools/sfx.py (01a105fe)',
                rawOutput: { type: 'TaskOutput', Result: { task_id: '01a105fe', command: 'python3 tools/sfx.py', status: 'completed', exit_code: 0, output: 'mix peak 0.84\n', truncated: false } },
            }),
            ...grokCall('c-4', 'kill_command_or_subagent', 'kill_task_action', { variant: 'KillTask', task_id: '01a09b11' }, { kind: 'other', title: 'Kill task: 01a09b11' }, {
                title: 'kill 01a09b11 (killed)',
                rawOutput: { type: 'KillTask', Result: { task_id: '01a09b11', outcome: 'killed', message: 'Task was terminated successfully' } },
            }),
            ...grokCall('c-5', 'web_fetch', 'web_fetch', { variant: 'WebFetch', url: 'https://example.com/' }, { kind: 'fetch', title: 'Fetch: https://example.com/' }, {
                status: 'failed',
                content: textContent('Tool `web_fetch` failed: SSRF blocked'),
                rawOutput: { error: 'tool_execution_failed', message: 'SSRF blocked' },
            }),
        ])
        expect(calls.map((c: any) => [c.name, c.arguments])).toEqual([
            ['grep', { pattern: '里程碑|milestone', path: null, glob: '*.{md,ts,tsx,json}', '-i': false, type: null, head_limit: 50, multiline: false }],
            ['ls', { path: '/w' }],
            ['read', { path: '/w/docs/plan.md' }],
            ['get_command_or_subagent_output', { description: 'python3 tools/sfx.py (01a105fe)', task_ids: ['01a105fe'], timeout_ms: 180000 }],
            ['kill_command_or_subagent', { description: 'kill 01a09b11 (killed)', task_id: '01a09b11' }],
            ['web_fetch', { description: 'Fetch: https://example.com/', url: 'https://example.com/' }],
        ])
        expect(results.map((r: any) => [r.toolName, r.content[0]?.text, r.isError])).toEqual([
            ['grep', '/w/docs/plan.md:206:## 7. 里程碑\n/w/docs/plan.md:210:| 里程碑 | 内容 |', false],
            ['ls', '- /w/\n  - AGENTS.md\n', false],
            ['read', '1→# Plan\n', false],
            ['get_command_or_subagent_output', 'mix peak 0.84\n', false],
            ['kill_command_or_subagent', 'Task was terminated successfully', false],
            ['web_fetch', 'Tool `web_fetch` failed: SSRF blocked', true],
        ])
    })

    it('a grep with no matches is not a failure, though ripgrep exits 1', () => {
        const { results } = replay(grokCall('c-0', 'grep', 'search', { variant: 'Grep', pattern: 'nope' }, { kind: 'search', title: 'nope' }, {
            content: textContent('found 0 matches'),
            rawOutput: { type: 'GrepSearch', stdout: [], stderr: [], exit_code: 1, match_count: 0, file_matches: [] },
        }))
        expect(results[0]).toMatchObject({ toolName: 'grep', isError: false })
    })

    it('an edit or write keeps its name from the first announcement to the result', () => {
        const before = 'export const GROW = [165.13]\n'
        const after = 'export const GROW = [165.13], FEED = 176.85\n'
        const { calls, events } = replay([
            ...grokCall('c-0', 'search_replace', 'edit', { variant: 'SearchReplace', file_path: '/w/clock.js', old_string: before, new_string: after, replace_all: false }, {
                kind: 'edit',
                title: 'Edit `/w/clock.js`',
                content: [{ type: 'diff', path: '/w/clock.js', oldText: before, newText: after, _meta: { old_line: 66, new_line: 66 } }],
                locations: [{ path: '/w/clock.js' }],
            }, {
                content: [{ type: 'diff', path: '/w/clock.js', oldText: before, newText: after }],
                rawOutput: { type: 'SearchReplace', EditsApplied: { old_string: before, new_string: after, tool_output_for_prompt: 'The file /w/clock.js has been updated successfully.', absolute_path: '/w/clock.js' } },
            }),
            // opencode's write: its diff is against the old file, its rawOutput a SearchReplace.
            ...grokCall('c-1', 'write', 'write', { variant: 'Write', file_path: '/w/recall.js', content: 'new\n' }, {
                kind: 'edit',
                title: 'Write `/w/recall.js`',
                content: [{ type: 'diff', path: '/w/recall.js', oldText: '', newText: 'new\n' }],
                locations: [{ path: '/w/recall.js' }],
            }, {
                content: [{ type: 'diff', path: '/w/recall.js', oldText: 'old\n', newText: 'new\n' }],
                rawOutput: { type: 'SearchReplace', EditsApplied: { old_string: 'old\n', new_string: 'new\n', tool_output_for_prompt: 'Wrote file successfully to /w/recall.js.', absolute_path: '/w/recall.js' } },
            }, 'opencode'),
        ])
        expect(calls).toEqual([
            { type: 'toolCall', id: 'c-0', name: 'edit', arguments: { path: '/w/clock.js', oldText: before, newText: after } },
            { type: 'toolCall', id: 'c-1', name: 'write', arguments: { path: '/w/recall.js', content: 'new\n' } },
        ])
        // Streamed under the same names it ends with.
        const names = events.filter((e: any) => e.type === 'message_update' && e.assistantMessageEvent.toolCall).map((e: any) => e.assistantMessageEvent.toolCall.name)
        expect(new Set(names)).toEqual(new Set(['edit', 'write']))
    })

    it('todo_write shows only as the plan that follows it', () => {
        const todos = [{ id: 'clock', content: 'Export arrival times', status: 'in_progress' }, { id: 'recall', content: 'Write recall.js', status: 'pending' }]
        const { calls, results } = replay([
            ...grokCall('c-0', 'todo_write', 'plan', { variant: 'TodoWrite', merge: false, todos }, { kind: 'think', title: 'Updating plan' }, {
                rawOutput: { type: 'Todo', TodosUpdated: { summary_for_prompt: '- [in_progress] clock: Export arrival times', todos: [] } },
            }),
            { sessionUpdate: 'plan', entries: [{ content: 'Export arrival times', status: 'in_progress', priority: 'medium' }, { content: 'Write recall.js', status: 'pending', priority: 'medium' }] },
            say('On it.'),
        ])
        expect(calls.map((c: any) => c.name)).toEqual(['todo'])
        expect(results.map((r: any) => r.toolName)).toEqual(['todo'])
    })

    it('reads server-side web searches, and the pages they open', () => {
        const { calls, results } = replay([
            { sessionUpdate: 'tool_call', toolCallId: 'ws_1', title: 'Web search:', kind: 'search', status: 'in_progress', rawInput: { variant: 'WebSearch', backend: true }, _meta: { backend: true } },
            { sessionUpdate: 'tool_call_update', toolCallId: 'ws_1', status: 'completed', title: 'Web search:', rawOutput: { action: { type: 'search', query: 'Grok 4.7 review', sources: [{ type: 'url', url: 'https://x.ai/news/grok-4-7' }, { type: 'url', url: 'https://example.com/a' }] }, id: 'ws_1', status: 'completed' } },
            { sessionUpdate: 'tool_call', toolCallId: 'ws_2', title: 'Web search:', kind: 'search', status: 'in_progress', rawInput: { variant: 'WebSearch', backend: true }, _meta: { backend: true } },
            { sessionUpdate: 'tool_call_update', toolCallId: 'ws_2', status: 'completed', title: 'Web search:', rawOutput: { action: { type: 'open_page', url: 'https://example.com/a' }, id: 'ws_2', status: 'completed' } },
            { sessionUpdate: 'tool_call', toolCallId: 'xs_1', title: 'X search:', kind: 'search', status: 'in_progress', rawInput: { variant: 'XSearch', backend: true }, _meta: { backend: true } },
            { sessionUpdate: 'tool_call_update', toolCallId: 'xs_1', status: 'completed', title: 'X search:', rawOutput: { call_id: 'xs_call', input: '{"query":"Grok 4.7","limit":"8","mode":"Latest"}', name: 'x_keyword_search', id: 'xs_1' } },
        ])
        expect(calls.map((c: any) => [c.name, c.arguments])).toEqual([
            ['web_search', { query: 'Grok 4.7 review' }],
            ['web_fetch', { url: 'https://example.com/a' }],
            ['x_search', { query: 'Grok 4.7', limit: '8', mode: 'Latest' }],
        ])
        expect(results[0].content[0].text).toBe('https://x.ai/news/grok-4-7\nhttps://example.com/a')
    })

    it('a replayed ask_user_question shows its questions and answers', () => {
        const q = '在哪个分支上改？'
        const message = `User has answered your questions: "${q}"="main (Recommended)", "Checks?"="Other" user notes: only lint. You can now continue with the user's answers in mind.`
        const { calls, results } = replay(grokCall('c-0', 'ask_user_question', 'ask_user', {
            variant: 'AskUserQuestion',
            questions: [
                { question: q, options: [{ label: 'main (Recommended)', description: 'checked out' }, { label: 'poi', description: '' }], multiSelect: null },
                { question: 'Checks?', options: [{ label: 'lint', description: '' }, { label: 'tests', description: '' }], multiSelect: true },
            ],
        }, { kind: 'other', title: `Ask: ${q}` }, { content: textContent(message), rawOutput: { type: 'AskUserQuestion', UserAnswered: { message } } }))
        expect(calls[0].name).toBe('ask')
        expect(results[0].details).toEqual({
            kind: 'ask',
            status: 'answered',
            questions: [
                { id: q, question: q, options: ['main (Recommended)', 'poi'] },
                { id: 'Checks?', question: 'Checks?', options: ['lint', 'tests'], multiple: true },
            ],
            answers: { [q]: { selected: ['main (Recommended)'] }, 'Checks?': { selected: [], text: 'only lint' } },
        })
    })

    it('leaves out user chunks Grok hides (background wake-ups), and shows interjections as typed', () => {
        const { messages } = replay([
            say('Started.'),
            { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '<monitor-event task_id="01a1">\nMADE apose.png\n</monitor-event>' }, _meta: { promptIndex: 8, hideFromScrollback: true } },
            say('The pose is made.'),
            { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '<user_query>\nalso this\n</user_query>', _meta: { displayText: 'also this' } } },
            say('OK.'),
        ])
        expect(messages.map(m => [m.role, m.content.map((c: any) => c.text).join('')])).toEqual([
            ['user', 'go'],
            ['assistant', 'Started.The pose is made.'],
            ['user', 'also this'],
            ['assistant', 'OK.'],
        ])
    })
})
