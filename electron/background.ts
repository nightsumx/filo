// PI_GUI_BACKGROUND=1 runs the app out of the way, for scripts that drive it over CDP (test/app.ts)
// while you keep using the computer: no Dock icon, it never becomes the active app, its windows are
// invisible and let clicks through, and rendering never pauses for being hidden or covered, so
// screenshots and requestAnimationFrame behave as in a window on screen.
import type { BrowserWindow } from 'electron'
import process from 'node:process'
import { app } from 'electron'

export const BACKGROUND = process.env.PI_GUI_BACKGROUND === '1'

if (BACKGROUND) {
    app.commandLine.appendSwitch('disable-renderer-backgrounding')
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
    if (process.platform === 'darwin')
        app.setActivationPolicy('accessory')
}

/** Shows a window, focused or not; in background mode it stays invisible and never takes focus. */
export function reveal(win: BrowserWindow, focus: boolean) {
    if (!BACKGROUND) {
        win.show()
        if (focus)
            win.focus()
        return
    }
    win.setOpacity(0)
    win.setIgnoreMouseEvents(true)
    win.showInactive()
}
