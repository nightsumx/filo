// Wording inside the conversation (tool rows, diffs, status lines). English follows pi's TUI with
// pi-cc-extensions word for word; Chinese is the localized variant. The rest of the app UI stays Chinese.
import type { TranscriptLang } from '@shared/ipc'
import { createContext, useContext } from 'react'

const en = {
    expand: 'click to show more',
    collapse: 'click to collapse',
    pending: 'Pending…',
    failed: 'Failed',
    done: 'Done',
    linesReturned: (n: number) => `${n} ${n === 1 ? 'line' : 'lines'} returned`,
    linesLoaded: (n: number) => `${n} ${n === 1 ? 'line' : 'lines'} loaded`,
    linesWritten: (n: number) => `${n} ${n === 1 ? 'line' : 'lines'} written`,
    showAll: (n: number) => `show all ${n} lines`,
    showLess: 'show less',
    moreLines: (n: number) => `… ${n} more ${n === 1 ? 'line' : 'lines'}`,
    moreDiffLines: (n: number) => `… ${n} more diff ${n === 1 ? 'line' : 'lines'}`,
    empty: '(empty)',
    multipleTools: 'Multiple Tools',
    running: 'running',
    doneCount: 'done',
    failedCount: 'failed',
    thinking: 'Thinking…',
    thinkingRedacted: 'Thinking (redacted)',
    exitCode: (code: number) => `exit code ${code}`,
    aborted: 'Aborted',
    requestFailed: 'Request failed',
    compacted: 'Context compacted',
    branchSummary: 'Branch summary',
    compacting: 'Compacting context',
    retrying: (a: number, b: number) => `Retrying (${a}/${b})`,
    starting: 'Starting pi',
    /** cc-tui picks one verb per run: "Churning…" while working, "Churned for 12s" after. */
    verbs: [
        ['Working', 'Worked'],
        ['Churning', 'Churned'],
        ['Sautéing', 'Sautéed'],
        ['Brewing', 'Brewed'],
        ['Cooking', 'Cooked'],
        ['Baking', 'Baked'],
        ['Crunching', 'Crunched'],
        ['Cogitating', 'Cogitated'],
    ] as [string, string][],
    workedFor: (verb: string, d: string, at: string) => `${verb} for ${d} · done ${at}`,
    doneAt: (at: string) => `done ${at}`,
    duration: (ms: number) => {
        const s = Math.max(0, Math.round(ms / 1000))
        if (s < 60)
            return `${s}s`
        const m = Math.floor(s / 60)
        return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
    },
    clock: (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    copy: 'Copy',
    copied: 'Copied',
}

export type TranscriptText = typeof en

const zh: TranscriptText = {
    expand: '点击展开',
    collapse: '点击收起',
    pending: '运行中…',
    failed: '失败',
    done: '完成',
    linesReturned: n => `返回 ${n} 行`,
    linesLoaded: n => `已读取 ${n} 行`,
    linesWritten: n => `已写入 ${n} 行`,
    showAll: n => `显示全部 ${n} 行`,
    showLess: '收起',
    moreLines: n => `… 还有 ${n} 行`,
    moreDiffLines: n => `… 还有 ${n} 行差异`,
    empty: '（空）',
    multipleTools: '多个工具',
    running: '运行中',
    doneCount: '完成',
    failedCount: '失败',
    thinking: '思考中…',
    thinkingRedacted: '思考（已加密）',
    exitCode: code => `退出码 ${code}`,
    aborted: '已中断',
    requestFailed: '请求失败',
    compacted: '上下文已压缩',
    branchSummary: '分支摘要',
    compacting: '正在压缩上下文',
    retrying: (a, b) => `重试中（${a}/${b}）`,
    starting: '正在启动 pi',
    verbs: [['思考中', '已处理']],
    workedFor: (verb, d, at) => `${verb} ${d} · 完成于 ${at}`,
    doneAt: at => `完成于 ${at}`,
    duration: (ms) => {
        const s = Math.max(0, Math.round(ms / 1000))
        if (s < 60)
            return `${s} 秒`
        const m = Math.floor(s / 60)
        return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`
    },
    clock: (ts) => {
        const d = new Date(ts)
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    },
    copy: '复制',
    copied: '已复制',
}

export const TRANSCRIPT_TEXT: Record<TranscriptLang, TranscriptText> = { en, zh }

/** Provided by MessageList from the store setting; memoized rows re-render when it changes. */
export const TranscriptTextContext = createContext<TranscriptText>(en)

export function useT(): TranscriptText {
    return useContext(TranscriptTextContext)
}

/** Stable per-run verb, so a turn does not flip between "Brewing" and "Baking" on re-render. */
export function verbFor(t: TranscriptText, seed: string | number): [string, string] {
    const s = String(seed)
    let h = 0
    for (let i = 0; i < s.length; i++)
        h = (h * 31 + s.charCodeAt(i)) | 0
    return t.verbs[Math.abs(h) % t.verbs.length]
}
