import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { darwin } from './darwin'
import { linux } from './linux'
import { shimScript, win32 } from './win32'
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
})

describe('posix', () => {
    it('keeps socket paths under the length limit', () => {
        expect(darwin.ipcPath('/Users/a/Library/Application Support/pi-gui', 't.sock')).toBe('/Users/a/Library/Application Support/pi-gui/t.sock')
        expect(linux.ipcPath(`/home/${'x'.repeat(120)}`, 't.sock').length).toBeLessThan(100)
    })
})
