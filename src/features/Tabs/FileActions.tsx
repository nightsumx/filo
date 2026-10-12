// Editor tab actions, in the tab's right-click menu and the tab bar's ⋯ menu (parts passed in, as
// for ThreadActions).
import type { FileTab } from '@/store/fileTab'
import { appStore } from '@/store/app'
import { fileTreeStore } from '@/store/fileTree'
import copy from 'copy-to-clipboard'
import { ClipboardCopy, ExternalLink, FolderOpen, LocateFixed, Save, X, XCircle } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { tr } from '@/lib/i18n'
import { insideOf, keys, showInFolderLabel } from '@/platform'
import { closeOthers, closeTabWithConfirm } from './ThreadActions'

interface MenuParts {
    Item: React.ComponentType<{ onSelect?: () => void, disabled?: boolean, className?: string, children: React.ReactNode }>
    Separator: React.ComponentType
}

/** The file tree view with the file selected in it. */
export function revealInTree(tab: FileTab) {
    appStore.setSidebarView('files')
    if (!appStore.sidebarOpen)
        appStore.toggleSidebar()
    void fileTreeStore.reveal(tab.path, tab.cwd)
}

export const FileActions = observer(({ tab, parts: { Item, Separator } }: { tab: FileTab, parts: MenuParts }) => {
    const hasOthers = appStore.tabItemsOf(tab.cwd).length > 1
    return (
        <>
            <Item disabled={!tab.dirty && !tab.deleted} onSelect={() => void tab.save('explicit')}>
                <Save size={14} />
                <span className="flex-1">{tr('保存', 'Save')}</span>
                <span className="text-[11px] text-gray-400">{keys('⌘S')}</span>
            </Item>
            <Item onSelect={() => revealInTree(tab)}>
                <LocateFixed size={14} />
                {tr('在文件树中定位', 'Locate in file tree')}
            </Item>
            <Item onSelect={() => copy(tab.path)}>
                <ClipboardCopy size={14} />
                {tr('复制路径', 'Copy path')}
            </Item>
            <Item onSelect={() => copy(insideOf(tab.path, tab.cwd) ?? tab.path)}>
                <ClipboardCopy size={14} />
                {tr('复制相对路径', 'Copy relative path')}
            </Item>
            <Item onSelect={() => void window.pi.revealPath(tab.path)}>
                <FolderOpen size={14} />
                {showInFolderLabel()}
            </Item>
            <Item onSelect={() => void window.pi.openFolder(tab.path)}>
                <ExternalLink size={14} />
                {tr('用默认应用打开', 'Open in default app')}
            </Item>
            <Separator />
            <Item onSelect={() => void closeTabWithConfirm(tab)}>
                <X size={14} />
                <span className="flex-1">{tr('关闭标签', 'Close tab')}</span>
                <span className="text-[11px] text-gray-400">{keys('⌘W')}</span>
            </Item>
            <Item disabled={!hasOthers} onSelect={() => void closeOthers(tab)}>
                <XCircle size={14} />
                {tr('关闭其他标签', 'Close other tabs')}
            </Item>
        </>
    )
})
