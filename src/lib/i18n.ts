// Current UI language for the renderer. `tr` reads an observable, so observer components re-render
// when the language changes; plain components get it through their observer parent.
import type { Lang, LangPref, Localized } from '@shared/i18n'
import { resolveLang } from '@shared/i18n'
import { observable, runInAction } from 'mobx'

const systemLanguages = (): readonly string[] =>
    typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]

const current = observable.box<Lang>(resolveLang('system', systemLanguages()), { deep: false })

export function lang(): Lang {
    return current.get()
}

export function applyLangPref(pref: LangPref): Lang {
    const next = resolveLang(pref, systemLanguages())
    runInAction(() => current.set(next))
    if (typeof document !== 'undefined')
        document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en'
    return next
}

/** The language the OS asks for, shown next to 跟随系统. */
export function systemLang(): Lang {
    return resolveLang('system', systemLanguages())
}

export function tr(text: Localized): string
export function tr(zh: string, en: string): string
export function tr(zh: string | Localized, en?: string): string {
    if (typeof zh === 'object')
        return zh[current.get()]
    return current.get() === 'zh' ? zh : en!
}

/** Title of a thread with no prompt yet. */
export const newThreadLabel = () => tr('新线程', 'New thread')
