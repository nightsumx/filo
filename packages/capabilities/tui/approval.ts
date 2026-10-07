// The approval prompt in the terminal, laid out like Claude Code's permission dialog: what will run
// or change (command, diff preview), the question, then Yes / Yes and don't ask again / No.
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { ApprovalChoice, ApprovalRequest } from '../protocol'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { choose } from './dialog'

const FILE_TOOLS = new Set(['edit', 'write'])
const SHELL_TOOLS = new Set(['bash', 'powershell'])

const preview = (text: string, sign: string, max: number, color: (s: string) => string = s => s) => {
    const lines = text.replace(/\n$/, '').split('\n')
    const shown = lines.slice(0, max).map(line => color(sign ? `  ${sign} ${line}` : `  ${line}`))
    if (lines.length > max)
        shown.push(`  … ${lines.length - max} more lines`)
    return shown
}

/**
 * Asks about one tool call. `input` is the call's arguments when the call is local (a subagent's
 * forwarded request carries only its summary). Undefined when dismissed.
 */
export async function promptApproval(ctx: ExtensionContext, request: ApprovalRequest, input: Record<string, unknown> | undefined, choices: readonly ApprovalChoice[], signal?: AbortSignal): Promise<ApprovalChoice | undefined> {
    const theme = ctx.ui.theme
    const muted = (s: string) => theme.fg('muted', s)
    const tool = request.tool
    const agent = request.agent ? muted(` · ${request.agent}`) : ''
    let title: string
    let body: string[]
    let question = 'Do you want to proceed?'
    let always: string

    if (SHELL_TOOLS.has(tool)) {
        title = tool === 'bash' ? 'Bash command' : 'PowerShell command'
        body = [...preview(String(input?.command ?? request.summary).trim(), '', 12), ...(input?.description ? [muted(`  ${input.description}`)] : [])]
        always = `Yes, and don't ask again for ${request.scope} commands this session`
    }
    else if (FILE_TOOLS.has(tool) && input) {
        const file = String(input.path ?? input.file_path ?? request.summary)
        const added = (s: string) => theme.fg('toolDiffAdded', s)
        const removed = (s: string) => theme.fg('toolDiffRemoved', s)
        const exists = existsSync(path.resolve(ctx.cwd, file))
        if (tool === 'edit') {
            const edits = Array.isArray(input.edits) ? input.edits : [input]
            title = 'Edit file'
            body = edits.flatMap((e: any, i: number) => [
                ...(i ? [''] : []),
                ...preview(String(e.oldText ?? e.old_string ?? ''), '-', 4, removed),
                ...preview(String(e.newText ?? e.new_string ?? ''), '+', 4, added),
            ])
            question = `Do you want to make this edit to ${path.basename(file)}?`
        }
        else {
            title = exists ? 'Overwrite file' : 'Create file'
            body = preview(String(input.content ?? ''), '+', 8, added)
            question = `Do you want to ${exists ? 'overwrite' : 'create'} ${path.basename(file)}?`
        }
        body = [muted(file), '', ...body]
        always = 'Yes, allow all edits during this session'
    }
    else if (FILE_TOOLS.has(tool)) {
        // A subagent's request: only the path is known here.
        title = tool === 'edit' ? 'Edit file' : 'Write file'
        body = [`  ${request.summary}`]
        always = 'Yes, allow all edits during this session'
    }
    else {
        title = `Tool use: ${tool}`
        body = [`  ${request.summary}`]
        always = `Yes, and don't ask again for ${tool} this session`
    }

    const options = choices.map(c => c === 'allow' ? 'Yes' : c === 'always' ? always : 'No, and tell pi what to do differently (esc)')
    const index = await choose(ctx, { title: title + agent, body, question, options }, signal)
    return index === undefined ? undefined : choices[index]
}
