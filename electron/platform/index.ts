// The running OS's implementation. The only place in electron/ that reads process.platform.
import type { Platform } from './types'
import process from 'node:process'
import { darwin } from './darwin'
import { linux } from './linux'
import { win32 } from './win32'

export type { Command, OsId, Platform, ShellEnv } from './types'

function pick(): Platform {
    switch (process.platform) {
        case 'darwin': return darwin
        case 'win32': return win32
        default: return linux
    }
}

export const platform: Platform = pick()
