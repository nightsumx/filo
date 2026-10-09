// A minimal stdio MCP server for the Codex tests.
//   echo        returns its text
//   pick_color  asks the user through elicitation/create (a form) and returns the answer
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const waiting = new Map()
let nextId = 1

const TOOLS = [
    { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'pick_color', description: 'Ask the user for a color', inputSchema: { type: 'object', properties: {} } },
]

const FORM = {
    type: 'object',
    properties: {
        color: { type: 'string', title: 'Color', enum: ['red', 'green', 'blue'] },
        shade: { type: 'string', title: 'Shade', description: 'Any word' },
        bright: { type: 'boolean', title: 'Bright' },
        count: { type: 'integer', title: 'How many' },
    },
    required: ['color'],
}

function elicit(params) {
    const id = `srv-${nextId++}`
    send({ jsonrpc: '2.0', id, method: 'elicitation/create', params })
    return new Promise(resolve => waiting.set(id, resolve))
}

rl.on('line', async (line) => {
    const message = JSON.parse(line)
    if (message.id !== undefined && !message.method) {
        waiting.get(message.id)?.(message.result ?? { error: message.error })
        waiting.delete(message.id)
        return
    }
    const reply = result => send({ jsonrpc: '2.0', id: message.id, result })
    switch (message.method) {
        case 'initialize':
            return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1' } })
        case 'tools/list':
            return reply({ tools: TOOLS })
        case 'tools/call': {
            const { name, arguments: args } = message.params
            if (name === 'pick_color') {
                const answer = await elicit({ mode: 'form', message: 'Pick a color for the theme', requestedSchema: FORM })
                return reply({ content: [{ type: 'text', text: `answer: ${JSON.stringify(answer)}` }] })
            }
            return reply({ content: [{ type: 'text', text: `echo: ${args?.text}` }] })
        }
        default:
            if (message.id !== undefined)
                reply({})
    }
})
