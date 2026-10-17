// Settings → Shortcuts: every keyboard shortcut of the app (pi's /hotkeys). The list is src/lib/shortcuts.ts,
// the same one the key handlers read, so what is shown here is what works.
import { SettingRow, SettingsPage } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { SCOPE_TITLE, SHORTCUTS, shortcutKeys } from '@/lib/shortcuts'
import { observer } from 'mobx-react-lite'

const SCOPES = [...new Set(SHORTCUTS.map(s => s.scope))]

export const ShortcutsPage = observer(() => (
    <SettingsPage title={tr('快捷键', 'Shortcuts')}>
        {SCOPES.map(scope => (
            <div key={scope} role="group" aria-label={tr(SCOPE_TITLE[scope])} data-scope={scope}>
                <h3 className="pt-3 text-[12px] font-semibold text-[var(--jb-comment)]">{tr(SCOPE_TITLE[scope])}</h3>
                <div className="flex flex-col divide-y divide-[var(--jb-separator)]">
                    {SHORTCUTS.filter(s => s.scope === scope).map(s => (
                        <SettingRow
                            key={s.id}
                            title={tr(s.label)}
                            control={() => (
                                <span className="flex shrink-0 flex-wrap justify-end gap-1.5" data-shortcut={s.id}>
                                    {shortcutKeys(s.id).map(k => (
                                        <kbd key={k} className="rounded-[4px] bg-[var(--jb-fill)] px-1.5 py-0.5 font-sans text-[12px] text-gray-800">{k}</kbd>
                                    ))}
                                </span>
                            )}
                        />
                    ))}
                </div>
            </div>
        ))}
    </SettingsPage>
))
