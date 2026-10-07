// Settings → 模型供应商: pi's providers with their sign-in state, sign-in flows (API key, OAuth,
// device code) run inline under the provider, and models.json endpoints (proxies for built-ins,
// custom OpenAI/Anthropic-compatible servers). Everything is pi's own auth.json and models.json, so
// the terminal pi sees the same setup.
import type { AuthMethod, Endpoint, EndpointModel, LoginNotice, LoginPrompt, LoginUpdate, ProviderInfo, ProvidersState } from '@shared/providers'
import { ENDPOINT_APIS } from '@shared/providers'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Comment, flatFieldClass, Segmented, SettingsPage, Switch } from '@/components/ui/form'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { appStore } from '@/store/app'
import { Check, Copy, ExternalLink, Loader2, MoreHorizontal, Plus, RefreshCw, Search, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

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

/** Where a row's inline panel is: a sign-in, or editing its models.json entry. */
type Editing = { kind: 'endpoint', id: string } | { kind: 'new' }

export const ProvidersPage = observer(() => {
    const [state, setState] = useState<ProvidersState | null>(null)
    const [loadError, setLoadError] = useState('')
    const [query, setQuery] = useState('')
    const [login, setLogin] = useState<LoginView | null>(null)
    const [editing, setEditing] = useState<Editing | null>(null)
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
        setEditing(null)
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

    const edit = (next: Editing | null) => {
        if (next)
            closeLogin()
        setEditing(next)
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
            if (editing?.kind === 'endpoint' && editing.id === p.id)
                setEditing(null)
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
    const shown = state.providers.filter(p => !needle || p.name.toLowerCase().includes(needle) || p.id.includes(needle))
    const configured = shown.filter(p => p.configured)
    const others = shown.filter(p => !p.configured)
    const total = state.providers.filter(p => p.configured).length
    const endpointOf = (id: string) => state.endpoints.find(e => e.id === id)

    const row = (p: ProviderInfo) => (
        <ProviderRow
            key={p.id}
            provider={p}
            endpoint={endpointOf(p.id)}
            onLogin={method => void startLogin(p.id, method)}
            onEdit={() => edit({ kind: 'endpoint', id: p.id })}
            onLogout={() => void logout(p)}
            onRemove={() => void removeEndpoint(p)}
        >
            {login?.provider === p.id && <LoginPanel login={login} onClose={closeLogin} onRetry={() => void startLogin(p.id, login.method)} />}
            {editing?.kind === 'endpoint' && editing.id === p.id && (
                <EndpointForm provider={p} endpoint={endpointOf(p.id)} onDone={() => setEditing(null)} />
            )}
        </ProviderRow>
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
                    <Button variant="outline" size="sm" onClick={() => edit(editing?.kind === 'new' ? null : { kind: 'new' })} aria-expanded={editing?.kind === 'new'}>
                        <Plus size={13} />
                        {tr('自定义端点', 'Custom endpoint')}
                    </Button>
                </div>
                {editing?.kind === 'new' && <EndpointForm onDone={() => setEditing(null)} />}
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

const ProviderRow = observer(function ProviderRow({ provider: p, endpoint, onLogin, onEdit, onLogout, onRemove, children }: {
    provider: ProviderInfo
    endpoint?: Endpoint
    onLogin: (method: AuthMethod) => void
    onEdit: () => void
    onLogout: () => void
    onRemove: () => void
    children: React.ReactNode
}) {
    const canKey = !!p.apiKey?.interactive
    const oauthLabel = p.oauth?.subscription ? tr('订阅登录', 'Subscription sign-in') : tr('账号登录', 'Sign in')
    const proxy = p.builtIn && endpoint?.baseUrl
    const details = [
        p.configured ? sourceText(p, endpoint) : '',
        p.configured ? tr(`${p.available} 个模型可用`, `${p.available === 1 ? '1 model' : `${p.available} models`} available`) : modelCount(p.models),
        proxy ? tr(`经由 ${endpoint.baseUrl}`, `via ${endpoint.baseUrl}`) : '',
        !p.builtIn && endpoint?.baseUrl ? endpoint.baseUrl : '',
    ].filter(Boolean).join(' · ')

    return (
        <div className="py-2">
            <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[13px] leading-5 text-gray-900">
                        {p.configured && <Check size={13} className="shrink-0 text-ide-success" aria-label={tr('已配置', 'Configured')} />}
                        <span className="truncate">{p.name}</span>
                        {!p.builtIn && <span className="shrink-0 rounded-[3px] bg-[var(--jb-fill)] px-1 text-[11px] text-[var(--jb-comment)]">{tr('自定义', 'Custom')}</span>}
                    </div>
                    <Comment className="truncate">{details}</Comment>
                </div>
                {!p.configured && canKey && <Button variant="outline" size="sm" onClick={() => onLogin('api_key')}>{tr('填写 API key', 'Enter API key')}</Button>}
                {!p.configured && p.oauth && <Button variant="outline" size="sm" title={p.oauth.label} onClick={() => onLogin('oauth')}>{oauthLabel}</Button>}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="w-7 px-0 text-gray-600" aria-label={tr(`${p.name} 的更多操作`, `More for ${p.name}`)}>
                            <MoreHorizontal size={14} />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                        {canKey && <DropdownMenuItem onSelect={() => onLogin('api_key')}>{p.stored === 'api_key' ? tr('更换 API key', 'Replace API key') : tr('填写 API key', 'Enter API key')}</DropdownMenuItem>}
                        {p.oauth && <DropdownMenuItem onSelect={() => onLogin('oauth')}>{p.stored === 'oauth' ? tr('重新登录', 'Sign in again') : oauthLabel}</DropdownMenuItem>}
                        <DropdownMenuItem onSelect={onEdit}>{p.builtIn ? tr('修改请求地址…', 'Change base URL…') : tr('编辑端点…', 'Edit endpoint…')}</DropdownMenuItem>
                        {(p.stored || !p.builtIn) && <DropdownMenuSeparator />}
                        {p.stored && <DropdownMenuItem onSelect={onLogout}>{p.stored === 'oauth' ? tr('退出登录', 'Sign out') : tr('删除保存的 key', 'Remove saved key')}</DropdownMenuItem>}
                        {!p.builtIn && <DropdownMenuItem onSelect={onRemove}>{tr('删除端点', 'Remove endpoint')}</DropdownMenuItem>}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            {children}
        </div>
    )
})

/** A sign-in in progress: what pi reports (browser link, device code, progress) and what it asks. */
const LoginPanel = observer(function LoginPanel({ login, onClose, onRetry }: { login: LoginView, onClose: () => void, onRetry: () => void }) {
    const progress = [...login.notices].reverse().find(n => n.type === 'progress')
    const notices = login.notices.filter(n => n.type !== 'progress')
    const waiting = !login.prompt && !login.error

    return (
        <div className="mt-2 flex flex-col gap-2.5 rounded-[6px] bg-[var(--jb-fill)] px-3 py-2.5">
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
 * A models.json entry. For a built-in provider only its base URL (a proxy or regional address); for
 * a custom one the API, key and models too. pi validates the result before it is kept.
 */
const EndpointForm = observer(function EndpointForm({ provider, endpoint, onDone }: { provider?: ProviderInfo, endpoint?: Endpoint, onDone: () => void }) {
    const isNew = !provider
    const builtIn = !!provider?.builtIn
    const [name, setName] = useState(endpoint?.name ?? (provider && !builtIn ? provider.name : ''))
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
            if (builtIn)
                await window.pi.saveEndpoint({ endpoint: { id: provider.id, baseUrl: baseUrl.trim() } })
            else
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
    const label = 'w-20 shrink-0 text-[12px] text-gray-700'
    const apiOptions = ENDPOINT_APIS.map(value => ({ value, label: API_LABELS[value].label }))
    if (!(ENDPOINT_APIS as readonly string[]).includes(api))
        apiOptions.push({ value: api as typeof ENDPOINT_APIS[number], label: api })
    const keyPlaceholder = provider?.stored === 'api_key'
        ? tr('已保存，留空保持不变', 'Saved; leave empty to keep it')
        : endpoint?.hasKey ? tr('models.json 里已有，留空保持不变', 'Set in models.json; leave empty to keep it') : 'sk-…'

    return (
        <form
            aria-labelledby={formId}
            className="mt-2 flex flex-col gap-2 rounded-[6px] bg-[var(--jb-fill)] px-3 py-2.5"
            onSubmit={(e) => {
                e.preventDefault()
                void save()
            }}
        >
            <div id={formId} className="text-[12px] font-medium text-gray-900">
                {isNew ? tr('添加自定义端点', 'Add a custom endpoint') : builtIn ? tr(`${provider.name} 的请求地址`, `Base URL for ${provider.name}`) : tr(`编辑 ${provider.name}`, `Edit ${provider.name}`)}
            </div>
            {builtIn && <Comment>{tr('走代理或区域地址时填写，留空用 pi 的默认地址。登录方式和模型列表不变。', 'For a proxy or regional address; leave empty for pi\'s default. Sign-in and models stay the same.')}</Comment>}
            {isNew && (
                <div className="flex flex-wrap items-center gap-1">
                    <span className="mr-1 text-[12px] text-[var(--jb-comment)]">{tr('本地服务：', 'Local servers:')}</span>
                    {LOCAL_PRESETS.map(p => <Button key={p.id} type="button" variant="ghost" size="sm" className="h-6 px-2 text-gray-700" onClick={() => applyPreset(p)}>{p.name}</Button>)}
                </div>
            )}
            {!builtIn && (
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
            )}
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
                <input className={cn(field, 'flex-1 font-mono')} value={baseUrl} spellCheck={false} placeholder={builtIn ? tr('默认', 'Default') : 'https://example.com/v1'} onChange={e => setBaseUrl(e.target.value)} />
            </label>
            {!builtIn && (
                <>
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
                </>
            )}
            {error && <div className={cn('whitespace-pre-wrap text-[12px]', DANGER)} role="alert">{error}</div>}
            <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={onDone}>{tr('取消', 'Cancel')}</Button>
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
