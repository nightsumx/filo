import { describe, expect, it } from 'vitest'
import { autoReserve, inferCompactAt, isCustom, syncReserves } from './compactAt'

const M = 1_000_000
const models = [
    { key: 'a/big', contextWindow: M },
    { key: 'a/big2', contextWindow: M },
    { key: 'b/small', contextWindow: 200_000 },
    { key: 'c/unknown' },
]

describe('compactAt', () => {
    it('gives a model the reserve that compacts at the point, or none when its window is too small', () => {
        expect(autoReserve(M, 250_000)).toBe(750_000)
        expect(autoReserve(200_000, 250_000)).toBeNull()
        expect(autoReserve(200_000, 195_000)).toBeNull()
        expect(autoReserve(200_000, 150_000)).toBe(50_000)
    })

    it('treats overrides that do not match the point as exceptions', () => {
        expect(isCustom(M, undefined, 250_000)).toBe(false)
        expect(isCustom(M, 750_000, 250_000)).toBe(false)
        expect(isCustom(M, 500_000, 250_000)).toBe(true)
        expect(isCustom(M, 750_000, null)).toBe(true)
        expect(isCustom(undefined, 750_000, 250_000)).toBe(true)
    })

    it('moves models on the old point to the new one, leaving exceptions and unknown windows', () => {
        const reserves = { 'a/big': 750_000, 'a/big2': 500_000, 'c/unknown': 1 }
        expect(syncReserves(models, reserves, 250_000, 300_000)).toEqual({ 'a/big': 700_000 })
        // Small windows get no override; clearing the point removes only the matching ones.
        expect(syncReserves(models, {}, null, 250_000)).toEqual({ 'a/big': 750_000, 'a/big2': 750_000 })
        expect(syncReserves(models, reserves, 250_000, null)).toEqual({ 'a/big': null })
        // Same point: only fills in models that have none yet.
        expect(syncReserves(models, { 'a/big': 750_000 }, 250_000, 250_000)).toEqual({ 'a/big2': 750_000 })
        expect(syncReserves(models, { 'a/big': 750_000, 'a/big2': 750_000 }, 250_000, 250_000)).toEqual({})
    })

    it('reads the point most existing overrides share', () => {
        expect(inferCompactAt(models, { 'a/big': 750_000, 'a/big2': 750_000, 'b/small': 50_000 })).toBe(250_000)
        // One override is an exception, not a global point; odd values were not typed in k.
        expect(inferCompactAt(models, { 'a/big': 750_000 })).toBeNull()
        expect(inferCompactAt(models, { 'a/big': 750_123, 'a/big2': 750_123 })).toBeNull()
        expect(inferCompactAt(models, {})).toBeNull()
    })
})
