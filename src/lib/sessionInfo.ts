// What the "Session info" dialog lists: pi's /session (path, id, messages, tokens, cost) for every agent.
// A row exists only when the agent reported its value; nothing is filled in with 0 or a blank.
import type { AgentKind } from '@shared/agents'
import type { RpcSessionState, SessionStats } from '@shared/pi'
import { modelKey } from '@shared/pi'
import { tr } from './i18n'
import { formatCost } from './utils'

export interface InfoRow {
    id: 'path' | 'id' | 'messages' | 'model' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'total' | 'cost' | 'context'
    label: string
    value: string
    /** A file the dialog can show in the file manager. */
    file?: string
}

const count = (n: number) => n.toLocaleString('en-US')

/** pi's `sessionFile` is a real JSONL path; the other agents put a key of their own there, which is not a file. */
export function sessionInfoRows(agent: AgentKind, state: RpcSessionState | null, stats: SessionStats | null): InfoRow[] {
    const rows: InfoRow[] = []
    const add = (id: InfoRow['id'], label: string, value: string | undefined, file?: string) => {
        if (value)
            rows.push({ id, label, value, file })
    }
    const file = agent === 'pi' ? stats?.sessionFile ?? state?.sessionFile : undefined
    add('path', tr('会话文件', 'Session file'), file, file)
    add('id', tr('会话 id', 'Session ID'), stats?.sessionId ?? state?.sessionId)

    const total = stats?.totalMessages ?? state?.messageCount
    if (typeof total === 'number') {
        const parts = [
            typeof stats?.userMessages === 'number' ? tr(`用户 ${stats.userMessages}`, `${stats.userMessages} user`) : '',
            typeof stats?.assistantMessages === 'number' ? tr(`助手 ${stats.assistantMessages}`, `${stats.assistantMessages} assistant`) : '',
            typeof stats?.toolCalls === 'number' ? tr(`工具调用 ${stats.toolCalls}`, `${stats.toolCalls} tool calls`) : '',
        ].filter(Boolean)
        add('messages', tr('消息数', 'Messages'), parts.length ? `${count(total)}（${parts.join(' · ')}）` : count(total))
    }

    const model = state?.model
    if (model)
        add('model', tr('模型', 'Model'), agent === 'pi' ? modelKey(model) : model.name || model.id)

    // An agent that reports no usage sums to 0, which would read as "used nothing".
    const tokens = stats?.tokens
    if (tokens && (agent === 'pi' || tokens.total > 0)) {
        const token = (id: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'total', label: string) => {
            if (typeof tokens[id] === 'number')
                add(id, label, count(tokens[id]))
        }
        token('input', tr('输入 token', 'Input tokens'))
        token('output', tr('输出 token', 'Output tokens'))
        token('cacheRead', tr('缓存读', 'Cache read'))
        token('cacheWrite', tr('缓存写', 'Cache write'))
        token('total', tr('token 总计', 'Total tokens'))
    }
    if (typeof stats?.cost === 'number')
        add('cost', tr('花费', 'Cost'), formatCost(stats.cost))

    const context = stats?.contextUsage
    if (context?.contextWindow) {
        const used = typeof context.tokens === 'number' ? count(context.tokens) : '?'
        const percent = typeof context.percent === 'number' ? `（${context.percent.toFixed(1)}%）` : ''
        add('context', tr('上下文用量', 'Context usage'), `${used} / ${count(context.contextWindow)}${percent}`)
    }
    return rows
}
