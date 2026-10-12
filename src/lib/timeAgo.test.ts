import { describe, expect, it } from 'vitest'
import { applyLangPref } from './i18n'
import { timeAgo } from './utils'

const MIN = 60_000
const now = Date.UTC(2026, 0, 10)

describe('timeAgo', () => {
    it('picks minutes, hours or days by distance', () => {
        applyLangPref('en')
        expect(timeAgo(now - 7 * MIN, now)).toBe('7 minutes ago')
        expect(timeAgo(now - 1585 * MIN, now)).toBe('1 day ago')
        expect(timeAgo(now - 3 * 60 * MIN, now)).toBe('3 hours ago')
        expect(timeAgo(now - 3 * 1440 * MIN, now)).toBe('3 days ago')
    })

    it('speaks Chinese when the UI does', () => {
        applyLangPref('zh')
        expect(timeAgo(now - 1585 * MIN, now)).toBe('1 天前')
        expect(timeAgo(now - 3 * 60 * MIN, now)).toBe('3 小时前')
        expect(timeAgo(now - 12 * MIN, now)).toBe('12 分钟前')
    })
})
