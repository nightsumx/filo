// Session files a window follows while a terminal pi without pi-cc-tui's bridge writes them: each
// change is reported to the window (debounced), which re-reads the transcript. Watches end with
// the window.
import type { WebContents } from 'electron'
import { watch } from 'node:fs'

const DEBOUNCE_MS = 150

interface Followed {
    watcher: ReturnType<typeof watch>
    windows: Set<WebContents>
    timer: ReturnType<typeof setTimeout> | null
}

export class SessionFollower {
    private files = new Map<string, Followed>()

    constructor(private channel: string) {}

    follow(sender: WebContents, file: string, on: boolean) {
        let entry = this.files.get(file)
        if (!on) {
            entry?.windows.delete(sender)
            if (entry && !entry.windows.size)
                this.drop(file)
            return
        }
        if (!entry) {
            let watcher: ReturnType<typeof watch>
            try {
                watcher = watch(file, () => this.changed(file))
            }
            catch {
                return
            }
            watcher.on('error', () => this.drop(file))
            entry = { watcher, windows: new Set(), timer: null }
            this.files.set(file, entry)
        }
        if (!entry.windows.has(sender)) {
            entry.windows.add(sender)
            sender.once('destroyed', () => this.follow(sender, file, false))
        }
    }

    private changed(file: string) {
        const entry = this.files.get(file)
        if (!entry || entry.timer)
            return
        entry.timer = setTimeout(() => {
            entry.timer = null
            for (const window of entry.windows) {
                if (!window.isDestroyed())
                    window.send(this.channel, file)
            }
        }, DEBOUNCE_MS)
    }

    private drop(file: string) {
        const entry = this.files.get(file)
        if (!entry)
            return
        entry.watcher.close()
        if (entry.timer)
            clearTimeout(entry.timer)
        this.files.delete(file)
    }
}
