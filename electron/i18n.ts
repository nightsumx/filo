// UI language of the main process (menus, error messages shown in the renderer). Set from saved
// state at startup and by the renderer when the user changes it; no electron import, so modules
// that use it stay testable in plain Node.
import type { Lang } from '@shared/i18n'

let current: Lang = 'zh'

export function setMainLang(lang: Lang) {
    current = lang
}

export function mainLang(): Lang {
    return current
}

export function tr(zh: string, en: string): string {
    return current === 'zh' ? zh : en
}
