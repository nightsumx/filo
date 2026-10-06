// App UI language. Two languages, so strings sit next to their use as tr('中文', 'English')
// instead of in key-based dictionaries; the conversation wording has its own setting
// (TranscriptLang, src/lib/transcriptText.ts).

export type Lang = 'zh' | 'en'
/** 'system' follows the OS preferred languages. */
export type LangPref = 'system' | Lang
export const LANG_PREFS: readonly LangPref[] = ['system', 'zh', 'en']

/** A string in both languages, for data shared with the main process (capability labels). */
export interface Localized {
    zh: string
    en: string
}

/** First preferred language the app has; English when none matches (ja, fr, …). */
export function pickLang(preferred: readonly string[]): Lang {
    for (const tag of preferred) {
        const base = tag.toLowerCase().split(/[-_]/)[0]
        if (base === 'zh' || base === 'en')
            return base
    }
    return 'en'
}

export function resolveLang(pref: unknown, preferred: readonly string[]): Lang {
    return pref === 'zh' || pref === 'en' ? pref : pickLang(preferred)
}
