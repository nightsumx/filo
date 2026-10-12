import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CACHE_WARM, cacheMisses, cacheStats, cacheTtlMs, channelFault, entryMessages, EXPECTED_MISSES, MISS_HINTS, MISS_LABELS, missesByReason, missLabel } from "pi-capabilities/lib/promptCache.ts";
import { readLedger, type Ledger, type SpendRow } from "pi-capabilities/lib/ledger.ts";
import path from "node:path";
import { COLOR, key, MODE_KEY, shared } from "./lib/shared.ts";

const c = (code: number, s: string) => `\x1b[38;5;${code}m${s}\x1b[39m`;
const ARROW = 108, DIR = 110, MODEL = 141, MUTED = 244, WARN = 179, DANGER = 174;

// Claude Code's second row: permission mode (or "? for shortcuts") on the left, auto-compact on the right.
const modeHint = (editorText: string) => {
	if (Date.now() < shared.exitHintUntil) return c(MUTED, `Press ${key("app.clear")} again to exit`);
	if (editorText.trimStart().startsWith("!")) return c(COLOR.bash, "! for bash mode");
	const cycle = c(MUTED, ` (${MODE_KEY} to cycle)`);
	switch (shared.mode) {
		case "bypassPermissions":
			return c(COLOR.error, "⏵⏵ bypass permissions on") + cycle;
		case "acceptEdits":
			return c(COLOR.autoAccept, "⏵⏵ accept edits on") + cycle;
		case "plan":
			return c(COLOR.plan, "⏸ plan mode on") + cycle;
		default:
			return c(MUTED, "? for shortcuts");
	}
};

const shortcuts = (width: number) => {
	const columns = [
		["! for bash mode", "/ for commands", "@ for file paths", `${key("app.message.followUp")} to queue a follow-up`],
		[`${key("app.clear")} to clear input`, `${key("app.thinking.cycle")} to cycle thinking`, `${MODE_KEY} to cycle permission modes`, `${key("app.thinking.toggle")} to toggle thinking`],
		[`${key("app.tools.expand")} to expand tool output`, `${key("app.model.select")} to switch model`, `${key("app.editor.external")} to edit in $EDITOR`, `${key("app.message.dequeue")} to edit queued messages`],
	];
	const widths = columns.map((col) => Math.max(...col.map((item) => visibleWidth(item))) + 4);
	if (widths.reduce((a, b) => a + b, 2) > width) return columns.flat().map((item) => truncateToWidth(`  ${c(MUTED, item)}`, width));
	return columns[0].map((_, row) => `  ${columns.map((col, i) => c(MUTED, col[row].padEnd(widths[i]))).join("")}`.trimEnd());
};

const k = (n: number) => `${Math.round(n / 1000)}k`;
const ago = (s: number) =>
	s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;

const count = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const money = (n: number) => (n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const textOf = (content: unknown) =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => (p?.type === "text" ? p.text : "")).join("") : "";

/** What /cache prints: the same figures as Filo's cache panel, newest significant misses first. */
export function cacheReport(entries: readonly { type: string; timestamp?: string; message?: any }[], ttlMs?: number, limit = 20): string {
	const messages = entryMessages(entries);
	const stats = cacheStats(messages, ttlMs);
	if (stats.rate === null) return "No request in this session reported prompt caching.";
	const misses = cacheMisses(messages, ttlMs);
	const lines = [`Prompt cache: ${Math.floor(stats.rate * 100)}% of ${count(stats.prompt)} input read from the cache (${count(stats.read)})`];
	// At best: every request reading all it can from the cache, nothing spent keeping it warm.
	const saving = stats.extraCost + stats.warming;
	if (stats.cost > 0)
		lines.push(`Spent ${money(stats.cost)}; ${money(stats.cost - saving)} at best${saving >= 0.01 ? c(WARN, `, ${money(saving)} (${Math.round((saving / stats.cost) * 100)}%) to save`) : ""}${stats.warming >= 0.01 ? c(MUTED, ` · cache warming ${money(stats.warming)}`) : ""}`);
	if (!stats.misses) return [...lines, "No request missed the cache."].join("\n");
	lines.push(`${stats.misses} ${stats.misses === 1 ? "miss" : "misses"}, ${count(stats.missedTokens)} re-billed${stats.extraCost > 0 ? `, +${money(stats.extraCost)}` : ""}`);
	const channel = channelFault(misses, stats.requests);
	if (channel)
		lines.push(c(WARN, `${channel.count} of ${stats.requests} requests lost the cache with nothing changed in the conversation${channel.extraCost ? `, +${money(channel.extraCost)}` : ""}. That is how this channel handles caching (often a relay); the same model through another channel or directly usually reads it. Cache warming saves nothing here.`));
	lines.push("");
	for (const g of missesByReason(misses))
		lines.push(`  ${`${MISS_LABELS[g.reason]} ×${g.count}`.padEnd(28)}${`${count(g.missed)}`.padStart(8)}${(g.extraCost ? `+${money(g.extraCost)}` : "").padStart(9)}  ${c(MUTED, MISS_HINTS[g.reason])}`);
	let prompt = "";
	const rows: string[] = [];
	messages.forEach((m: any, i) => {
		if (m.role === "user") prompt = textOf(m.content).replace(/\s+/g, " ").trim();
		const miss = misses[i];
		if (!miss?.significant) return;
		const at = new Date(m.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
		rows.push(`  ${at.padStart(8)}  ${missLabel(miss).padEnd(22)}${count(miss.missed).padStart(8)}${(miss.extraCost ? `+${money(miss.extraCost)}` : "").padStart(9)}  ${c(MUTED, `read ${count(miss.read)} of ${count(miss.expected)}${prompt ? ` · ${prompt.slice(0, 60)}` : ""}`)}`);
	});
	if (rows.length) {
		lines.push("", `Significant misses, newest first${rows.length > limit ? ` (${limit} of ${rows.length})` : ""}`);
		lines.push(...rows.reverse().slice(0, limit));
	}
	return lines.join("\n");
}

/** What /cost prints: the same figures as the panel behind Filo's status-line cost. */
export function costReport(ledger: Ledger, days: number): string {
	const lines = [`Last ${days === 1 ? "24 hours" : `${days} days`}: ${money(ledger.cost)} over ${ledger.sessions} ${ledger.sessions === 1 ? "session" : "sessions"} of pi, Claude Code and Codex (pi's list prices, subscriptions too; a relay may bill otherwise)`];
	if (ledger.waste >= 0.01)
		lines.push(c(ledger.channelWaste * 2 >= ledger.waste ? WARN : MUTED, `Cache misses re-billed ${money(ledger.waste)}, ${money(ledger.channelWaste)} of it with nothing changed in the conversation: the channel`));
	if (ledger.warming >= 0.01) lines.push(c(MUTED, `Cache warming ${money(ledger.warming)}`));
	const table = (title: string, rows: SpendRow[], label: (key: string) => string) => [
		"",
		title,
		...rows.slice(0, 7).map((r) => `  ${label(r.key).slice(0, 40).padEnd(40)}${money(r.cost).padStart(10)}${(r.waste >= 0.01 ? `missed ${money(r.waste)}` : "").padStart(18)}`),
	];
	if (days > 1) lines.push(...table("By day", ledger.byDay, (k) => k));
	if (ledger.byAgent.length > 1) lines.push(...table("By agent", ledger.byAgent, (k) => k));
	lines.push(...table("By project", ledger.byProject, (k) => path.basename(k) || k), ...table("By model", ledger.byModel, (k) => k));
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cost", {
		description: "What pi, Claude Code and Codex sessions cost over the last days (default 7), by day, agent, project and model",
		handler: async (args, ctx) => {
			const days = Math.min(Math.max(Number(args.trim()) || 7, 1), 90);
			const sessions = path.dirname(ctx.sessionManager.getSessionDir());
			const prices = Object.fromEntries(ctx.modelRegistry.getAll().map((m) => [`${m.provider}/${m.id}`, { cost: m.cost, promptCache: m.promptCache }]));
			ctx.ui.notify(costReport(await readLedger({ pi: sessions }, Date.now() - days * 86_400_000, prices), days), "info");
		},
	});

	pi.registerCommand("cache", {
		description: "List the requests that missed the prompt cache, and why",
		handler: async (_args, ctx) => ctx.ui.notify(cacheReport(ctx.sessionManager.getBranch(), cacheTtlMs(ctx.model)), "info"),
	});

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
					let cost = 0;
					for (const e of ctx.sessionManager.getEntries()) {
						if (e.type === "message" && e.message.role === "assistant") cost += e.message.usage?.cost?.total || 0;
						if (e.type === "usage" && e.kind === CACHE_WARM) cost += e.usage?.cost?.total || 0;
					}

					const parts = [c(DIR, ctx.cwd.split("/").filter(Boolean).pop() || ctx.cwd)];

					const usage = ctx.getContextUsage();
					if (usage?.tokens && usage.contextWindow) {
						const pct = Math.floor((usage.tokens / usage.contextWindow) * 100);
						const filled = Math.min(5, Math.floor((usage.tokens / usage.contextWindow) * 5 + 0.5));
						const color = pct >= 80 ? DANGER : pct >= 50 ? WARN : ARROW;
						parts.push(`${c(color, "█".repeat(filled))}${c(MUTED, "░".repeat(5 - filled))} ${c(MUTED, `${k(usage.tokens)}/${k(usage.contextWindow)}`)}`);
					}

					// The conversation's prompt-cache hit rate, on the current branch. A significant miss on the latest request
					// turns it amber (the user caused it, or a re-billed tail) or red (lost for no visible reason). /cache lists the misses.
					const ttlMs = cacheTtlMs(ctx.model);
					const cache = cacheStats(entryMessages(ctx.sessionManager.getBranch()), ttlMs);
					if (cache.rate !== null) {
						const miss = cache.lastMiss?.significant ? cache.lastMiss : null;
						const color = miss ? (EXPECTED_MISSES.has(miss.reason) || miss.reason === "partial" ? WARN : DANGER) : cache.rate >= 0.5 ? ARROW : MUTED;
						parts.push(c(color, `cache ${Math.floor(cache.rate * 100)}%`));
					}

					if (cost) parts.push(c(cost >= 5 ? DANGER : cost >= 1 ? WARN : MUTED, `$${cost.toFixed(2)}`));

					if (ctx.model) {
						const name = ctx.model.name.split(" (")[0].replace("Claude ", "");
						const level = ctx.model.reasoning ? pi.getThinkingLevel() : "off";
						parts.push(["high", "xhigh", "max"].includes(level)
							? `${c(MODEL, name)} ${c(MUTED, "(")}${c(WARN, level)}${c(MUTED, ")")}`
							: c(MODEL, name));
					}

					// Since the cache was last used, by a reply or pi warming it: amber in its last minute, red once it has likely expired.
					if (cache.usedAt) {
						const s = Math.max(0, Math.floor((now - cache.usedAt) / 1000));
						const ttl = ttlMs / 1000;
						parts.push(c(s >= ttl ? DANGER : s >= ttl - 60 ? WARN : ARROW, `${s >= ttl ? "✗" : "⏱"} ${ago(s)}`));
					}

					const status = truncateToWidth(`  ${parts.join(" ")}`, width);
					if (shared.showShortcuts) return [status, ...shortcuts(width)];

					const left = `  ${modeHint(ctx.ui.getEditorText())}`;
					const compaction = pi.getSettings().compaction;
					if (!usage?.tokens || !usage.contextWindow || compaction?.enabled === false) return [status, truncateToWidth(left, width)];
					const untilCompact = Math.max(0, Math.floor(((usage.contextWindow - (compaction?.reserveTokens ?? 16384) - usage.tokens) / usage.contextWindow) * 100));
					const right = c(MUTED, `${untilCompact}% until auto-compact`);
					const gap = width - visibleWidth(left) - visibleWidth(right);
					return [status, gap >= 2 ? left + " ".repeat(gap) + right : truncateToWidth(left, width)];
				},
			};
		});
	});
}
