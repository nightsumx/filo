// The capabilities' terminal prompts, driven with key strings through a stand-in for ctx.ui.custom.
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { AskQuestion } from '@shared/capabilities'
import { describe, expect, it } from 'vitest'
import { askQuestions, choose, frame } from '../packages/capabilities/tui/dialog'

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as any

/** Runs a dialog, feeding it keys; returns its result and the last render. */
async function drive<T>(open: (ctx: ExtensionContext) => Promise<T>, keys: string[]): Promise<{ result: T, screen: string[] }> {
    let screen: string[] = []
    const ctx = {
        ui: {
            theme,
            custom: (factory: any) => new Promise((resolve) => {
                const component = factory({ requestRender() {} }, theme, {}, resolve)
                component.focused = true
                for (const key of keys) {
                    screen = component.render(60)
                    component.handleInput(key)
                }
            }),
        },
    } as unknown as ExtensionContext
    const result = await open(ctx)
    return { result, screen }
}

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ENTER = '\r'
const ESC = '\x1b'

describe('frame', () => {
    it('pads every row to the full width', () => {
        const lines = frame(theme, 20, ['hello', ['already fitted']])
        expect(lines).toHaveLength(4)
        expect(new Set(lines.map(l => l.length))).toEqual(new Set([20]))
    })
})

describe('choose', () => {
    const choice = { title: 'Bash command', question: 'Proceed?', options: ['Yes', 'Always', 'No'] }

    it('picks with a digit', async () => {
        expect((await drive(ctx => choose(ctx, choice), ['2'])).result).toBe(1)
    })

    it('moves with arrows and confirms with enter', async () => {
        const { result, screen } = await drive(ctx => choose(ctx, choice), [DOWN, DOWN, ENTER])
        expect(result).toBe(2)
        expect(screen.some(l => l.includes('❯ 3. No'))).toBe(true)
    })

    it('is dismissed with esc', async () => {
        expect((await drive(ctx => choose(ctx, choice), [ESC])).result).toBeUndefined()
    })
})

describe('askQuestions', () => {
    const questions: AskQuestion[] = [
        { id: 'lang', question: 'Which language?', options: ['Go', 'Rust'] },
        { id: 'extras', question: 'Extras?', options: ['Tests', 'Docs', 'CI'], multiple: true },
    ]

    it('walks the questions in order', async () => {
        // Q1: pick Rust. Q2: toggle Tests and CI with space, then Submit (row 5).
        const { result, screen } = await drive(ctx => askQuestions(ctx, questions), ['2', ' ', DOWN, DOWN, ' ', DOWN, DOWN, ENTER])
        expect(result).toEqual({
            lang: { selected: ['Rust'] },
            extras: { selected: ['Tests', 'CI'] },
        })
        expect(screen.some(l => l.includes('Question 2 of 2'))).toBe(true)
    })

    it('takes a typed answer', async () => {
        const { result } = await drive(ctx => askQuestions(ctx, questions.slice(0, 1)), [DOWN, DOWN, 'Z', 'i', 'g', ENTER])
        expect(result).toEqual({ lang: { selected: [], text: 'Zig' } })
    })

    it('ignores enter on an empty typed answer', async () => {
        // Digits on the typed row are text, so go back up to pick.
        const { result } = await drive(ctx => askQuestions(ctx, questions.slice(0, 1)), [DOWN, DOWN, ENTER, UP, UP, ENTER])
        expect(result).toEqual({ lang: { selected: ['Go'] } })
    })

    it('is cancelled with esc', async () => {
        expect((await drive(ctx => askQuestions(ctx, questions), [ESC])).result).toBeUndefined()
    })
})
