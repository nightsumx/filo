import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const c = (code: number, s: string) => `\x1b[38;5;${code}m${s}\x1b[39m`;
const ARROW = 108, DIR = 110, MODEL = 141, MUTED = 244, WARN = 179, DANGER = 174;

const k = (n: number) => `${Math.round(n / 1000)}k`;
const ago = (s: number) =>
	s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((tui) => {
			const timer = setInterval(() => tui.requestRender(), 1000);
			timer.unref?.();
			return {
				invalidate() {},
				dispose() {
					clearInterval(timer);
				},
				render(width: number) {
					const now = Date.now();
					let cost = 0, add = 0, del = 0, recentOut = 0, lastReply = 0;
					for (const e of ctx.sessionManager.getEntries()) {
						if (e.type !== "message") continue;
						const m = e.message;
						if (m.role === "assistant") {
							cost += m.usage?.cost?.total || 0;
							lastReply = m.timestamp;
							if (now - m.timestamp < 60_000) recentOut += m.usage?.output || 0;
							for (const part of m.content)
								if (part.type === "toolCall" && part.name === "write" && typeof part.arguments.content === "string")
									add += part.arguments.content.split("\n").length - (part.arguments.content.endsWith("\n") ? 1 : 0);
						}
						if (m.role === "toolResult" && m.toolName === "edit" && typeof m.details?.diff === "string")
							for (const line of m.details.diff.split("\n")) {
								if (line[0] === "+") add++;
								if (line[0] === "-") del++;
							}
					}

					const parts = [c(ARROW, "➜"), c(DIR, ctx.cwd.split("/").filter(Boolean).pop() || ctx.cwd)];

					const usage = ctx.getContextUsage();
					if (usage?.tokens && usage.contextWindow) {
						const pct = Math.floor((usage.tokens / usage.contextWindow) * 100);
						const filled = Math.min(5, Math.floor((usage.tokens / usage.contextWindow) * 5 + 0.5));
						const color = pct >= 80 ? DANGER : pct >= 50 ? WARN : ARROW;
						parts.push(`${c(color, "█".repeat(filled))}${c(MUTED, "░".repeat(5 - filled))} ${c(color, `${pct}%`)} ${c(MUTED, `${k(usage.tokens)}/${k(usage.contextWindow)}`)}`);
					}

					if (recentOut)
						parts.push(`${c(ARROW, `⚡ ${recentOut >= 1000 ? `${(recentOut / 1000).toFixed(1)}k` : recentOut}tok`)} ${c(MUTED, `${Math.round(recentOut / 60)}/s`)}`);

					if (cost) parts.push(c(cost >= 5 ? DANGER : cost >= 1 ? WARN : MUTED, `$${cost.toFixed(2)}`));

					if (add || del) parts.push(`${c(ARROW, `+${add}`)} ${c(DANGER, `-${del}`)}`);

					if (ctx.model) {
						const name = ctx.model.name.split(" (")[0].replace("Claude ", "");
						const level = ctx.model.reasoning ? pi.getThinkingLevel() : "off";
						parts.push(["high", "xhigh", "max"].includes(level)
							? `${c(MODEL, name)} ${c(MUTED, "(")}${c(WARN, level)}${c(MUTED, ")")}`
							: c(MODEL, name));
					}

					if (lastReply) {
						const s = Math.max(0, Math.floor((now - lastReply) / 1000));
						parts.push(c(s >= 300 ? DANGER : s >= 240 ? WARN : ARROW, `${s >= 300 ? "✗" : "⏱"} ${ago(s)}`));
					}

					const left = `  ${parts.join(" ")}`;
					const compaction = pi.getSettings().compaction;
					if (!usage?.tokens || !usage.contextWindow || compaction?.enabled === false) return [truncateToWidth(left, width)];
					const untilCompact = Math.max(0, Math.floor(((usage.contextWindow - (compaction?.reserveTokens ?? 16384) - usage.tokens) / usage.contextWindow) * 100));
					const right = c(MUTED, `${untilCompact}% until auto-compact`);
					const gap = width - visibleWidth(left) - visibleWidth(right);
					return [gap >= 2 ? left + " ".repeat(gap) + right : truncateToWidth(left, width)];
				},
			};
		});
	});
}
