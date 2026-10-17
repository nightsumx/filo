// Commands an agent reports that the app already has a control for. The picker for skills and commands
// (features/Composer/CommandPicker.tsx) leaves them out, so there is one way to do each thing. The one
// list for every agent; each entry says what stands in for it. Anything not here (skills, prompt
// templates, an extension's or an agent's own commands) is the picker's.
import type { Localized } from '@shared/i18n'
import type { SlashCommand } from '@shared/pi'

export const GUI_HAS: Record<string, Localized> = {
    compact: { zh: '输入框旁的「压缩」按钮', en: 'the Compact button by the composer' },
    model: { zh: '输入框里的模型选择器', en: 'the model picker' },
    thinking: { zh: '输入框里的思考强度选择器', en: 'the thinking picker' },
    new: { zh: '加号（新线程）', en: 'the + button (new thread)' },
    clear: { zh: '加号（新线程）', en: 'the + button (new thread)' },
    resume: { zh: '搜索（⌘⇧F）', en: 'Search (⌘⇧F)' },
    diff: { zh: '改动面板', en: 'the changes panel' },
    name: { zh: '标签右键菜单 → 重命名', en: 'tab menu → Rename' },
    rename: { zh: '标签右键菜单 → 重命名', en: 'tab menu → Rename' },
    fork: { zh: '提问上的「从这里分叉」', en: 'Fork from here on a prompt' },
    clone: { zh: '标签右键菜单 → 克隆线程', en: 'tab menu → Clone thread' },
    tree: { zh: '回答上的「回到这里」', en: 'Rewind to here on an answer' },
    export: { zh: '标签右键菜单 → 导出为 HTML', en: 'tab menu → Export as HTML' },
    session: { zh: '标签右键菜单 → 会话信息', en: 'tab menu → Session info' },
    reload: { zh: '标签右键菜单 → 重新加载扩展和技能', en: 'tab menu → Reload extensions and skills' },
    hotkeys: { zh: '设置 → 快捷键', en: 'Settings → Shortcuts' },
    trust: { zh: '设置 → 项目信任', en: 'Settings → Project trust' },
    copy: { zh: '回答上的复制按钮', en: 'the Copy button on an answer' },
    settings: { zh: '设置', en: 'Settings' },
    config: { zh: '设置', en: 'Settings' },
    login: { zh: '设置 → 供应商', en: 'Settings → Providers' },
    logout: { zh: '设置 → 供应商', en: 'Settings → Providers' },
    exit: { zh: '关闭标签', en: 'close the tab' },
    quit: { zh: '关闭标签', en: 'close the tab' },
    // The app's own review and autopilot, which have their own controls (a different thing from an agent's /review).
    review: { zh: '审查（Filo 自己的）', en: 'Review (the app\'s own)' },
    'review-apply': { zh: '审查报告上的按钮', en: 'the buttons on a review report' },
    autopilot: { zh: '输入框里的 Autopilot 开关', en: 'the Autopilot switch' },
}

/** What the picker lists: the agent's commands without the ones the app has a control for. */
export function pickable(commands: readonly SlashCommand[]): SlashCommand[] {
    return commands.filter(c => !(c.name in GUI_HAS) && !c.name.startsWith('gui-'))
}
