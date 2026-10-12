import { describe, expect, it } from 'vitest'
import { npmName, packageState, withPackageEnabled } from './piPackages'

describe('pi packages in settings.json', () => {
    it('names npm sources, scoped and pinned ones too', () => {
        expect(npmName('npm:pi-web-access@0.37.0')).toBe('pi-web-access')
        expect(npmName('npm:pi-web-access')).toBe('pi-web-access')
        expect(npmName('npm:@scope/pkg@1.0.0')).toBe('@scope/pkg')
        expect(npmName('npm:@scope/pkg')).toBe('@scope/pkg')
        expect(npmName('git:github.com/x/pi-web-access')).toBeUndefined()
        expect(npmName(undefined)).toBeUndefined()
    })

    it('reads installed and on/off from either entry form', () => {
        expect(packageState({})).toEqual({ installed: false, enabled: false })
        expect(packageState({ packages: ['npm:pi-web-access-extra'] })).toEqual({ installed: false, enabled: false })
        expect(packageState({ packages: ['../local', 'npm:pi-web-access'] })).toEqual({ installed: true, enabled: true })
        expect(packageState({ packages: [{ source: 'npm:pi-web-access@0.37.0', skills: [] }] })).toEqual({ installed: true, enabled: true })
        expect(packageState({ packages: [{ source: 'npm:pi-web-access@0.37.0', extensions: [] }] })).toEqual({ installed: true, enabled: false })
    })

    it('turns it off and on, keeping its source, other filters and other packages', () => {
        const settings = { theme: 'dark', packages: ['npm:pi-cc-extensions', 'npm:pi-web-access@0.37.0'] }
        const off = withPackageEnabled(settings, false)
        expect(off).toEqual({ theme: 'dark', packages: ['npm:pi-cc-extensions', { source: 'npm:pi-web-access@0.37.0', extensions: [] }] })
        expect(withPackageEnabled(off, true)).toEqual(settings)
        const filtered = { packages: [{ source: 'npm:pi-web-access', skills: [], extensions: [] }] }
        expect(withPackageEnabled(filtered, true)).toEqual({ packages: [{ source: 'npm:pi-web-access', skills: [] }] })
        // Not installed: nothing to turn on.
        expect(withPackageEnabled({ theme: 'dark' }, true)).toEqual({ theme: 'dark' })
        expect(settings.packages[1]).toBe('npm:pi-web-access@0.37.0')
    })
})
