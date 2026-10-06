import type { AppState } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import { applySave, defaultState, savedWindows } from './appState'

const base = (): AppState => ({
    ...defaultState(),
    projects: ['/a', '/b'],
    theme: 'dark',
    tabs: { '/a': ['/s/a1'], '/b': ['/s/b1', '/s/b2'] },
    activeTabs: { '/a': '/s/a1', '/b': '/s/b2' },
})

describe('applySave', () => {
    it('takes tabs only for the projects the saving window shows', () => {
        const { state } = applySave(base(), { prefs: {}, tabs: { '/a': ['/s/a2'], '/b': [] }, activeTabs: { '/a': '/s/a2' } }, ['/a'])
        expect(state.tabs).toEqual({ '/a': ['/s/a2'], '/b': ['/s/b1', '/s/b2'] })
        expect(state.activeTabs).toEqual({ '/a': '/s/a2', '/b': '/s/b2' })
    })

    it('drops the tabs of an owned project that has none left', () => {
        const { state } = applySave(base(), { prefs: {}, tabs: {}, activeTabs: {} }, ['/b'])
        expect(state.tabs).toEqual({ '/a': ['/s/a1'] })
        expect(state.activeTabs).toEqual({ '/a': '/s/a1' })
    })

    it('reports only shared settings that actually changed', () => {
        const { state, changed } = applySave(base(), { prefs: { theme: 'dark', layout: 'single', lang: 'system' }, tabs: {}, activeTabs: {} }, [])
        expect(changed).toEqual({ layout: 'single', lang: 'system' })
        expect(state.layout).toBe('single')
        expect(state.theme).toBe('dark')
    })

    it('leaves settings a window did not send alone, so a stale window cannot undo another', () => {
        const first = applySave(base(), { prefs: { theme: 'light' }, tabs: {}, activeTabs: {} }, []).state
        const { state } = applySave(first, { prefs: { layout: 'single' }, tabs: {}, activeTabs: {} }, [])
        expect(state.theme).toBe('light')
    })

    it('forgets the tabs of hidden projects', () => {
        const { state } = applySave(base(), { prefs: { hiddenProjects: ['/b'] }, tabs: {}, activeTabs: {} }, [])
        expect(state.tabs).toEqual({ '/a': ['/s/a1'] })
        expect(state.activeTabs).toEqual({ '/a': '/s/a1' })
    })
})

describe('savedWindows', () => {
    it('reads the old single-window state as one window on its active project', () => {
        expect(savedWindows({ ...base(), activeProject: '/a' })).toEqual([{ projects: ['/a'], active: '/a' }])
        expect(savedWindows(base())).toEqual([])
    })

    it('keeps each project in one window and drops empty or invalid entries', () => {
        const windows = savedWindows({
            ...base(),
            windows: [
                { projects: ['/a', '/b'], active: '/b' },
                { projects: ['/b', 'relative', '/c'], active: '/x' },
                { projects: [] },
            ],
        })
        expect(windows).toEqual([{ projects: ['/a', '/b'], active: '/b' }, { projects: ['/c'], active: '/c' }])
    })
})
