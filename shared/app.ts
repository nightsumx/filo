/** Product info shown in the About panel, the window title and the sidebar. Keep in sync with package.json and index.html. */
export const APP_INFO = {
    name: 'Filo',
    tagline: { zh: '编码 Agent 的 Mac 工作台', en: 'A Mac workbench for coding agents' },
    description: {
        zh: '多个项目、多个线程并行运行 pi、Codex、Claude Code 等 Agent，侧边栏实时显示每个线程在做什么。需要你回答时直接在对话里提问，窗口在后台时发系统通知。任务清单、提问等能力可以开关，上下文压缩与终端 pi 共用设置。',
        en: 'Run pi, Codex, Claude Code and other agents across many projects and threads at once, with the sidebar showing what each thread is doing. Questions come up right in the conversation, and you get a system notification when the window is in the background. Capabilities like todo lists and questions can be switched on and off; compaction settings are shared with pi in the terminal.',
    },
    author: 'sum',
    homepage: 'https://filoapp.dev',
} as const
