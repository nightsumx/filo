// What the main process needs from the operating system, one implementation per OS (darwin.ts,
// linux.ts, win32.ts; posix.ts is what macOS and Linux share). Everything else in electron/ goes
// through `platform` (index.ts) instead of looking at process.platform, so an OS's quirks stay in its
// file and a change for one cannot reach another (platform.test.ts enforces it). Windows, menus and
// the Dock are in window/, the only part that needs Electron: this part also runs under plain node
// and bun (tests, scripts).

export type OsId = 'darwin' | 'linux' | 'win32'

/** What a login shell (or, on Windows, the environment) says about the user's tools. */
export interface ShellEnv {
    /** Real files, symlinks resolved; '' when not found. */
    node: string
    pi: string
    /** Undefined: keep the app's own PATH. */
    path?: string
}

/** A small script that runs `argv` plus its own arguments with `env` set: `name` on disk is `file`. */
export interface Launcher {
    file: string
    text: string
}

/** A program to start: what to spawn for a command found on disk (a .cmd shim becomes node + script). */
export interface Command {
    file: string
    args: string[]
}

export interface Platform {
    readonly id: OsId
    /** `<os>-<arch>`: the key of per-platform downloads (agent archives) and prebuilt binaries. */
    readonly target: string

    // ---- the user's tools

    /** The user's PATH and their node and pi. */
    shellEnv: () => Promise<ShellEnv>
    /** The shell terminals run. */
    userShell: () => string
    /** Arguments for the shell: interactive login, or one command in it. */
    shellArgs: (shell: string, command?: string) => string[]
    /** A program called `name` in `dir`, if there is one that can be run. */
    findIn: (name: string, dirs: readonly string[]) => Promise<string | undefined>
    /** How to start a program found by findIn with `args`. */
    command: (file: string, args: readonly string[]) => Command
    /** `env` with PATH set to `value`. */
    withPath: (env: Record<string, string>, value: string) => Record<string, string>
    /** A command named `name` that runs `argv` (and what it is given) with `env` (electron/acp/node.ts). */
    launcher: (name: string, env: Record<string, string>, argv: readonly string[]) => Launcher

    // ---- processes

    /** Ends a terminal's process (`kill`, the PTY's own) and everything it started, within `graceMs`. */
    stopTree: (pid: number, kill: (signal?: string) => void, exited: Promise<void>, graceMs: number) => Promise<void>

    // ---- local connections (pi-cc-tui's bridge, the terminal tools)

    /** Where a local server named `name` listens, given the folder that would hold a socket file. */
    ipcPath: (dir: string, name: string) => string
    /** Only this user may connect to a server listening at `file`. */
    restrict: (file: string) => void
    /** Removes what a crashed run left at `file`, so listening there works. */
    clearIpc: (file: string) => void

    // ---- files

    /** Unpacks a downloaded .zip or .tar.gz into `dir`. */
    unpack: (archive: string, dir: string, run: (cmd: Command) => Promise<void>) => Promise<void>
    /** Entry names of an archive (zip, tar, 7z… what the OS's tar reads). */
    archiveEntries: (file: string) => Promise<string[]>
    /** A Finder-style thumbnail (PNG) of a document, where the OS makes them. */
    readonly thumbnail?: (file: string, outDir: string) => Promise<Buffer | null>
    /** Makes node-pty's helper runnable (published without its executable bit). */
    preparePty: (ptyDir: string) => void
}
