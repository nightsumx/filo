// Shell commands that only read: plan mode lets these run, and approval doesn't ask for them.
// Conservative by design: anything not recognised (unknown programs, redirection, substitution,
// flags that write or run other commands) counts as a change and goes through the normal path.

// Programs that read, optionally followed by a check on their arguments that rules a call out.
const PROGRAMS: Record<string, ((args: string[], raw: string) => boolean) | null> = {
    cat: null,
    head: null,
    tail: null,
    grep: null,
    egrep: null,
    rg: args => args.some(a => /^--pre(=|$)/.test(a)),
    ag: null,
    find: args => args.some(a => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a)),
    fd: args => args.some(a => /^(-x|-X|--exec|--exec-batch)(=|$)/.test(a)),
    ls: null,
    eza: null,
    tree: args => args.some(a => /^-o/.test(a)),
    pwd: null,
    echo: null,
    printf: null,
    wc: null,
    sort: args => args.some(a => /^(-o|--output)/.test(a)),
    // `uniq in out` writes out.
    uniq: args => args.filter(a => !a.startsWith('-')).length > 1,
    cut: null,
    tr: null,
    column: null,
    diff: null,
    file: args => args.includes('-C'),
    stat: null,
    du: null,
    df: null,
    which: null,
    whereis: null,
    type: null,
    // Bare `env` lists the environment; `env cmd` runs cmd.
    env: args => args.length > 0,
    printenv: null,
    uname: null,
    whoami: null,
    id: null,
    date: args => args.some(a => /^(-s|--set)/.test(a)),
    cal: null,
    uptime: null,
    ps: null,
    jq: null,
    yq: args => args.some(a => /^(-i|--inplace)/.test(a)),
    awk: (_args, raw) => /system\s*\(|getline/.test(raw),
    bat: null,
    realpath: null,
    dirname: null,
    basename: null,
    nl: null,
    true: null,
    // sed only prints with -n, and its w / W / e commands write or run.
    sed: (args, raw) => args[0] !== '-n' || args.some(a => /^(-i|--in-place)/.test(a)) || /(^|[\s'";}/])\d*,?\d*\s*[wWe](\s|['"]|$)/.test(raw.replace(/^sed\s+-n/, '')),
}

const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'blame', 'shortlog', 'describe', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file'])
// `git branch` and `git remote` only when listing.
const GIT_BRANCH_LIST = new Set(['-a', '-r', '-v', '-vv', '-l', '--list', '--all', '--remotes', '--verbose', '--show-current', '--no-color', '--color'])

function gitReads(args: string[]): boolean {
    const [sub, ...rest] = args
    if (rest.some(a => /^--output(=|$)/.test(a)))
        return false
    if (sub && GIT_READ.has(sub))
        return true
    if (sub === 'grep')
        return !rest.some(a => /^(-O|--open-files-in-pager)/.test(a))
    if (sub === 'branch')
        return rest.every(a => GIT_BRANCH_LIST.has(a))
    if (sub === 'remote')
        return rest.length === 0 || (rest.length === 1 && rest[0] === '-v') || rest[0] === 'show' || rest[0] === 'get-url'
    if (sub === 'config')
        return rest[0] === '--get' || rest[0] === '--get-all' || rest[0] === '--list' || rest[0] === '-l'
    return false
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PACKAGE_READ = new Set(['list', 'ls', 'view', 'info', 'why', 'outdated'])
const RUNTIMES = new Set(['node', 'python', 'python3', 'go', 'cargo', 'rustc', 'bun', 'deno', 'java'])

// Variables a read-only command may set for itself; others (GIT_PAGER, LD_PRELOAD, ...) can run code.
const HARMLESS_VARS = /^(LC_\w+|LANG|LANGUAGE|TZ|NO_COLOR|FORCE_COLOR|TERM|COLUMNS|LINES)=\S*$/

function segmentReads(segment: string): boolean {
    let words = segment.split(/\s+/).filter(Boolean)
    while (words.length && /^\w+=/.test(words[0])) {
        if (!HARMLESS_VARS.test(words[0]))
            return false
        words = words.slice(1)
    }
    if (!words.length)
        return false
    const [program, ...rawArgs] = words
    // Quotes don't change what a flag means.
    const args = rawArgs.map(a => a.replace(/^['"]|['"]$/g, ''))
    if (program === 'cd')
        return args.length <= 1
    if (program === 'git')
        return gitReads(args)
    if (PACKAGE_MANAGERS.has(program) && args[0] && PACKAGE_READ.has(args[0]))
        return true
    if (PACKAGE_MANAGERS.has(program) && args[0] === 'audit')
        return !args.includes('fix')
    if (RUNTIMES.has(program) && args.length === 1 && /^(--version|-v|-V|version)$/.test(args[0]))
        return true
    if (!Object.hasOwn(PROGRAMS, program))
        return false
    const rules = PROGRAMS[program]
    return !rules?.(args, words.join(' '))
}

export function isReadOnlyCommand(command: string): boolean {
    // Discarding output is fine; any other redirection or substitution could write.
    const cleaned = command.replace(/\d?>\s*\/dev\/null/g, '').replace(/2>&1/g, '')
    if (/[<>`]|\$\(/.test(cleaned))
        return false
    const segments = cleaned.split(/\|\||&&|[|;&\n]/).map(s => s.trim()).filter(Boolean)
    return segments.length > 0 && segments.every(segmentReads)
}
