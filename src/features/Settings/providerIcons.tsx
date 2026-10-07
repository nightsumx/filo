// Brand icons for Settings → 模型供应商, from LobeHub's icon set (MIT). The color version where there
// is one; the others draw in currentColor, so they follow the theme. Only the icons named here end
// up in the bundle.
import antgroup from '@lobehub/icons-static-svg/icons/antgroup-color.svg?raw'
import anthropic from '@lobehub/icons-static-svg/icons/anthropic.svg?raw'
import azure from '@lobehub/icons-static-svg/icons/azure-color.svg?raw'
import baseten from '@lobehub/icons-static-svg/icons/baseten.svg?raw'
import bedrock from '@lobehub/icons-static-svg/icons/bedrock-color.svg?raw'
import cerebras from '@lobehub/icons-static-svg/icons/cerebras-color.svg?raw'
import cloudflare from '@lobehub/icons-static-svg/icons/cloudflare-color.svg?raw'
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw'
import fireworks from '@lobehub/icons-static-svg/icons/fireworks-color.svg?raw'
import githubcopilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg?raw'
import google from '@lobehub/icons-static-svg/icons/google-color.svg?raw'
import groq from '@lobehub/icons-static-svg/icons/groq.svg?raw'
import huggingface from '@lobehub/icons-static-svg/icons/huggingface-color.svg?raw'
import kimi from '@lobehub/icons-static-svg/icons/kimi-color.svg?raw'
import lmstudio from '@lobehub/icons-static-svg/icons/lmstudio.svg?raw'
import meta from '@lobehub/icons-static-svg/icons/meta-color.svg?raw'
import minimax from '@lobehub/icons-static-svg/icons/minimax-color.svg?raw'
import mistral from '@lobehub/icons-static-svg/icons/mistral-color.svg?raw'
import moonshot from '@lobehub/icons-static-svg/icons/moonshot.svg?raw'
import nvidia from '@lobehub/icons-static-svg/icons/nvidia-color.svg?raw'
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg?raw'
import openai from '@lobehub/icons-static-svg/icons/openai.svg?raw'
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg?raw'
import openrouter from '@lobehub/icons-static-svg/icons/openrouter.svg?raw'
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg?raw'
import together from '@lobehub/icons-static-svg/icons/together-color.svg?raw'
import vercel from '@lobehub/icons-static-svg/icons/vercel.svg?raw'
import vertexai from '@lobehub/icons-static-svg/icons/vertexai-color.svg?raw'
import vllm from '@lobehub/icons-static-svg/icons/vllm-color.svg?raw'
import xai from '@lobehub/icons-static-svg/icons/xai.svg?raw'
import xiaomi from '@lobehub/icons-static-svg/icons/xiaomimimo.svg?raw'
import zai from '@lobehub/icons-static-svg/icons/zai.svg?raw'
import { cn } from '@/lib/utils'

/** By pi's provider id (and the local presets'). Ids not listed fall back to their first segments. */
const ICONS: Record<string, string> = {
    'amazon-bedrock': bedrock,
    'ant-ling': antgroup,
    anthropic,
    azure,
    baseten,
    cerebras,
    cloudflare,
    deepseek,
    fireworks,
    'github-copilot': githubcopilot,
    google,
    'google-vertex': vertexai,
    groq,
    huggingface,
    kimi,
    lmstudio,
    meta,
    minimax,
    mistral,
    moonshotai: moonshot,
    nvidia,
    ollama,
    openai,
    opencode,
    openrouter,
    qwen,
    together,
    vercel,
    vllm,
    xai,
    xiaomi,
    zai,
}

/**
 * The icon for a provider: its id, then the id with trailing segments dropped (minimax-cn,
 * cloudflare-ai-gateway, xiaomi-token-plan-sgp), then its name as an id (a custom "Ollama" entry).
 */
export function providerIcon(id: string, name = ''): string | undefined {
    for (let key = id; key; key = key.includes('-') ? key.slice(0, key.lastIndexOf('-')) : '') {
        if (Object.hasOwn(ICONS, key))
            return ICONS[key]
    }
    const byName = name.toLowerCase().replace(/[^a-z0-9]/g, '')
    return byName && Object.hasOwn(ICONS, byName) ? ICONS[byName] : undefined
}

/** A provider's icon at `size` px, or its initial on a tile for providers without one. Decorative. */
export function ProviderIcon({ id, name, size = 16, className }: { id: string, name: string, size?: number, className?: string }) {
    const svg = providerIcon(id, name)
    if (svg) {
        // Bundled static SVGs (no user input); they size themselves to 1em.
        return <span aria-hidden className={cn('flex shrink-0 items-center justify-center leading-none text-gray-900', className)} style={{ fontSize: size, width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />
    }
    return (
        <span
            aria-hidden
            className={cn('flex shrink-0 items-center justify-center rounded-[4px] bg-[var(--jb-fill)] font-medium leading-none text-[var(--jb-comment)]', className)}
            style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}
        >
            {(name.trim()[0] ?? '?').toUpperCase()}
        </span>
    )
}
