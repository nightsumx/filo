import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
					let cost = 0, lastReply = 0;
					for (const e of ctx.sessionManager.getEntries()) {
						if (e.type !== "message" || e.message.role !== "assistant") continue;
						cost += e.message.usage?.cost?.total || 0;
						lastReply = e.message.timestamp;
					}

					const parts = [c(DIR, ctx.cwd.split("/").filter(Boolean).pop() || ctx.cwd)];

					const usage = ctx.getContextUsage();
					if (usage?.tokens && usage.contextWindow) {
						const pct = Math.floor((usage.tokens / usage.contextWindow) * 100);
						const filled = Math.min(5, Math.floor((usage.tokens / usage.contextWindow) * 5 + 0.5));
						const color = pct >= 80 ? DANGER : pct >= 50 ? WARN : ARROW;
						parts.push(`${c(color, "█".repeat(filled))}${c(MUTED, "░".repeat(5 - filled))} ${c(MUTED, `${k(usage.tokens)}/${k(usage.contextWindow)}`)}`);
					}

					if (cost) parts.push(c(cost >= 5 ? DANGER : cost >= 1 ? WARN : MUTED, `$${cost.toFixed(2)}`));

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
