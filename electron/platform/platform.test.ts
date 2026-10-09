import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { platform } from '.'
import { darwin } from './darwin'
import { linux } from './linux'
import { cmdArgument, shimScript, win32 } from './win32'
import { below, foregroundOf, parseRows } from './win32-processes'
import { darwinWindow } from './window/darwin'
import { desktopWindow } from './window/desktop'

const root = path.join(__dirname, '..', '..')

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const file = path.join(dir, name)
        return statSync(file).isDirectory() ? files(file) : /\.(ts|tsx|mts)$/.test(name) ? [file] : []
    })
}

describe('platform boundary', () => {
    it('only electron/platform looks at the OS', () => {
        const platformDir = path.join(root, 'electron', 'platform')
        const offenders = ['electron', 'shared', 'src']
            .flatMap(dir => files(path.join(root, dir)))
            .filter(file => !file.startsWith(platformDir + path.sep) && !file.endsWith(path.join('src', 'platform.ts')))
            .filter(file => /process\.platform|os\.platform\(\)|navigator\.(platform|userAgent)/.test(readFileSync(file, 'utf8')))
            .map(file => path.relative(root, file))
        expect(offenders).toEqual([])
    })

    it('every OS implements the same surface', () => {
        const keys = (p: object) => Object.keys(p).filter(k => k !== 'thumbnail').sort()
        expect(keys(linux)).toEqual(keys(darwin))
        expect(keys(win32)).toEqual(keys(darwin))
        expect(Object.keys(desktopWindow).sort()).toEqual(Object.keys(darwinWindow).sort())
    })

    it('needs no Electron outside window/', () => {
        const platformDir = path.join(root, 'electron', 'platform')
        const electronUsers = files(platformDir)
            .filter(file => !file.startsWith(path.join(platformDir, 'window') + path.sep) && !file.endsWith('.test.ts'))
            .filter(file => /from 'electron'/.test(readFileSync(file, 'utf8')))
        expect(electronUsers).toEqual([])
    })
})

describe('win32', () => {
    it('reads the script out of an npm .cmd shim', () => {
        // cmd-shim's output for a global npm install.
        const shim = [
            '@ECHO off',
            'GOTO start',
            ':find_dp0',
            'SET dp0=%~dp0',
            'EXIT /b',
            ':start',
            'SETLOCAL',
            'CALL :find_dp0',
            'IF EXIST "%dp0%\\node.exe" (',
            '  SET "_prog=%dp0%\\node.exe"',
            ') ELSE (',
            '  SET "_prog=node"',
            '  SET PATHEXT=%PATHEXT:;.JS;=;%',
            ')',
            'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*',
        ].join('\r\n')
        expect(shimScript('C:\\npm\\pi.cmd', shim)).toBe('C:\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js')
        expect(shimScript('C:\\npm\\x.cmd', '@echo off\r\necho hi\r\n')).toBeUndefined()
    })

    it('keeps one PATH key whatever its case', () => {
        expect(win32.withPath({ Path: 'a', HOME: 'h' }, 'b')).toEqual({ HOME: 'h', PATH: 'b' })
        expect(darwin.withPath({ PATH: 'a' }, 'b')).toEqual({ PATH: 'b' })
    })

    it('runs PowerShell interactively or with one command', () => {
        expect(win32.shellArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toEqual(['-NoLogo'])
        expect(win32.shellArgs('pwsh.exe', 'bun run dev')).toEqual(['-NoLogo', '-Command', 'bun run dev'])
        expect(win32.shellArgs('C:\\Windows\\System32\\cmd.exe', 'dir')).toEqual(['/d', '/s', '/c', 'dir'])
    })

    it('names pipes per folder', () => {
        const a = win32.ipcPath('C:\\Users\\a\\AppData\\Roaming\\pi-gui', 'terminals-1.sock')
        expect(a).toMatch(/^\\\\\.\\pipe\\filo-[0-9a-f]{16}-terminals-1\.sock$/)
        expect(win32.ipcPath('C:\\Users\\A\\AppData\\Roaming\\pi-gui', 'terminals-1.sock')).toBe(a)
        expect(win32.ipcPath('C:\\Users\\b\\AppData\\Roaming\\pi-gui', 'terminals-1.sock')).not.toBe(a)
    })

    it('passes arguments through cmd.exe to a batch file unchanged', () => {
        expect(cmdArgument('plain')).toBe('^^^"plain^^^"')
        expect(cmdArgument('a b&c')).toBe('^^^"a^^^ b^^^&c^^^"')
        expect(cmdArgument('say "hi"\\')).toBe('^^^"say^^^ \\^^^"hi\\^^^"\\\\^^^"')
        const run = win32.command('C:\\a b\\agent.cmd', ['x y'])
        expect(run.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
        expect(run.windowsVerbatimArguments).toBe(true)
    })

    // What cmd.exe makes of it, on Windows itself: spaces, quotes, % and & reach the program as given.
    it.runIf(platform.id === 'win32')('runs a batch file in a folder with spaces, with awkward arguments', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'filo cmd '))
        try {
            const echo = path.join(dir, 'echo args.cjs')
            writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)))')
            const launcher = win32.launcher('probe', {}, [process.execPath, echo])
            const file = path.join(dir, launcher.file)
            writeFileSync(file, launcher.text)
            const args = ['two words', 'a&b|c', '100%', '"quoted"', 'trail\\', '^caret', '!bang!', '']
            const command = win32.command(file, args)
            const out = spawnSync(command.file, [...command.args, '--plain'], { windowsVerbatimArguments: command.windowsVerbatimArguments, encoding: 'utf8' })
            expect(JSON.parse(out.stdout)).toEqual([...args, '--plain'])
        }
        finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    // The app's node is a batch file (launcher): a shim found with only that on PATH runs through it.
    it.runIf(platform.id === 'win32')('runs an npm shim with the node on the PATH it is given', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'filo shim '))
        try {
            const bin = path.join(dir, 'bin')
            const pkg = path.join(dir, 'node_modules', 'x', 'cli.js')
            mkdirSync(path.dirname(pkg), { recursive: true })
            mkdirSync(bin)
            writeFileSync(pkg, 'console.log(process.env.VIA_APP_NODE, JSON.stringify(process.argv.slice(2)))')
            const launcher = win32.launcher('node', { VIA_APP_NODE: 'yes' }, [process.execPath])
            writeFileSync(path.join(bin, launcher.file), launcher.text)
            const shim = path.join(dir, 'x.cmd')
            writeFileSync(shim, '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\x\\cli.js" %*\r\n')
            const command = win32.command(shim, ['a b'], bin)
            const out = spawnSync(command.file, command.args, { windowsVerbatimArguments: command.windowsVerbatimArguments, encoding: 'utf8' })
            expect(out.stdout.trim()).toBe('yes ["a b"]')
        }
        finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('reads the process table: children, the tree below, the program in front', () => {
        const rows = parseRows('4 0 System\r\n10 4 pwsh.exe\r\n11 10 conhost.exe\r\n12 10 node.exe\r\n13 12 esbuild.exe\r\n14 14 Odd.exe\r\n\r\n')
        expect(rows).toHaveLength(6)
        expect(below(rows, 10)).toEqual([11, 12, 13])
        expect(below(rows, 14)).toEqual([])
        expect(foregroundOf(rows, 10)).toBe('node')
        expect(foregroundOf(rows, 12)).toBe('esbuild')
        expect(foregroundOf(rows, 13)).toBe('')
    })

    it('writes launchers as batch files', () => {
        const l = win32.launcher('node', { ELECTRON_RUN_AS_NODE: '1' }, ['C:\\Program Files\\Filo\\Filo.exe', '--require', 'C:\\100%\\preload.cjs'])
        expect(l.file).toBe('node.cmd')
        expect(l.text.split('\r\n')).toEqual([
            '@echo off',
            ':: The app\'s Electron as node, for agents it installed (electron/acp/node.ts).',
            'setlocal',
            'set "ELECTRON_RUN_AS_NODE=1"',
            '"C:\\Program Files\\Filo\\Filo.exe" "--require" "C:\\100%%\\preload.cjs" %*',
            '',
        ])
    })
})

describe('posix', () => {
    it('keeps socket paths under the length limit', () => {
        // The POSIX side joins with the host's separator.
        if (platform.id !== 'win32')
            expect(darwin.ipcPath('/Users/a/Library/Application Support/pi-gui', 't.sock')).toBe('/Users/a/Library/Application Support/pi-gui/t.sock')
        expect(linux.ipcPath(`/home/${'x'.repeat(120)}`, 't.sock').length).toBeLessThan(100)
    })

    it('writes launchers as sh scripts', () => {
        const l = darwin.launcher('npm', { A: 'it\'s' }, ['/a b/node', 'cli.js'])
        expect(l.file).toBe('npm')
        expect(l.text.split('\n').slice(2)).toEqual([`A='it'\\''s' exec '/a b/node' 'cli.js' "$@"`, ''])
    })
})
