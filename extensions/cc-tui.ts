import { AssistantMessageComponent, UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, Loader, Markdown, Text } from "@earendil-works/pi-tui";

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
		hang(child, `\x1b[48;5;237m${fg(239, "❯ ")}`, "\x1b[48;5;237m  ");
	}
};

const assistant = AssistantMessageComponent.prototype;
const assistantRender = assistant.render;
assistant.render = function (width: number) {
	for (const child of this.contentContainer.children) {
		if (!(child instanceof Markdown) || child.defaultTextStyle || child.ccHang) continue;
		child.ccHang = true;
		hang(child, `${fg(231, "⏺")} `, "  ");
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

export default function (pi: ExtensionAPI) {
	let start = 0;
	let done = 0;
	let streaming = 0;
	let verb = VERBS[0];
	let timer: ReturnType<typeof setInterval> | undefined;
	let ui: { setWorkingMessage(message?: string): void } | undefined;

	const show = () => {
		const tokens = Math.round((done + streaming) / 4);
		const count = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
		ui?.setWorkingMessage(`${fg(216, `${verb[0]}…`)} ${fg(246, `(${duration(Date.now() - start)}${tokens ? ` · ↓ ${count} tokens` : ""})`)}`);
	};

	pi.registerEntryRenderer("cc-done", (entry: any) =>
		new Text(`${fg(246, "✻")} ${fg(246, `${entry.data.verb} for ${duration(entry.data.ms)} · done ${new Date(entry.data.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`)}`, 0, 0),
	);

	pi.on("session_start", (_e, ctx) => {
		if (ctx.hasUI) ctx.ui.setWorkingIndicator({ frames: [...FRAMES, ...FRAMES.slice(1, -1).reverse()].map((f) => fg(174, f)), intervalMs: 120 });
	});

	pi.on("agent_start", (_e, ctx) => {
		if (!ctx.hasUI) return;
		ui = ctx.ui;
		start = Date.now();
		done = 0;
		streaming = 0;
		verb = VERBS[Math.floor(Math.random() * VERBS.length)];
		show();
		clearInterval(timer);
		timer = setInterval(show, 1000);
		timer.unref?.();
	});

	pi.on("message_update", (e) => {
		if (e.message.role === "assistant") streaming = size(e.message);
	});

	pi.on("message_end", (e) => {
		if (e.message.role !== "assistant") return;
		done += size(e.message);
		streaming = 0;
	});

	pi.on("agent_end", () => {
		if (!ui) return;
		clearInterval(timer);
		ui.setWorkingMessage();
		ui = undefined;
		pi.appendEntry("cc-done", { verb: verb[1], ms: Date.now() - start, at: Date.now() });
	});
}
