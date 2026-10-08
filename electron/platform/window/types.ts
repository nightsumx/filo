// The window side of the platform (see ../types.ts): frames, menus, the Dock or taskbar.
import type { BrowserWindow, BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron'

/** The window frame's colours, from the theme. */
export interface FrameColors {
    background: string
    /** Caption buttons (Windows, Linux). */
    symbols: string
}

/** Menu items main builds the same way on every OS. */
export interface MenuParts {
    settings: MenuItemConstructorOptions
    mergeWindows: MenuItemConstructorOptions
}

export interface WindowPlatform {
    /** Frame options for every window; the 38px main toolbar is the title bar on every OS. */
    frame: (colors: FrameColors) => BrowserWindowConstructorOptions
    /** A theme change: the frame's own parts (caption buttons) follow. */
    restyle: (win: BrowserWindow, colors: FrameColors) => void
    menu: (parts: MenuParts) => MenuItemConstructorOptions[]
    /** Closing the last window quits (not on macOS, where the app stays in the Dock). */
    readonly quitWithLastWindow: boolean
    /** An urgent notice while the app is in the background (the Dock icon bounces on macOS). */
    attention: () => void
    /** Development builds: the app's icon instead of Electron's, where the OS shows one. */
    devIcon: (png: string) => void
    /** PI_GUI_BACKGROUND=1: keep the app out of the Dock and app switcher. */
    background: () => void
    /** PI_GUI_BACKGROUND=1: a window being shown stays out of the taskbar. */
    backgroundWindow: (win: BrowserWindow) => void
}
