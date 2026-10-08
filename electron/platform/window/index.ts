// The running OS's window side (frames, menus, Dock or taskbar); only main.ts and background.ts use it.
import type { WindowPlatform } from './types'
import { platform } from '..'
import { darwinWindow } from './darwin'
import { desktopWindow } from './desktop'

export type { FrameColors, WindowPlatform } from './types'

export const windowPlatform: WindowPlatform = platform.id === 'darwin' ? darwinWindow : desktopWindow
