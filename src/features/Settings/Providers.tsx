// Settings → 模型供应商: pi's providers with their sign-in state. A row opens in place to show all of
// its settings at once: sign-in flows (API key, OAuth, device code) run inline there, next to the
// models.json endpoint (a proxy for a built-in, the whole OpenAI/Anthropic-compatible server for a
// custom one). Everything is pi's own auth.json and models.json, so
// the terminal pi sees the same setup.
import type { Localized } from '@shared/i18n'
import type { AuthMethod, Endpoint, EndpointModel, LoginNotice, LoginPrompt, LoginUpdate, ProviderInfo, ProvidersState } from '@shared/providers'
import { ENDPOINT_APIS, sortProviders } from '@shared/providers'
import { Button } from '@/components/ui/button'
import { Comment, flatFieldClass, Segmented, SettingsPage, Switch } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { appStore } from '@/store/app'
import { Check, ChevronRight, Copy, ExternalLink, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ProviderIcon } from './providerIcons'

const DANGER = 'text-[var(--sl-danger)]'

/** The message without Electron's "Error invoking remote method '…': Error:" prefix. */
function messageOf(error: any) {
    const text = String(error?.message ?? error)
    const marker = text.indexOf('\': ')
    if (!text.startsWith('Error invoking remote method') || marker < 0)
        return text
    const rest = text.slice(marker + 3)
    return rest.startsWith('Error: ') ? rest.slice(7) : rest
}

/** Short enough for the three to sit side by side; the full names are in the title. */
const API_LABELS: Record<string, { label: string, title: string }> = {
    'openai-completions': { label: 'OpenAI Chat', title: 'OpenAI Chat Completions (/chat/completions)' },
    'openai-responses': { label: 'OpenAI Responses', title: 'OpenAI Responses (/responses)' },
    'anthropic-messages': { label: 'Anthropic', title: 'Anthropic Messages (/v1/messages)' },
}

const modelCount = (n: number) => tr(`${n} 个模型`, n === 1 ? '1 model' : `${n} models`)

/** Local servers people run most; each speaks the OpenAI chat API without a key. */
const LOCAL_PRESETS = [
    { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
    { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
    { id: 'llama-cpp', name: 'llama.cpp', baseUrl: 'http://localhost:8080/v1' },
    { id: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000/v1' },
]

function sourceText(p: ProviderInfo, endpoint?: Endpoint) {
    if (p.stored === 'oauth')
        return tr('已登录账号', 'Signed in')
    if (p.stored === 'api_key')
        return tr('API key 已保存', 'API key saved')
    if (p.source === 'environment')
        return p.sourceLabel ? tr(`环境变量 ${p.sourceLabel}`, `Environment variable ${p.sourceLabel}`) : tr('来自环境变量', 'From the environment')
    if (p.source === 'models_json_key' && endpoint?.keyless)
        return tr('无需 key', 'No key needed')
    if (p.source === 'models_json_key' || p.source === 'models_json_command')
        return tr('models.json 里的 key', 'Key in models.json')
    if (p.source === 'runtime')
        return tr('启动参数里的 key', 'Key from a launch flag')
    return p.sourceLabel ?? tr('已配置', 'Configured')
}

interface LoginView {
    id: string
    provider: string
    method: AuthMethod
    notices: LoginNotice[]
    prompt?: { id: string, prompt: LoginPrompt }
    error?: string
}

export const ProvidersPage = observer(() => {
    const [state, setState] = useState<ProvidersState | null>(null)
    const [loadError, setLoadError] = useState('')
    const [query, setQuery] = useState('')
    const [login, setLogin] = useState<LoginView | null>(null)
    /** The provider whose row is open; one at a time, like the sign-in it may hold. */
    const [open, setOpen] = useState<string | null>(null)
    const [adding, setAdding] = useState(false)
    const revision = appStore.providersRevision
    const loginRef = useRef<LoginView | null>(null)
    loginRef.current = login

    useEffect(() => {
        let cancelled = false
        window.pi.providers()
            .then((s) => {
                if (!cancelled) {
                    setState(s)
                    setLoadError('')
                }
            })
            .catch(error => !cancelled && setLoadError(messageOf(error)))
        return () => {
            cancelled = true
        }
    }, [revision])

    useEffect(() => window.pi.onProviderLogin((update: LoginUpdate) => {
        setLogin((current) => {
            if (!current || current.id !== update.login)
                return current
            if ('notice' in update)
                return { ...current, notices: [...current.notices, update.notice] }
            if ('prompt' in update)
                return { ...current, prompt: { id: update.promptId, prompt: update.prompt } }
            if ('promptGone' in update)
                return current.prompt?.id === update.promptGone ? { ...current, prompt: undefined } : current
            if ('done' in update) {
                toast.success(current.method === 'oauth' ? tr('已登录', 'Signed in') : tr('已保存', 'Saved'))
                return null
            }
            return update.cancelled ? null : { ...current, prompt: undefined, error: update.error }
        })
    }), [])

    // Closing Settings leaves nobody to answer the flow's prompts.
    useEffect(() => () => {
        const current = loginRef.current
        if (current && !current.error)
            void window.pi.providerCancel(current.id)
    }, [])

    const startLogin = async (provider: string, method: AuthMethod) => {
        if (login && !login.error)
            await window.pi.providerCancel(login.id)
        setOpen(provider)
        try {
            const id = await window.pi.providerLogin(provider, method)
            setLogin({ id, provider, method, notices: [] })
        }
        catch (error) {
            toast.error(tr('无法开始登录', 'Could not start the sign-in'), { description: messageOf(error) })
        }
    }

    const closeLogin = () => {
        if (login && !login.error)
            void window.pi.providerCancel(login.id)
        setLogin(null)
    }

    // A sign-in left running in a closed row would ask questions nobody sees.
    const toggle = (provider: string) => {
        if (login && login.provider !== provider || open === provider)
            closeLogin()
        setOpen(open === provider ? null : provider)
    }

    const logout = async (p: ProviderInfo) => {
        try {
            await window.pi.providerLogout(p.id)
        }
        catch (error) {
            toast.error(tr('没能退出登录', 'Could not sign out'), { description: messageOf(error) })
        }
    }

    const removeEndpoint = async (p: ProviderInfo) => {
        try {
            await window.pi.removeEndpoint(p.id)
            if (open === p.id)
                setOpen(null)
        }
        catch (error) {
            toast.error(tr('没能删除', 'Could not remove it'), { description: messageOf(error) })
        }
    }

    const title = tr('模型供应商', 'Model providers')
    if (!state) {
        return (
            <SettingsPage title={title}>
                {loadError
                    ? <Comment className={cn('py-3', DANGER)}>{`${tr('读取 pi 的供应商失败：', 'Could not read pi\'s providers: ')}${loadError}`}</Comment>
                    : <Comment className="py-3">{tr('读取中…', 'Loading…')}</Comment>}
            </SettingsPage>
        )
    }

    const needle = query.trim().toLowerCase()
    const shown = sortProviders(state.providers).filter(p => !needle || p.name.toLowerCase().includes(needle) || p.id.includes(needle))
    const configured = shown.filter(p => p.configured)
    const others = shown.filter(p => !p.configured)
    const total = state.providers.filter(p => p.configured).length
    const endpointOf = (id: string) => state.endpoints.find(e => e.id === id)

    const row = (p: ProviderInfo) => (
        <ProviderRow
            key={p.id}
            provider={p}
            endpoint={endpointOf(p.id)}
            open={open === p.id}
            onToggle={() => toggle(p.id)}
            login={login?.provider === p.id ? login : undefined}
            onLogin={method => void startLogin(p.id, method)}
            onCloseLogin={closeLogin}
            onLogout={() => void logout(p)}
            onRemove={() => void removeEndpoint(p)}
            onClose={() => setOpen(null)}
        />
    )

    return (
        <SettingsPage title={title} aside={total ? tr(`${total} 个已配置`, `${total} configured`) : tr('还没有配置', 'None configured')}>
            <div className="py-3">
                <Comment>
                    {tr(
                        '登录信息存在 pi 的 auth.json，自定义端点存在 models.json，终端里的 pi 用的是同一份。改动后，打开的线程会在空闲时重启 pi，会话保留。',
                        'Sign-ins are saved to pi\'s auth.json and custom endpoints to models.json, the same files the terminal pi uses. After a change, open threads restart pi once idle and keep their session.',
                    )}
                </Comment>
                {state.modelsError && (
                    <Comment className={cn('mt-2 whitespace-pre-wrap', DANGER)}>
                        {`${tr('pi 无法加载 models.json，自定义端点暂时不可用：', 'pi could not load models.json, so custom endpoints are unavailable: ')}${state.modelsError}`}
                    </Comment>
                )}
                <div className="mt-3 flex items-center gap-2">
                    <label className="relative min-w-0 flex-1">
                        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--jb-comment)]" />
                        <input
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder={tr('搜索供应商', 'Search providers')}
                            aria-label={tr('搜索供应商', 'Search providers')}
                            className={cn(flatFieldClass, 'w-full pl-8')}
                        />
                    </label>
                    <Button variant="outline" size="sm" onClick={() => setAdding(v => !v)} aria-expanded={adding}>
                        <Plus size={13} />
                        {tr('自定义端点', 'Custom endpoint')}
                    </Button>
                </div>
                {adding && <EndpointForm onDone={() => setAdding(false)} />}
            </div>
            {configured.length > 0 && <GroupLabel>{tr('已配置', 'Configured')}</GroupLabel>}
            {configured.map(row)}
            {others.length > 0 && <GroupLabel>{configured.length ? tr('其他', 'Others') : tr('全部供应商', 'All providers')}</GroupLabel>}
            {others.map(row)}
            {!shown.length && <Comment className="py-3">{tr('没有匹配的供应商。', 'No matching provider.')}</Comment>}
        </SettingsPage>
    )
})

function GroupLabel({ children }: { children: React.ReactNode }) {
    return <div className="pb-1 pt-4 text-[12px] font-medium text-[var(--jb-comment)]">{children}</div>
}

/** Under an open row, lined up with the provider's name (icon 20px + gap 12px). */
const PANEL = 'ml-8 mt-1 flex flex-col gap-1.5 rounded-[6px] bg-[var(--jb-fill)] px-3 py-2'
const LINE_LABEL = 'w-20 shrink-0 text-[12px] text-gray-700'

/** What a provider's terms say about using its subscription outside its own app (checked 2026-10). */
const SUBSCRIPTION_NOTES: Record<string, Localized> = {
    anthropic: {
        zh: 'Anthropic 只允许官方 Claude Code 使用订阅额度；在第三方工具里登录 Claude 订阅按额外用量计费，也可能违反其服务条款。长期使用建议填 API key。',
        en: 'Anthropic only lets its own Claude Code use subscription limits; a Claude sign-in in third-party tools is billed as extra usage and may break its terms. An API key is the safer choice.',
    },
}

const ProviderRow = observer(function ProviderRow({ provider: p, endpoint, open, onToggle, login, onLogin, onCloseLogin, onLogout, onRemove, onClose }: {
    provider: ProviderInfo
    endpoint?: Endpoint
    open: boolean
    onToggle: () => void
    /** This provider's sign-in, while one runs. */
    login?: LoginView
    onLogin: (method: AuthMethod) => void
    onCloseLogin: () => void
    onLogout: () => void
    onRemove: () => void
    onClose: () => void
}) {
    const panelId = useId()
    const proxy = p.builtIn && endpoint?.baseUrl
    const details = [
        p.configured ? sourceText(p, endpoint) : '',
        p.configured ? tr(`${p.available} 个模型可用`, `${p.available === 1 ? '1 model' : `${p.available} models`} available`) : modelCount(p.models),
        proxy ? tr(`经由 ${endpoint.baseUrl}`, `via ${endpoint.baseUrl}`) : '',
        !p.builtIn && endpoint?.baseUrl ? endpoint.baseUrl : '',
    ].filter(Boolean).join(' · ')

    return (
        <div className="py-1">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                className="group/row -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-[6px] px-2 py-1.5 text-left outline-none hover:bg-ide-hover focus-visible:ring-2 focus-visible:ring-ide-accent/50"
            >
                <ProviderIcon id={p.id} name={p.name} size={20} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[13px] leading-5 text-gray-900">
                        {p.configured && <Check size={13} className="shrink-0 text-ide-success" aria-label={tr('已配置', 'Configured')} />}
                        <span className="truncate">{p.name}</span>
                        {!p.builtIn && <span className="shrink-0 rounded-[3px] bg-[var(--jb-fill)] px-1 text-[11px] text-[var(--jb-comment)]">{tr('自定义', 'Custom')}</span>}
                    </div>
                    <Comment className="truncate">{details}</Comment>
                </div>
                <ChevronRight aria-hidden size={14} className={cn('shrink-0 text-gray-400 transition-transform duration-150 group-hover/row:text-gray-800', open && 'rotate-90')} />
            </button>
            {open && (
                <div id={panelId}>
                    {p.builtIn
                        ? <BuiltInPanel provider={p} endpoint={endpoint} login={login} onLogin={onLogin} onCloseLogin={onCloseLogin} onLogout={onLogout} />
                        : (
                            <div className="ml-8">
                                <EndpointForm provider={p} endpoint={endpoint} onDone={onClose} onRemove={onRemove} />
                            </div>
                        )}
                </div>
            )}
        </div>
    )
})

/** Everything a built-in provider can set, laid out at once: API key, account sign-in, base URL. */
const BuiltInPanel = observer(function BuiltInPanel({ provider: p, endpoint, login, onLogin, onCloseLogin, onLogout }: {
    provider: ProviderInfo
    endpoint?: Endpoint
    login?: LoginView
    onLogin: (method: AuthMethod) => void
    onCloseLogin: () => void
    onLogout: () => void
}) {
    const canKey = !!p.apiKey?.interactive
    // A stored sign-in wins over the environment, so the key only counts when no account is signed in.
    const keySet = p.stored === 'api_key' || (p.configured && p.stored !== 'oauth')
    const keyStatus = p.stored === 'api_key'
        ? tr('已保存', 'Saved')
        : keySet ? sourceText(p, endpoint) : canKey ? tr('未设置', 'Not set') : tr('pi 从环境里读取', 'pi reads it from the environment')
    const signedIn = p.stored === 'oauth'
    const panel = (method: AuthMethod) => login?.method === method && (
        <LoginPanel login={login} onClose={onCloseLogin} onRetry={() => onLogin(method)} />
    )

    return (
        <div className={PANEL}>
            {p.apiKey && (
                <>
                    <div className="flex min-h-8 items-center gap-2">
                        <span className={LINE_LABEL}>{canKey ? 'API key' : tr('凭据', 'Credentials')}</span>
                        <span className={cn('min-w-0 flex-1 truncate text-[12px]', keySet ? 'text-gray-800' : 'text-[var(--jb-comment)]')} title={p.apiKey.label}>{keyStatus}</span>
                        {canKey && login?.method !== 'api_key' && (
                            <Button variant="outline" size="sm" onClick={() => onLogin('api_key')}>{p.stored === 'api_key' ? tr('更换', 'Replace') : tr('填写', 'Enter')}</Button>
                        )}
                        {p.stored === 'api_key' && <Button variant="ghost" size="sm" className="text-gray-600" onClick={onLogout}>{tr('删除', 'Remove')}</Button>}
                    </div>
                    {panel('api_key')}
                </>
            )}
            {p.oauth && (
                <>
                    <div className="flex min-h-8 items-center gap-2">
                        <span className={LINE_LABEL}>{p.oauth.subscription ? tr('订阅', 'Subscription') : tr('账号', 'Account')}</span>
                        <span className={cn('min-w-0 flex-1 truncate text-[12px]', signedIn ? 'text-gray-800' : 'text-[var(--jb-comment)]')}>
                            {[signedIn ? tr('已登录', 'Signed in') : tr('未登录', 'Not signed in'), p.oauth.label !== p.name ? p.oauth.label : ''].filter(Boolean).join(' · ')}
                        </span>
                        {login?.method !== 'oauth' && (
                            <Button variant="outline" size="sm" onClick={() => onLogin('oauth')}>{signedIn ? tr('重新登录', 'Sign in again') : tr('登录', 'Sign in')}</Button>
                        )}
                        {signedIn && <Button variant="ghost" size="sm" className="text-gray-600" onClick={onLogout}>{tr('退出', 'Sign out')}</Button>}
                    </div>
                    {SUBSCRIPTION_NOTES[p.id] && <p className="pb-1 pl-[88px] text-[11.5px] leading-relaxed text-[var(--jb-comment)]">{tr(SUBSCRIPTION_NOTES[p.id])}</p>}
                    {panel('oauth')}
                </>
            )}
            <BaseUrlLine provider={p} endpoint={endpoint} />
        </div>
    )
})

/** A built-in provider's models.json baseUrl: a proxy or regional address, empty for pi's own. */
const BaseUrlLine = observer(function BaseUrlLine({ provider, endpoint }: { provider: ProviderInfo, endpoint?: Endpoint }) {
    const saved = endpoint?.baseUrl ?? ''
    const [value, setValue] = useState(saved)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const id = useId()
    // Saving rereads models.json, which normalises the address (no trailing slash).
    useEffect(() => setValue(saved), [saved])
    const dirty = value.trim() !== saved

    const save = async () => {
        setBusy(true)
        setError('')
        try {
            await window.pi.saveEndpoint({ endpoint: { id: provider.id, baseUrl: value.trim() } })
            toast.success(tr('已保存', 'Saved'))
        }
        catch (e) {
            setError(messageOf(e))
        }
        finally {
            setBusy(false)
        }
    }

    return (
        <form
            className="flex flex-col gap-1"
            onSubmit={(e) => {
                e.preventDefault()
                if (dirty)
                    void save()
            }}
        >
            <div className="flex min-h-8 items-center gap-2">
                <label htmlFor={id} className={LINE_LABEL}>{tr('请求地址', 'Base URL')}</label>
                <input
                    id={id}
                    className={cn(flatFieldClass, 'min-w-0 flex-1 bg-[var(--jb-dialog-bg)] font-mono')}
                    value={value}
                    spellCheck={false}
                    placeholder={tr('默认；走代理或区域地址时填写', 'Default; set for a proxy or regional address')}
                    onChange={(e) => {
                        setValue(e.target.value)
                        setError('')
                    }}
                />
                {dirty && (
                    <>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setValue(saved)}>{tr('撤销', 'Revert')}</Button>
                        <Button type="submit" variant="primary" size="sm" disabled={busy}>
                            {busy && <Loader2 size={13} className="animate-spin" />}
                            {tr('保存', 'Save')}
                        </Button>
                    </>
                )}
            </div>
            {error && <div className={cn('whitespace-pre-wrap pl-[88px] text-[12px]', DANGER)} role="alert">{error}</div>}
        </form>
    )
})

/** A sign-in in progress: what pi reports (browser link, device code, progress) and what it asks. */
const LoginPanel = observer(function LoginPanel({ login, onClose, onRetry }: { login: LoginView, onClose: () => void, onRetry: () => void }) {
    const progress = [...login.notices].reverse().find(n => n.type === 'progress')
    const notices = login.notices.filter(n => n.type !== 'progress')
    const waiting = !login.prompt && !login.error

    return (
        <div className="flex flex-col gap-2.5 pb-1.5 pl-[88px]">
            {notices.map((n, i) => <NoticeView key={i} notice={n} />)}
            {login.prompt && <PromptView key={login.prompt.id} login={login.id} promptId={login.prompt.id} prompt={login.prompt.prompt} />}
            {waiting && (
                <div className="flex items-center gap-2 text-[12px] text-gray-600" role="status">
                    <Loader2 size={13} className="animate-spin" />
                    {progress?.type === 'progress' ? progress.message : tr('等待中…', 'Waiting…')}
                </div>
            )}
            {login.error && <div className={cn('whitespace-pre-wrap text-[12px]', DANGER)} role="alert">{login.error}</div>}
            <div className="flex justify-end gap-2">
                {login.error && <Button variant="outline" size="sm" onClick={onRetry}>{tr('重试', 'Retry')}</Button>}
                <Button variant="ghost" size="sm" onClick={onClose}>{login.error ? tr('关闭', 'Close') : tr('取消', 'Cancel')}</Button>
            </div>
        </div>
    )
})

const CopyButton = observer(function CopyButton({ text, label }: { text: string, label: string }) {
    const [copied, setCopied] = useState(false)
    return (
        <Button
            variant="ghost"
            size="sm"
            className="px-2 text-gray-600"
            onClick={() => void navigator.clipboard.writeText(text).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
            })}
        >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? tr('已复制', 'Copied') : label}
        </Button>
    )
})

const NoticeView = observer(function NoticeView({ notice }: { notice: LoginNotice }) {
    const opened = useRef(false)
    // The user just asked to sign in, so the browser opens right away, as in the terminal pi.
    useEffect(() => {
        if (notice.type === 'auth_url' && !opened.current) {
            opened.current = true
            void window.pi.openExternal(notice.url)
        }
    }, [notice])

    if (notice.type === 'auth_url') {
        return (
            <div className="flex flex-col gap-1.5">
                <div className="text-[12px] text-gray-800">{notice.instructions || tr('已在浏览器中打开登录页，完成后回到这里。', 'The sign-in page opened in your browser; come back here when done.')}</div>
                <div className="flex flex-wrap items-center gap-1">
                    <Button variant="outline" size="sm" onClick={() => void window.pi.openExternal(notice.url)}>
                        <ExternalLink size={13} />
                        {tr('再次打开浏览器', 'Open the browser again')}
                    </Button>
                    <CopyButton text={notice.url} label={tr('复制链接', 'Copy link')} />
                </div>
            </div>
        )
    }
    if (notice.type === 'device_code') {
        return (
            <div className="flex flex-col gap-1.5">
                <div className="text-[12px] text-gray-800">{tr(`在 ${notice.verificationUri} 输入这个代码：`, `Enter this code at ${notice.verificationUri}:`)}</div>
                <div className="flex flex-wrap items-center gap-2">
                    <code className="select-text rounded-[4px] bg-[var(--jb-dialog-bg)] px-2 py-0.5 font-mono text-[15px] tracking-wider text-gray-900">{notice.userCode}</code>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void navigator.clipboard.writeText(notice.userCode).finally(() => void window.pi.openExternal(notice.verificationUri))}
                    >
                        <ExternalLink size={13} />
                        {tr('复制代码并打开', 'Copy code and open')}
                    </Button>
                </div>
            </div>
        )
    }
    if (notice.type === 'info') {
        return (
            <div className="flex flex-col gap-1 text-[12px] text-gray-800">
                <div className="whitespace-pre-wrap">{notice.message}</div>
                {notice.links?.map(link => (
                    <button key={link.url} type="button" className="self-start text-ide-accent hover:underline" onClick={() => void window.pi.openExternal(link.url)}>
                        {link.label || link.url}
                    </button>
                ))}
            </div>
        )
    }
    return null
})

const PromptView = observer(function PromptView({ login, promptId, prompt }: { login: string, promptId: string, prompt: LoginPrompt }) {
    const [value, setValue] = useState('')
    const [sent, setSent] = useState(false)
    const id = useId()
    const answer = (v: string) => {
        setSent(true)
        void window.pi.providerAnswer(login, promptId, v)
    }

    if (prompt.type === 'select') {
        return (
            <div className="flex flex-col gap-1.5">
                <div className="text-[12px] text-gray-800">{prompt.message}</div>
                <div className="flex flex-col gap-1">
                    {prompt.options.map(o => (
                        <button
                            key={o.id}
                            type="button"
                            disabled={sent}
                            onClick={() => answer(o.id)}
                            className="flex flex-col items-start rounded-[6px] bg-[var(--jb-dialog-bg)] px-3 py-1.5 text-left outline-none hover:bg-ide-hover focus-visible:ring-2 focus-visible:ring-ide-accent/50 disabled:opacity-50"
                        >
                            <span className="text-[13px] text-gray-900">{o.label}</span>
                            {o.description && <span className="text-[12px] text-[var(--jb-comment)]">{o.description}</span>}
                        </button>
                    ))}
                </div>
            </div>
        )
    }
    return (
        <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
                e.preventDefault()
                if (value.trim())
                    answer(value.trim())
            }}
        >
            <label htmlFor={id} className="text-[12px] text-gray-800">{prompt.message}</label>
            <div className="flex gap-2">
                <input
                    id={id}
                    autoFocus
                    type={prompt.type === 'secret' ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    value={value}
                    disabled={sent}
                    placeholder={prompt.placeholder ?? (prompt.type === 'manual_code' ? tr('或者把浏览器给出的代码或网址粘贴到这里', 'Or paste the code or URL the browser shows') : '')}
                    onChange={e => setValue(e.target.value)}
                    className={cn(flatFieldClass, 'min-w-0 flex-1 bg-[var(--jb-dialog-bg)] font-mono')}
                />
                <Button type="submit" variant="primary" size="sm" disabled={sent || !value.trim()}>{tr('确定', 'OK')}</Button>
            </div>
        </form>
    )
})

interface ModelDraft {
    id: string
    name?: string
    /** Thousands of tokens, as typed. */
    contextK: string
    images: boolean
    reasoning?: boolean
    maxTokens?: number
}

const draftOf = (m: EndpointModel): ModelDraft => ({
    id: m.id,
    name: m.name,
    contextK: m.contextWindow ? String(Math.round(m.contextWindow / 1000)) : '',
    images: !!m.images,
    reasoning: m.reasoning,
    maxTokens: m.maxTokens,
})

/**
 * A custom provider's models.json entry: address, API, key and models. pi validates the result before
 * it is kept.
 */
const EndpointForm = observer(function EndpointForm({ provider, endpoint, onDone, onRemove }: { provider?: ProviderInfo, endpoint?: Endpoint, onDone: () => void, onRemove?: () => void }) {
    const isNew = !provider
    const [name, setName] = useState(endpoint?.name ?? provider?.name ?? '')
    const [id, setId] = useState(provider?.id ?? '')
    const [idTouched, setIdTouched] = useState(false)
    const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? '')
    const [api, setApi] = useState(endpoint?.api ?? 'openai-completions')
    const [apiKey, setApiKey] = useState('')
    const [keyless, setKeyless] = useState(isNew ? false : !!endpoint?.keyless)
    const [models, setModels] = useState<ModelDraft[]>((endpoint?.models ?? []).map(draftOf))
    const [error, setError] = useState('')
    const [busy, setBusy] = useState<'' | 'save' | 'fetch'>('')
    const formId = useId()
    const keylessId = useId()

    const slug = (text: string) => {
        let out = ''
        for (const ch of text.trim().toLowerCase()) {
            if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '.' || ch === '_' || ch === '-')
                out += ch
            else if (out && !out.endsWith('-'))
                out += '-'
        }
        return out.endsWith('-') ? out.slice(0, -1) : out
    }

    const applyPreset = (preset: typeof LOCAL_PRESETS[number]) => {
        setName(preset.name)
        setId(preset.id)
        setBaseUrl(preset.baseUrl)
        setApi('openai-completions')
        setKeyless(true)
        setError('')
    }

    const fetchModels = async () => {
        setBusy('fetch')
        setError('')
        try {
            const found = await window.pi.endpointModels(baseUrl.trim(), api, keyless ? undefined : apiKey.trim() || undefined, isNew ? undefined : provider?.id)
            setModels((current) => {
                const known = new Set(current.map(m => m.id))
                return [...current.filter(m => m.id.trim()), ...found.filter(m => !known.has(m.id)).map(draftOf)]
            })
        }
        catch (e) {
            setError(`${tr('没能获取模型列表：', 'Could not list the models: ')}${messageOf(e)}`)
        }
        finally {
            setBusy('')
        }
    }

    const save = async () => {
        setBusy('save')
        setError('')
        try {
            const endpointModels: EndpointModel[] = models.filter(m => m.id.trim()).map(m => ({
                id: m.id.trim(),
                name: m.name,
                contextWindow: m.contextK.trim() ? Math.round(Number(m.contextK) * 1000) : undefined,
                maxTokens: m.maxTokens,
                reasoning: m.reasoning,
                images: m.images,
            }))
            await window.pi.saveEndpoint({ endpoint: { id: id.trim(), name: name.trim() || undefined, baseUrl: baseUrl.trim(), api, models: endpointModels }, apiKey: keyless ? undefined : apiKey.trim() || undefined, keyless, create: isNew })
            toast.success(tr('已保存', 'Saved'))
            onDone()
        }
        catch (e) {
            setError(messageOf(e))
        }
        finally {
            setBusy('')
        }
    }

    const field = cn(flatFieldClass, 'min-w-0 bg-[var(--jb-dialog-bg)]')
    const label = LINE_LABEL
    const apiOptions = ENDPOINT_APIS.map(value => ({ value, label: API_LABELS[value].label }))
    if (!(ENDPOINT_APIS as readonly string[]).includes(api))
        apiOptions.push({ value: api as typeof ENDPOINT_APIS[number], label: api })
    const keyPlaceholder = provider?.stored === 'api_key'
        ? tr('已保存，留空保持不变', 'Saved; leave empty to keep it')
        : endpoint?.hasKey ? tr('models.json 里已有，留空保持不变', 'Set in models.json; leave empty to keep it') : 'sk-…'

    return (
        <form
            aria-labelledby={isNew ? formId : undefined}
            aria-label={isNew ? undefined : provider.name}
            className="mt-2 flex flex-col gap-2 rounded-[6px] bg-[var(--jb-fill)] px-3 py-2.5"
            onSubmit={(e) => {
                e.preventDefault()
                void save()
            }}
        >
            {isNew && <div id={formId} className="text-[12px] font-medium text-gray-900">{tr('添加自定义端点', 'Add a custom endpoint')}</div>}
            {isNew && (
                <div className="flex flex-wrap items-center gap-1">
                    <span className="mr-1 text-[12px] text-[var(--jb-comment)]">{tr('本地服务：', 'Local servers:')}</span>
                    {LOCAL_PRESETS.map(p => (
                        <Button key={p.id} type="button" variant="ghost" size="sm" className="h-6 px-2 text-gray-700" onClick={() => applyPreset(p)}>
                            <ProviderIcon id={p.id} name={p.name} size={13} />
                            {p.name}
                        </Button>
                    ))}
                </div>
            )}
            <label className="flex items-center gap-2">
                <span className={label}>{tr('名称', 'Name')}</span>
                <input
                    className={cn(field, 'flex-1')}
                    value={name}
                    placeholder={tr('例如：公司网关', 'e.g. Company gateway')}
                    onChange={(e) => {
                        setName(e.target.value)
                        if (isNew && !idTouched)
                            setId(slug(e.target.value))
                    }}
                />
            </label>
            {isNew && (
                <label className="flex items-center gap-2">
                    <span className={label}>ID</span>
                    <input
                        className={cn(field, 'flex-1 font-mono')}
                        value={id}
                        spellCheck={false}
                        placeholder="my-gateway"
                        onChange={(e) => {
                            setId(e.target.value)
                            setIdTouched(true)
                        }}
                    />
                </label>
            )}
            <label className="flex items-center gap-2">
                <span className={label}>{tr('地址', 'Base URL')}</span>
                <input className={cn(field, 'flex-1 font-mono')} value={baseUrl} spellCheck={false} placeholder="https://example.com/v1" onChange={e => setBaseUrl(e.target.value)} />
            </label>
            <div className="flex items-center gap-2">
                <span className={label}>{tr('接口', 'API')}</span>
                <span className="text-[12px]" title={API_LABELS[api]?.title}>
                    <Segmented value={api as typeof ENDPOINT_APIS[number]} options={apiOptions} onChange={setApi} />
                </span>
            </div>
            <div className="flex items-center gap-2">
                <span className={label}>API key</span>
                <input
                    className={cn(field, 'flex-1 font-mono', keyless && 'opacity-50')}
                    type="password"
                    autoComplete="off"
                    disabled={keyless}
                    value={apiKey}
                    placeholder={keyless ? tr('不需要', 'Not needed') : keyPlaceholder}
                    aria-label="API key"
                    onChange={e => setApiKey(e.target.value)}
                />
                <span id={keylessId} className="text-[12px] text-gray-700">{tr('不需要 key', 'No key')}</span>
                <Switch labelledBy={keylessId} checked={keyless} onChange={setKeyless} />
            </div>
            <div className="flex items-start gap-2">
                <span className={cn(label, 'pt-1.5')}>{tr('模型', 'Models')}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    {models.length > 0 && (
                        <div className="flex gap-2 text-[11px] text-[var(--jb-comment)]">
                            <span className="flex-1">ID</span>
                            <span className="w-[76px]">{tr('上下文 (K)', 'Context (K)')}</span>
                            <span className="w-[64px]">{tr('图片', 'Images')}</span>
                            <span className="w-7" />
                        </div>
                    )}
                    <div className="flex max-h-[220px] flex-col gap-1 overflow-y-auto">
                        {models.map((m, i) => (
                            <ModelRow
                                key={i}
                                model={m}
                                onChange={next => setModels(list => list.map((x, j) => (j === i ? next : x)))}
                                onRemove={() => setModels(list => list.filter((_, j) => j !== i))}
                            />
                        ))}
                    </div>
                    <div className="flex items-center gap-1">
                        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-gray-700" onClick={() => setModels(list => [...list, { id: '', contextK: '', images: false }])}>
                            <Plus size={13} />
                            {tr('添加', 'Add')}
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-gray-700" disabled={!baseUrl.trim() || busy !== ''} onClick={() => void fetchModels()}>
                            {busy === 'fetch' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                            {tr('从端点获取', 'Fetch from the endpoint')}
                        </Button>
                    </div>
                </div>
            </div>
            {error && <div className={cn('whitespace-pre-wrap text-[12px]', DANGER)} role="alert">{error}</div>}
            <div className="flex justify-end gap-2">
                {onRemove && <Button type="button" variant="ghost" size="sm" className={cn('mr-auto', DANGER)} onClick={onRemove}>{tr('删除端点', 'Remove endpoint')}</Button>}
                <Button type="button" variant="ghost" size="sm" onClick={onDone}>{isNew ? tr('取消', 'Cancel') : tr('收起', 'Close')}</Button>
                <Button type="submit" variant="primary" size="sm" disabled={busy !== ''}>
                    {busy === 'save' && <Loader2 size={13} className="animate-spin" />}
                    {tr('保存', 'Save')}
                </Button>
            </div>
        </form>
    )
})

const ModelRow = observer(function ModelRow({ model, onChange, onRemove }: { model: ModelDraft, onChange: (m: ModelDraft) => void, onRemove: () => void }) {
    const imagesId = useId()
    const field = cn(flatFieldClass, 'h-7 min-w-0 bg-[var(--jb-dialog-bg)] px-2')
    return (
        <div className="flex items-center gap-2">
            <input className={cn(field, 'flex-1 font-mono')} value={model.id} spellCheck={false} placeholder="qwen3:8b" aria-label={tr('模型 ID', 'Model ID')} onChange={e => onChange({ ...model, id: e.target.value })} />
            <input
                className={cn(field, 'w-[76px] text-right tabular-nums')}
                value={model.contextK}
                inputMode="numeric"
                placeholder={tr('默认', 'auto')}
                aria-label={tr('上下文窗口（千 tokens）', 'Context window (thousands of tokens)')}
                onChange={e => onChange({ ...model, contextK: e.target.value })}
            />
            <span className="flex w-[64px] items-center">
                <span id={imagesId} className="sr-only">{tr(`${model.id || '模型'} 接受图片`, `${model.id || 'Model'} accepts images`)}</span>
                <Switch labelledBy={imagesId} checked={model.images} onChange={images => onChange({ ...model, images })} />
            </span>
            <Button type="button" variant="ghost" size="sm" className="w-7 px-0 text-gray-500" aria-label={tr(`移除 ${model.id}`, `Remove ${model.id}`)} onClick={onRemove}>
                <X size={13} />
            </Button>
        </div>
    )
})
