import { beforeEach, describe, expect, it } from 'vitest'
import { appStore, MIN_PANE_WIDTH } from './app'

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
