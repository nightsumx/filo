import { StringDecoder } from 'node:string_decoder'

/**
 * Strict JSONL framing for pi's RPC stdout: split only on LF and strip an optional CR.
 * Node's readline is unsafe here because it also splits on U+2028/U+2029, which are valid inside JSON strings.
 */
export class JsonlSplitter {
    private decoder = new StringDecoder('utf8')
    private buffer = ''

    constructor(private onLine: (line: string) => void) {}

    push(chunk: Buffer | string) {
        this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
        let index = this.buffer.indexOf('\n')
        while (index !== -1) {
            let line = this.buffer.slice(0, index)
            this.buffer = this.buffer.slice(index + 1)
            if (line.endsWith('\r'))
                line = line.slice(0, -1)
            if (line)
                this.onLine(line)
            index = this.buffer.indexOf('\n')
        }
    }

    end() {
        this.buffer += this.decoder.end()
        const rest = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer
        this.buffer = ''
        if (rest)
            this.onLine(rest)
    }
}
