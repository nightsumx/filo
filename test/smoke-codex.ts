#!/usr/bin/env bun
// Quick smoke test: can we start a Codex native adapter and get initialize response?

import { spawn } from 'node:child_process'

const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'inherit'] })

let nextId = 1
const pending = new Map()

child.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n')
    for (const line of lines) {
        if (!line.trim()) continue
        try {
            const msg = JSON.parse(line)
            console.log('← ', JSON.stringify(msg).slice(0, 200))
            if (msg.id !== undefined) {
                const wait = pending.get(msg.id)
                if (wait) {
                    pending.delete(msg.id)
                    if (msg.error) wait.reject(new Error(msg.error.message))
                    else wait.resolve(msg.result)
                }
            } else if (msg.method) {
                console.log('[notification]', msg.method)
            }
        } catch (err) {
            console.error('Parse error:', line.slice(0, 100))
        }
    }
})

function send(msg: any) {
    child.stdin.write(JSON.stringify(msg) + '\n')
    console.log('→ ', JSON.stringify(msg).slice(0, 200))
}

function rpc(method: string, params?: any) {
    return new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        send({ id, method, params })
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id)
                reject(new Error('timeout'))
            }
        }, 5000)
    })
}

async function main() {
    try {
        const init = await rpc('initialize', {
            clientInfo: { name: 'smoke-test', version: '1.0.0' },
            capabilities: { experimentalApi: true },
        }) as any
        console.log('✓ initialize:', Object.keys(init))

        send({ method: 'initialized' })
        console.log('✓ initialized sent')

        const models = await rpc('model/list', {}) as any
        console.log('✓ model/list:', models.data?.length, 'models')

        console.log('\n✓ Codex adapter can start and respond')
        child.kill()
        process.exit(0)
    } catch (err: any) {
        console.error('✗ Failed:', err.message)
        child.kill()
        process.exit(1)
    }
}

main()
