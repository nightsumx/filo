import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_IDLE_MS, appStore, MIN_PANE_WIDTH } from './app'

function reset() {
    appStore.threads.clear()
    appStore.tabsByProject = {}
    appStore.activeTabByProject = {}
    appStore.activeProject = null
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

describe('capabilities per project', () => {
    beforeEach(() => {
        reset()
        appStore.capabilitiesByProject = {}
    })

    it('defaults to the standard preset and returns plain, cloneable arrays', () => {
        expect(appStore.capabilitiesOf('/p')).toEqual(['todo', 'ask'])
        appStore.setCapabilities('/p', ['ask', 'bogus' as any, 'todo'])
        const ids = appStore.capabilitiesOf('/p')
        expect(ids).toEqual(['todo', 'ask'])
        // agentStart sends this over IPC; MobX proxies fail structured clone.
        expect(() => structuredClone(ids)).not.toThrow()
        appStore.setCapabilities('/p', [])
        expect(appStore.capabilitiesOf('/p')).toEqual([])
        expect(appStore.capabilitiesOf('/other')).toEqual(['todo', 'ask'])
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
