import { describe, expect, it } from 'vitest'
import { pickLang, resolveLang } from './i18n'

describe('UI language', () => {
    it('takes the first preferred language the app has', () => {
        expect(pickLang(['zh-Hans-CN', 'en-CN'])).toBe('zh')
        expect(pickLang(['zh-TW'])).toBe('zh')
        expect(pickLang(['en-US', 'zh-CN'])).toBe('en')
        expect(pickLang(['ja-JP', 'zh-CN'])).toBe('zh')
        expect(pickLang(['ja-JP', 'fr'])).toBe('en')
        expect(pickLang([])).toBe('en')
    })

    it('uses an explicit choice over the system', () => {
        expect(resolveLang('en', ['zh-CN'])).toBe('en')
        expect(resolveLang('zh', ['en-US'])).toBe('zh')
        expect(resolveLang('system', ['zh-CN'])).toBe('zh')
        expect(resolveLang('bogus', ['en-US'])).toBe('en')
        expect(resolveLang(undefined, ['zh_CN'])).toBe('zh')
    })
})
