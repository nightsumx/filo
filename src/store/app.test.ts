import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    beforeEach(() => {
        reset()
        appStore.setCapabilities(['todo', 'ask', 'approval', 'plan', 'review', 'autopilot'])
    })
    const restore = (state: object) => {
        ;(appStore as any).restoreState(state)
        return appStore.enabledCapabilities
    }
    const saved = () => (appStore as any).prefsSnapshot().capabilities

    it('defaults to the standard preset and returns plain, cloneable arrays', () => {
        expect(appStore.enabledCapabilities).toEqual(['todo', 'ask', 'approval', 'plan', 'review', 'autopilot'])
        appStore.setCapabilities(['ask', 'bogus' as any, 'todo'])
        const ids = appStore.enabledCapabilities
        expect(ids).toEqual(['todo', 'ask'])
        // agentStart sends this over IPC; MobX proxies fail structured clone.
        expect(() => structuredClone(ids)).not.toThrow()
        appStore.setCapabilities([])
        expect(appStore.enabledCapabilities).toEqual([])
    })

    it('saves a preset by its id, so later additions to it reach users who chose it', () => {
        appStore.setCapabilities(['todo', 'ask', 'approval', 'plan', 'review', 'autopilot', 'terminal'])
        expect(saved()).toBe('standard')
        expect(appStore.capabilityPreset).toBe('standard')
        appStore.setCapabilities(['todo', 'plan'])
        expect(saved()).toEqual(['todo', 'plan'])
        expect(appStore.capabilityPreset).toBeUndefined()
        expect(restore({ capabilities: 'full' })).toEqual(['todo', 'ask', 'approval', 'plan', 'subagent', 'review', 'autopilot', 'terminal'])
        expect(appStore.capabilityPreset).toBe('full')
        expect(restore({ capabilities: 'lean' })).toEqual([])
        expect(restore({ capabilities: 'gone' })).toEqual(['todo', 'ask', 'approval', 'plan', 'review', 'autopilot', 'terminal'])
    })

    it('nothing saved is the standard preset', () => {
        expect(restore({})).toEqual(['todo', 'ask', 'approval', 'plan', 'review', 'autopilot', 'terminal'])
        expect(appStore.capabilityPreset).toBe('standard')
    })

    it('a list saved before presets were saved by id becomes the preset it was', () => {
        // Those builds could not offer review, autopilot or terminal, so a list without them still matches.
        expect(restore({ capabilities: ['todo', 'ask', 'approval', 'plan', 'subagent'] })).toEqual(['todo', 'ask', 'approval', 'plan', 'subagent', 'review', 'autopilot', 'terminal'])
        expect(appStore.capabilityPreset).toBe('full')
        expect(restore({ capabilities: ['todo', 'ask', 'approval', 'plan'] })).toEqual(['todo', 'ask', 'approval', 'plan', 'review', 'autopilot', 'terminal'])
        expect(restore({ capabilities: ['todo', 'ask', 'approval', 'plan', 'review', 'autopilot'] })).toEqual(['todo', 'ask', 'approval', 'plan', 'review', 'autopilot', 'terminal'])
        // Lean stays lean, and other lists stay as they are.
        expect(restore({ capabilities: [] })).toEqual([])
        expect(appStore.capabilityPreset).toBe('lean')
        expect(restore({ capabilities: ['plan', 'todo'] })).toEqual(['todo', 'plan'])
        expect(appStore.capabilityPreset).toBeUndefined()
    })

    it('restores the active project\'s set from the old per-project state', () => {
        const old = { capabilities: { '/a': ['todo'], '/b': ['todo', 'ask', 'subagent'] } }
        expect(restore({ ...old, activeProject: '/a' })).toEqual(['todo'])
        expect(restore({ ...old, activeProject: '/c' })).toEqual(['todo', 'ask', 'subagent'])
    })

    it('another window\'s choice applies here, by id or as a list', () => {
        ;(appStore as any).applyPrefs({ capabilities: 'lean' }, true)
        expect(appStore.enabledCapabilities).toEqual([])
        ;(appStore as any).applyPrefs({ capabilities: ['todo'] }, true)
        expect(appStore.enabledCapabilities).toEqual(['todo'])
    })
})

describe('approval mode', () => {
    beforeEach(reset)

    it('keeps one approval mode for all projects, reading the old per-project map once', () => {
        const restore = (state: object) => {
            ;(appStore as any).restoreState(state)
            return appStore.approvalMode
        }
        expect(restore({})).toBe('auto')
        expect(restore({ approvalMode: 'edits' })).toBe('edits')
        expect(restore({ approvalMode: 'bogus' })).toBe('auto')
        const old = { approvalModes: { '/a': 'auto', '/b': 'edits' } }
        expect(restore({ ...old, activeProject: '/a' })).toBe('auto')
        expect(restore({ ...old, activeProject: '/c' })).toBe('edits')
        appStore.setApprovalMode('ask')
        expect(appStore.approvalMode).toBe('ask')
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
