/// <reference types="vite/client" />
import type { PiBridge } from '@shared/ipc'

declare global {
    /** package.json version, injected by vite.config.ts. */
    const __APP_VERSION__: string
    interface Window {
        pi: PiBridge
    }
}

export {}
