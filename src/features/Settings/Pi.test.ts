import { describe, expect, it } from 'vitest'
import { changelogVersions } from './Pi'

describe('changelogVersions', () => {
    it('splits at version headings, newest first as written, and keeps their sub-headings', () => {
        const text = '# Changelog\n\nintro\n\n## [1.0.4] - 2026-10-06\n\n### Fixed\n- a\n\n## [1.0.3]\n\n- b\n'
        const versions = changelogVersions(text)
        expect(versions).toHaveLength(2)
        expect(versions[0]).toContain('### Fixed')
        expect(versions[0].startsWith('## [1.0.4]')).toBe(true)
        expect(versions[1]).toContain('- b')
    })

    it('has no versions in a text without headings', () => {
        expect(changelogVersions('just text')).toEqual([])
    })
})
