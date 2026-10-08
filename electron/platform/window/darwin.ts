// macOS: traffic lights inset into the toolbar, the app menu, the Dock.
import type { WindowPlatform } from './types'
import { app } from 'electron'
import { tr } from '../../i18n'

export const darwinWindow: WindowPlatform = {
    frame: () => ({
        titleBarStyle: 'hiddenInset',
        // Centred in the 38px main toolbar.
        trafficLightPosition: { x: 14, y: 12 },
    }),
    restyle: () => {},
    menu: ({ settings, mergeWindows }) => [
        {
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                settings,
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        { role: 'editMenu' },
        {
            label: tr('视图', 'View'),
            submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        {
            label: tr('窗口', 'Window'),
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                { type: 'separator' },
                mergeWindows,
                { role: 'close', label: tr('关闭窗口', 'Close Window'), accelerator: 'CmdOrCtrl+Shift+W' },
                { type: 'separator' },
                { role: 'front' },
            ],
        },
    ],
    quitWithLastWindow: false,
    attention: () => app.dock?.bounce('informational'),
    // Packaged builds take the icon from build/icon.icns; in dev the Dock would show Electron's.
    devIcon: png => app.dock?.setIcon(png),
    // No Dock icon, not in ⌘Tab, never the active app.
    background: () => app.setActivationPolicy('accessory'),
    backgroundWindow: () => {},
}
