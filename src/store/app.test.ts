import { resolveCapabilities } from '@shared/capabilities'
import { SETUP_VERSION } from '@shared/setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_IDLE_MS, appStore, MIN_PANE_WIDTH } from './app'

function reset() {
    appStore.threads.clear()
    appStore.tabsByProject = {}
    appStore.activeTabByProject = {}
    appStore.activeProject = null
    appStore.windowProjects = []
    appStore.layout = 'split'
}

/** Opens n tabs in /p; newThread reuses blank tabs, so give each one a draft-free prompt marker. */
function openTabs(n: number) {
    const keys: string[] = []
    for (let i = 0; i < n; i++) {
        appStore.newThread('/p')
        const thread = appStore.active!
        thread.pendingPrompt = { text: `t${i}`, images: [], timestamp: i }
        keys.push(thread.key)
    }
    return keys
}

describe('tabs and auto split', () => {
    beforeEach(reset)

    it('fits as many panes as the width allows, capped at three', () => {
        openTabs(4)
        appStore.setPaneCapacity(MIN_PANE_WIDTH * 2 + 10)
        expect(appStore.visibleTabs).toHaveLength(2)
        appStore.setPaneCapacity(MIN_PANE_WIDTH * 10)
        expect(appStore.visibleTabs).toHaveLength(3)
        appStore.setPaneCapacity(100)
        expect(appStore.visibleTabs).toHaveLength(1)
    })

    it('keeps the focused tab on screen', () => {
        const keys = openTabs(5)
        appStore.setPaneCapacity(MIN_PANE_WIDTH * 2)
        appStore.focus(keys[0])
        expect(appStore.visibleTabs.map(t => t.key)).toEqual([keys[0], keys[1]])
        appStore.focus(keys[4])
        expect(appStore.visibleTabs.map(t => t.key)).toEqual([keys[3], keys[4]])
    })

    it('single layout shows only the focused tab', () => {
        const keys = openTabs(3)
        appStore.setPaneCapacity(MIN_PANE_WIDTH * 3)
        appStore.toggleLayout()
        appStore.focus(keys[1])
        expect(appStore.visibleTabs.map(t => t.key)).toEqual([keys[1]])
    })

    it('inserts new tabs after the focused one and reuses a blank tab', () => {
        const keys = openTabs(2)
        appStore.focus(keys[0])
        appStore.newThread('/p')
        const blank = appStore.activeKey
        expect(appStore.tabs.map(t => t.key)).toEqual([keys[0], blank, keys[1]])
        appStore.focus(keys[1])
        appStore.newThread('/p')
        expect(appStore.activeKey).toBe(blank)
        expect(appStore.tabs).toHaveLength(3)
    })

    it('closing the focused tab focuses its neighbour', async () => {
        const keys = openTabs(3)
        appStore.focus(keys[1])
        await appStore.closeTab(keys[1])
        expect(appStore.activeKey).toBe(keys[2])
        expect(appStore.threads.has(keys[1])).toBe(false)
    })

    it('moves tabs', () => {
        const keys = openTabs(3)
        appStore.moveTab(keys[2], 0)
        expect(appStore.tabs.map(t => t.key)).toEqual([keys[2], keys[0], keys[1]])
    })
})

describe('capabilities', () => {
    /** settings.json as the main process would report it after each write. */
    let written: any[]
    const state = (enabled: any, approvalMode = 'auto', more: object = {}) => ({
        fingerprint: '[]',
        modelOverrides: {},
        capabilities: { ...resolveCapabilities(enabled), approvalMode, saved: true },
        ...more,
    })
    beforeEach(() => {
        reset()
        written = []
        let saved: any = {}
        vi.stubGlobal('window', { pi: {
            setCapabilities: async (patch: any) => {
                written.push(patch)
                saved = { ...saved, ...patch }
                return state(saved.enabled, saved.approvalMode)
            },
            piSettings: async () => state(saved.enabled, saved.approvalMode),
        } })
        ;(appStore as any).applyPiSettings(state('standard'))
    })
    afterEach(() => vi.unstubAllGlobals())
    const apply = (s: object) => {
        ;(appStore as any).applyPiSettings(s)
        return appStore.enabledCapabilities
    }

    it('returns plain, cloneable arrays', () => {
        appStore.setCapabilities(['ask', 'bogus' as any, 'todo'])
        const ids = appStore.enabledCapabilities
        expect(ids).toEqual(['todo', 'ask'])
        // agentStart sends this over IPC; MobX proxies fail structured clone.
        expect(() => structuredClone(ids)).not.toThrow()
        appStore.setCapabilities([])
        expect(appStore.enabledCapabilities).toEqual([])
    })

    it('saves into pi\'s settings.json, a preset by its id so later additions to it reach users who chose it', async () => {
        appStore.setCapabilities(['todo', 'ask', 'approval', 'plan', 'review', 'autopilot', 'budget', 'terminal'])
        expect(appStore.capabilityPreset).toBe('standard')
        appStore.setCapabilities(['todo', 'plan'])
        expect(appStore.capabilityPreset).toBeUndefined()
        await vi.waitFor(() => expect(written).toEqual([{ enabled: 'standard' }, { enabled: ['todo', 'plan'] }]))
        // No longer in the app's own state.json.
        expect((appStore as any).prefsSnapshot()).not.toHaveProperty('capabilities')
        expect((appStore as any).prefsSnapshot()).not.toHaveProperty('approvalMode')
    })

    /** What a pi thread's process was started with; a different one restarts it once idle. */
    const launchKey = (thread: any) => thread.configKey()

    it('follows settings.json, whoever wrote it; a process restarts only when what it loaded changed', () => {
        appStore.newThread('/p')
        const thread = appStore.active!
        let key = launchKey(thread)
        expect(apply(state('full'))).toEqual(['todo', 'ask', 'approval', 'plan', 'subagent', 'review', 'autopilot', 'budget', 'terminal'])
        expect(appStore.capabilityPreset).toBe('full')
        expect(launchKey(thread)).not.toBe(key)
        key = launchKey(thread)
        // Only the approval mode changed: nothing to restart.
        apply(state('full', 'edits'))
        expect(appStore.approvalMode).toBe('edits')
        expect(launchKey(thread)).toBe(key)
        // Resources pi loads at startup (a package installed in the terminal): every process.
        apply(state('full', 'edits', { fingerprint: '["npm:pi-web-access"]' }))
        expect(launchKey(thread)).not.toBe(key)
    })

    it('a model\'s own compaction restarts only the threads on that model', () => {
        appStore.newThread('/p')
        const thread = appStore.active!
        thread.state = { model: { provider: 'a', id: 'b' } } as any
        const key = launchKey(thread)
        apply(state('standard', 'auto', { modelOverrides: { 'c/d': { reserveTokens: 1 } } }))
        expect(launchKey(thread)).toBe(key)
        apply(state('standard', 'auto', { modelOverrides: { 'c/d': { reserveTokens: 1 }, 'a/b': { reserveTokens: 2 } } }))
        expect(launchKey(thread)).not.toBe(key)
    })

    it('a failed write puts the saved choice back', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        ;(window as any).pi.setCapabilities = async () => {
            throw new Error('settings.json is not valid JSON; nothing was changed')
        }
        ;(window as any).pi.piSettings = async () => state('standard')
        appStore.setCapabilities([])
        expect(appStore.enabledCapabilities).toEqual([])
        await vi.waitFor(() => expect(appStore.capabilityPreset).toBe('standard'))
        error.mockRestore()
    })
})

describe('approval mode', () => {
    beforeEach(reset)
    afterEach(() => vi.unstubAllGlobals())

    it('is saved with the capabilities, once per change', async () => {
        const written: any[] = []
        vi.stubGlobal('window', { pi: { setCapabilities: async (patch: any) => {
            written.push(patch)
            return { fingerprint: '[]', modelOverrides: {}, capabilities: { ...resolveCapabilities('standard'), approvalMode: patch.approvalMode, saved: true } }
        } } })
        ;(appStore as any).approvalMode = 'auto'
        appStore.setApprovalMode('ask')
        appStore.setApprovalMode('ask')
        expect(appStore.approvalMode).toBe('ask')
        await vi.waitFor(() => expect(written).toEqual([{ approvalMode: 'ask' }]))
    })
})

describe('idle pi processes', () => {
    beforeEach(reset)

    /** stopAgent goes through the preload bridge; record which agent ids it was asked to stop. */
    const stopped: string[] = []
    beforeEach(() => {
        stopped.length = 0
        vi.stubGlobal('window', { pi: { agentStop: async (id: string) => void stopped.push(id) } })
        return () => vi.unstubAllGlobals()
    })

    /** Gives a tab a fake ready process; the returned check says whether it was stopped. */
    function live(key: string, lastUsed: number) {
        const thread = appStore.threads.get(key)!
        thread.agentId = `agent-${key}`
        thread.agentStatus = 'ready'
        thread.lastUsed = lastUsed
        return () => stopped.includes(`agent-${key}`)
    }

    it('stops only processes idle off screen for an hour', () => {
        const keys = openTabs(4)
        appStore.setPaneCapacity(100)
        appStore.focus(keys[3])
        const now = 10 * AGENT_IDLE_MS
        const stale = live(keys[0], now - AGENT_IDLE_MS)
        const recent = live(keys[1], now - AGENT_IDLE_MS + 60_000)
        const running = live(keys[2], 0)
        appStore.threads.get(keys[2])!.running = true
        const onScreen = live(keys[3], 0)

        appStore.stopIdleAgents(now)
        expect(stale()).toBe(true)
        expect(recent()).toBe(false)
        expect(running()).toBe(false)
        expect(onScreen()).toBe(false)
    })

    it('counts idle time from when a thread was last running or on screen', () => {
        const keys = openTabs(2)
        appStore.setPaneCapacity(100)
        appStore.focus(keys[1])
        const stop = live(keys[1], 0)
        appStore.stopIdleAgents(AGENT_IDLE_MS * 5)
        appStore.focus(keys[0])
        appStore.stopIdleAgents(AGENT_IDLE_MS * 5 + 60_000)
        expect(stop()).toBe(false)
        appStore.stopIdleAgents(AGENT_IDLE_MS * 6)
        expect(stop()).toBe(true)
    })
})

describe('moving projects between windows', () => {
    beforeEach(reset)

    it('hands a running thread over mid-stream, and its later events reach the new copy', async () => {
        appStore.windowProjects = ['/p', '/q']
        appStore.newThread('/p')
        const thread = appStore.active!
        thread.agentId = 'agent-1'
        thread.agentStatus = 'ready'
        appStore.registerAgent('agent-1', thread)
        thread.handleEvent({ type: 'agent_start' })
        thread.handleEvent({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } })
        thread.handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })
        thread.handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hel' } })
        thread.draft = 'half typed'

        const projects = await appStore.exportProjects(['/p'])
        expect(appStore.threads.has(thread.key)).toBe(false)
        expect(appStore.windowProjects).toEqual(['/q'])
        expect(appStore.tabsOf('/p')).toEqual([])

        // Crosses IPC as a structured clone.
        await appStore.importProjects(structuredClone(projects))
        const moved = appStore.threads.get(thread.key)!
        expect(moved).not.toBe(thread)
        expect(appStore.tabsOf('/p')).toEqual([moved])
        expect(appStore.windowProjects).toEqual(['/q', '/p'])
        expect(moved.running).toBe(true)
        expect(moved.agentId).toBe('agent-1')
        expect(moved.draft).toBe('half typed')

        moved.handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'lo' } })
        expect(moved.streaming?.content).toEqual([{ type: 'text', text: 'Hello' }])
        expect((appStore as any).agentThreads.get('agent-1')).toBe(moved)
    })

    it('waits for an end-of-run reload before the snapshot, so the copy is not left running', async () => {
        let finishLoad = () => {}
        vi.stubGlobal('window', {
            pi: {
                agentRequest: async () => ({ success: true, data: undefined }),
                readSession: () => new Promise(resolve => (finishLoad = () => resolve({ items: [] }))),
                notify: async () => {},
            },
        })
        vi.stubGlobal('document', { hasFocus: () => true })
        try {
            appStore.windowProjects = ['/p']
            appStore.newThread('/p')
            const thread = appStore.active!
            thread.agentId = 'agent-2'
            thread.agentStatus = 'ready'
            thread.sessionPath = '/s/p.jsonl'
            thread.running = true
            thread.handleEvent({ type: 'agent_settled' })
            const exporting = appStore.exportProjects(['/p'])
            await new Promise(r => setTimeout(r, 0))
            finishLoad()
            const [project] = await exporting
            expect(project.threads[0].running).toBe(false)
        }
        finally {
            vi.unstubAllGlobals()
        }
    })
})

describe('setup assistant and the default agent', () => {
    let saves: any[]
    beforeEach(() => {
        reset()
        saves = []
        vi.stubGlobal('window', { pi: {
            saveState: async (save: any) => void saves.push(save),
            agentStart: async () => {
                throw new Error('not in this test')
            },
        } })
        ;(appStore as any).applyPrefs({ projects: [], hiddenProjects: [], layout: 'split' }, false)
    })
    afterEach(() => {
        ;(appStore as any).ready = false
        appStore.setupRequested = false
        vi.unstubAllGlobals()
    })

    it('shows until this version was gone through, and again when opened from Settings', () => {
        expect(appStore.setupOpen).toBe(true)
        ;(appStore as any).applyPrefs({ setupDone: SETUP_VERSION - 1 }, true)
        expect(appStore.setupOpen).toBe(true)
        ;(appStore as any).applyPrefs({ setupDone: SETUP_VERSION }, true)
        expect(appStore.setupOpen).toBe(false)
        appStore.openSetup()
        expect(appStore.setupOpen).toBe(true)
    })

    it('new threads start with the default agent; an unknown one falls back to pi', () => {
        ;(appStore as any).applyPrefs({ defaultAgent: 'codex' }, true)
        appStore.newThread('/p')
        expect(appStore.active!.agent).toBe('codex')
        ;(appStore as any).applyPrefs({ defaultAgent: 'nonsense' }, true)
        expect(appStore.defaultAgent).toBe('pi')
        appStore.active!.pendingPrompt = { text: 'x', images: [], timestamp: 1 }
        appStore.newThread('/p')
        expect(appStore.active!.agent).toBe('pi')
    })

    it('finishing saves the choice for every window and moves an untouched new tab to it', async () => {
        ;(appStore as any).ready = true
        appStore.newThread('/p')
        const blank = appStore.active!
        appStore.openSetup()
        appStore.finishSetup('grok')
        expect(appStore.setupOpen).toBe(false)
        expect(appStore.defaultAgent).toBe('grok')
        await vi.waitFor(() => expect(blank.agent).toBe('grok'))
        expect(saves.at(-1).prefs).toMatchObject({ defaultAgent: 'grok', setupDone: SETUP_VERSION })
    })
})
