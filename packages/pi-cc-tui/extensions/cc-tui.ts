import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessageComponent, CONFIG_DIR_NAME, getAgentDir, UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, Loader, Markdown, Text } from "@earendil-works/pi-tui";
import { latestTodos } from "pi-capabilities/lib/todo.ts";
import type { TodoDetails } from "pi-capabilities/protocol";
import { COLOR, key, MODE_KEY, shared } from "./lib/shared.ts";

const fg = (code: number, s: string) => `\x1b[38;5;${code}m${s}\x1b[39m`;
const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];
const VERBS = [
	["Working", "Worked"],
	["Churning", "Churned"],
	["Sautéing", "Sautéed"],
	["Brewing", "Brewed"],
	["Cooking", "Cooked"],
	["Baking", "Baked"],
	["Crunching", "Crunched"],
	["Cogitating", "Cogitated"],
];

// Shown under the working line, like Claude Code's "⎿  Tip: …", when there is no todo list to show.
const TIPS = [
	() => `Press ${key("app.tools.expand")} to expand tool output`,
	() => `Press ${key("app.thinking.toggle")} to show or hide thinking`,
	() => `Press ${key("app.message.followUp")} to queue a follow-up message`,
	() => `Press ${key("app.message.dequeue")} to edit queued messages`,
	() => `Press ${key("app.editor.external")} to write your prompt in $EDITOR`,
	() => "Start a message with ! to run a shell command",
	() => "Use /compact to summarize the conversation and free up context",
	() => "Use /tree to go back to an earlier point in the session",
	() => `Press ${MODE_KEY} to cycle permission modes`,
	() => "Press ? on an empty prompt to see all shortcuts",
];

const markdown = Markdown.prototype;
const renderToken = markdown.renderToken;
markdown.renderToken = function (token: any, width: number, nextTokenType?: string, styleContext?: unknown) {
	if (token.type === "code") {
		const lines = this.theme.highlightCode?.(token.text, token.lang) ?? token.text.split("\n").map(this.theme.codeBlock);
		return nextTokenType && nextTokenType !== "space" ? [...lines, ""] : lines;
	}
	const lines = renderToken.call(this, token, width, nextTokenType, styleContext);
	if (token.type !== "blockquote") return lines;
	const border = this.theme.quoteBorder("│ ");
	return lines.map((line: string) => (line.startsWith(border) ? `\x1b[2m▎\x1b[22m ${line.slice(border.length)}` : line));
};

const hang = (md: any, first: string, rest: string) => {
	md.paddingX = 0;
	const render = md.render;
	md.render = (width: number) => render.call(md, width - 2).map((line: string, i: number) => (i ? rest : first) + line);
};

const userMessage = UserMessageComponent.prototype;
const rebuild = userMessage.rebuild;
userMessage.rebuild = function () {
	rebuild.call(this);
	for (const child of this.children) {
		child.paddingY = 0;
		// Same background as the message itself, so the prompt follows the active theme.
		const bg = child.defaultTextStyle?.bgColor ?? ((s: string) => `\x1b[48;5;237m${s}`);
		hang(child, bg(fg(239, "❯ ")), bg("  "));
	}
};

const assistant = AssistantMessageComponent.prototype;
const assistantRender = assistant.render;
assistant.render = function (width: number) {
	for (const child of this.contentContainer.children) {
		if (!(child instanceof Markdown) || child.defaultTextStyle || child.ccHang) continue;
		child.ccHang = true;
		hang(child, `${shared.ui?.theme?.appearance === "light" ? "⏺" : fg(231, "⏺")} `, "  ");
	}
	return assistantRender.call(this, width);
};

const loader = Loader.prototype;
const loaderRender = loader.render;
loader.render = function (width: number) {
	if (this.kind === "working") this.paddingX = 0;
	return loaderRender.call(this, width);
};

const editor = Editor.prototype;
const render = editor.render;
editor.render = function (width: number) {
	this.embedWorkingStatus = false;
	const lines = render.call(this, width - 2);
	const bottom = this.renderedVisibleLineCount + 1;
	return lines.map((line: string, i: number) =>
		i === 0 || i === bottom ? line + this.borderColor("──") : (i === 1 ? "❯ " : "  ") + line,
	);
};
const handleMouse = editor.handleMouse;
editor.handleMouse = function (event: { x: number; width: number }) {
	return handleMouse.call(this, { ...event, x: event.x - 2, width: event.width - 2 });
};

const duration = (ms: number) => {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

const size = (message: any) =>
	(message?.content ?? []).reduce(
		(n: number, c: any) =>
			n + (c.type === "text" ? c.text.length : c.type === "thinking" ? c.thinking.length : c.type === "toolCall" ? JSON.stringify(c.arguments ?? {}).length : 0),
		0,
	);

// True if the user picked a theme in global or project settings.json.
const hasThemeSetting = (cwd: string) =>
	[join(getAgentDir(), "settings.json"), join(cwd, CONFIG_DIR_NAME, "settings.json")].some((path) => {
		try {
			return typeof JSON.parse(readFileSync(path, "utf8")).theme === "string";
		} catch {
			return false;
		}
	});

export default function (pi: ExtensionAPI) {
	let start = 0;
	let done = 0;
	let streaming = 0;
	let thinking = false;
	let tip = TIPS[0];
	let verb = VERBS[0];
	let timer: ReturnType<typeof setInterval> | undefined;
	let ui: { setWorkingMessage(message?: string): void } | undefined;

	const show = () => {
		const tokens = Math.round((done + streaming) / 4);
		const count = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
		const meta = [duration(Date.now() - start), tokens ? `↓ ${count} tokens` : "", thinking ? "thinking" : "", `${key("app.interrupt")} to interrupt`];
		// The current todo's activeForm replaces the random verb, like Claude Code.
		const todos = shared.todos.some((t) => t.status !== "done") ? shared.todos : [];
		const label = todos.find((t) => t.status === "in_progress")?.activeForm ?? verb[0];
		const below = todos.length
			? todos.map((t, i) => {
					const lead = fg(COLOR.muted, i ? "     " : "  ⎿  ");
					if (t.status === "done") return lead + fg(COLOR.muted, `☒ \x1b[9m${t.text}\x1b[29m`);
					return lead + (t.status === "in_progress" ? `\x1b[1m☐ ${t.text}\x1b[22m` : `☐ ${t.text}`);
				})
			: [fg(COLOR.muted, `  ⎿  Tip: ${tip()}`)];
		ui?.setWorkingMessage([`${fg(COLOR.shimmer, `${label}…`)} ${fg(COLOR.muted, `(${meta.filter(Boolean).join(" · ")})`)}`, ...below].join("\n"));
	};

	pi.registerEntryRenderer("cc-done", (entry: any) =>
		new Text(`${fg(COLOR.muted, "✻")} ${fg(COLOR.muted, `${entry.data.verb} for ${duration(entry.data.ms)} · done ${new Date(entry.data.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`)}`, 0, 0),
	);

	pi.on("session_start", (_e, ctx) => {
		if (!ctx.hasUI) return;
		shared.ui = ctx.ui;
		// Default to the dark claude-code theme unless the user already chose one.
		if (!hasThemeSetting(ctx.cwd)) ctx.ui.setTheme("claude-code");
		ctx.ui.setWorkingIndicator({ frames: [...FRAMES, ...FRAMES.slice(1, -1).reverse()].map((f) => fg(174, f)), intervalMs: 120 });
	});

	// The todo capability's list: the latest result on the branch, then every new call.
	const restoreTodos = (ctx: any) => {
		shared.todos = latestTodos(ctx.sessionManager.getBranch());
	};
	pi.on("session_start", (_e, ctx) => restoreTodos(ctx));
	pi.on("session_tree", (_e, ctx) => restoreTodos(ctx));
	pi.registerCommand("todos", {
		description: "Show the current todo list",
		handler: async (_args, ctx) => {
			const todos = shared.todos;
			if (!todos.length) return ctx.ui.notify("No todos yet", "info");
			const done = todos.filter((t) => t.status === "done").length;
			ctx.ui.notify(`${done}/${todos.length} done\n${todos.map((t) => `${t.status === "done" ? "☒" : "☐"} ${t.text}`).join("\n")}`, "info");
		},
	});
	pi.on("tool_execution_end", (e) => {
		const items = e.toolName === "todo" && !e.isError ? (e.result?.details as TodoDetails | undefined)?.items : undefined;
		if (Array.isArray(items)) {
			shared.todos = items;
			show();
		}
	});

	pi.on("agent_start", (_e, ctx) => {
		if (!ctx.hasUI) return;
		ui = ctx.ui;
		start = Date.now();
		done = 0;
		streaming = 0;
		thinking = false;
		verb = VERBS[Math.floor(Math.random() * VERBS.length)];
		tip = TIPS[Math.floor(Math.random() * TIPS.length)];
		show();
		clearInterval(timer);
		timer = setInterval(show, 1000);
		timer.unref?.();
	});

	pi.on("message_update", (e) => {
		if (e.message.role !== "assistant") return;
		streaming = size(e.message);
		thinking = e.message.content?.at(-1)?.type === "thinking";
	});

	pi.on("message_end", (e) => {
		if (e.message.role !== "assistant") return;
		done += size(e.message);
		streaming = 0;
		thinking = false;
	});

	pi.on("agent_end", (e) => {
		if (!ui) return;
		clearInterval(timer);
		ui.setWorkingMessage();
		ui = undefined;
		// Claude Code prints "Interrupted by user" instead of a summary line after esc.
		const last = [...(e.messages ?? [])].reverse().find((m: any) => m.role === "assistant") as any;
		if (last?.stopReason === "aborted") return;
		pi.appendEntry("cc-done", { verb: verb[1], ms: Date.now() - start, at: Date.now() });
	});
}
