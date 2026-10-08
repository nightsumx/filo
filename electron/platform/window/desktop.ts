// What Windows and Linux share in the window: no native title bar, the toolbar is the title bar and
// the OS draws its caption buttons over its right end (titleBarOverlay); the menu has no bar to show
// in, so it only carries shortcuts. Shortcuts the shell needs (Ctrl+C, Ctrl+R, Ctrl+W...) stay off it:
// in a terminal those go to the program running there, and text fields get them from Chromium.
import type { WindowPlatform } from './types'
import { BrowserWindow } from 'electron'
import { tr } from '../../i18n'

/** The main toolbar's height (src/features/Toolbar), which the caption buttons fill. */
const TOOLBAR_HEIGHT = 38

export const desktopWindow: WindowPlatform = {
    frame: colors => ({
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: colors.background, symbolColor: colors.symbols, height: TOOLBAR_HEIGHT },
    }),
    restyle: (win, colors) => {
        try {
            win.setTitleBarOverlay({ color: colors.background, symbolColor: colors.symbols, height: TOOLBAR_HEIGHT })
        }
        catch {}
    },
    menu: ({ settings, mergeWindows }) => [
        {
            label: tr('文件', 'File'),
            submenu: [settings, { type: 'separator' }, { role: 'quit' }],
        },
        {
            label: tr('视图', 'View'),
            submenu: [
                // Ctrl+R is the shell's history search.
                { role: 'reload', accelerator: 'Ctrl+Shift+R' },
                { role: 'toggleDevTools', accelerator: 'Ctrl+Shift+I' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen', accelerator: 'F11' },
            ],
        },
        {
            label: tr('窗口', 'Window'),
            submenu: [
                { role: 'minimize', accelerator: '' },
                mergeWindows,
                // Alt+F4 closes the window; Ctrl+Shift+W closes a terminal (src/platform.ts).
                { role: 'close', label: tr('关闭窗口', 'Close Window'), accelerator: '' },
            ],
        },
    ],
    quitWithLastWindow: true,
    // The taskbar entry flashes until the window is focused.
    attention: () => {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isFocused())
                win.flashFrame(true)
        }
    },
    // Packaged builds take the icon from the installer (.exe resources, the AppImage's .desktop entry).
    devIcon: () => {},
    // No app-level switcher entry to hide; each window keeps out of the taskbar instead.
    background: () => {},
    backgroundWindow: win => win.setSkipTaskbar(true),
}
