import type { SlashCommand } from '@shared/pi'
import { describe, expect, it } from 'vitest'
import { searchCommands } from '../features/Composer/CommandPicker'
import { GUI_HAS, pickable } from './guiCommands'

const cmd = (name: string, description = '', source: SlashCommand['source'] = 'skill'): SlashCommand => ({ name, description, source })

describe('the skills picker\'s list', () => {
    it('leaves out commands the app has a control for, and the internal gui- ones', () => {
        const all = [cmd('compact'), cmd('model'), cmd('review'), cmd('gui-rewind'), cmd('skill:deploy'), cmd('context'), cmd('init')]
        expect(pickable(all).map(c => c.name)).toEqual(['skill:deploy', 'context', 'init'])
    })

    it('says what stands in for each command it leaves out', () => {
        for (const [name, where] of Object.entries(GUI_HAS))
            expect(where.zh && where.en, name).toBeTruthy()
    })

    it('searches names and descriptions by every word', () => {
        const all = [cmd('deploy', 'ship to production'), cmd('lint', 'check style'), cmd('ship-it')]
        expect(searchCommands(all, '').map(c => c.name)).toEqual(['deploy', 'lint', 'ship-it'])
        expect(searchCommands(all, 'SHIP').map(c => c.name)).toEqual(['deploy', 'ship-it'])
        expect(searchCommands(all, 'ship prod').map(c => c.name)).toEqual(['deploy'])
        expect(searchCommands(all, 'nothing')).toEqual([])
    })
})
