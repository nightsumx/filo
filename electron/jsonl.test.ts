import { describe, expect, it } from 'vitest'
import { JsonlSplitter } from './jsonl'

function collect(chunks: (string | Buffer)[]) {
    const lines: string[] = []
    const splitter = new JsonlSplitter(line => lines.push(line))
    for (const chunk of chunks)
        splitter.push(chunk)
    splitter.end()
    return lines
}

describe('jsonlSplitter', () => {
    it('splits records across chunk boundaries', () => {
        expect(collect(['{"a":', '1}\n{"b"', ':2}\n'])).toEqual(['{"a":1}', '{"b":2}'])
    })

    it('strips CR from CRLF records and flushes a trailing record without LF', () => {
        expect(collect(['{"a":1}\r\n{"b":2}'])).toEqual(['{"a":1}', '{"b":2}'])
    })

    it('does not split on U+2028 / U+2029 inside JSON strings', () => {
        const record = JSON.stringify({ text: 'a\u2028b\u2029c' })
        expect(collect([`${record}\n`]).map(l => JSON.parse(l).text)).toEqual(['a\u2028b\u2029c'])
    })

    it('decodes multi-byte UTF-8 split across buffers', () => {
        const bytes = Buffer.from('{"t":"中文"}\n', 'utf8')
        expect(collect([bytes.subarray(0, 7), bytes.subarray(7)])).toEqual(['{"t":"中文"}'])
    })
})
