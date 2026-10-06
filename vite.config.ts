import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import electron from 'vite-plugin-electron/simple'
import pkg from './package.json'

// Main and preload run in Node: keep runtime deps external instead of bundling them.
const external = Object.keys(pkg.dependencies)
// vite-plugin-electron builds main/preload with their own config, so aliases are repeated there.
const nodeResolve = { alias: { '@shared': resolve('shared') } }

// The dev server needs an inline React refresh preamble; production builds do not, so drop it there.
function strictCsp(): Plugin {
    return {
        name: 'strict-csp',
        apply: 'build',
        transformIndexHtml: html => html
            .replace("script-src 'self' 'unsafe-inline'", "script-src 'self'")
            .replace(/; connect-src [^"]*/, "; connect-src 'self'"),
    }
}

export default defineConfig(({ command }) => {
    const isBuild = command === 'build'
    rmSync('dist-electron', { recursive: true, force: true })

    return {
        define: { __APP_VERSION__: JSON.stringify(pkg.version) },
        plugins: [
            react(),
            strictCsp(),
            !process.env.VITEST && electron({
                main: {
                    entry: 'electron/main.ts',
                    // PI_GUI_DEBUG_PORT=9333 bun run dev exposes Chrome DevTools Protocol for automated checks.
                    onstart({ startup }) {
                        const port = process.env.PI_GUI_DEBUG_PORT
                        return startup(['.', '--no-sandbox', ...(port ? [`--remote-debugging-port=${port}`] : [])])
                    },
                    vite: {
                        resolve: nodeResolve,
                        build: {
                            sourcemap: !isBuild,
                            minify: isBuild,
                            outDir: 'dist-electron/main',
                            rolldownOptions: { external },
                        },
                    },
                },
                preload: {
                    input: 'electron/preload.ts',
                    vite: {
                        resolve: nodeResolve,
                        build: {
                            sourcemap: isBuild ? undefined : 'inline',
                            minify: isBuild,
                            outDir: 'dist-electron/preload',
                            rolldownOptions: { external },
                        },
                    },
                },
            }),
        ],
        resolve: {
            alias: {
                '@': resolve('src'),
                '@shared': resolve('shared'),
            },
        },
        server: { port: 5288 },
        clearScreen: false,
        test: {
            include: ['src/**/*.test.ts', 'electron/**/*.test.ts', 'shared/**/*.test.ts', 'test/**/*.test.ts'],
            environment: 'node',
        },
    }
})
