import {
	AssistantMessageComponent,
	BashExecutionComponent,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	DynamicBorder,
	InteractiveMode,
	ToolExecutionComponent,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Loader, Spacer, Text, TruncatedText, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { COLOR, fg, key, shared } from "./lib/shared.ts";

const ABORT_TEXTS = new Set(["Operation aborted", "Request was aborted"]);

/** Claude Code's result block: "  ⎿  " before the first line, aligned indent after, wrapped to width. */
const hanging = (lines: string[], width: number) =>
	lines
		.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 5)))
		.map((line, i) => (i ? "     " : fg(COLOR.muted, "  ⎿  ")) + line);

const block = (lines: string[]) => ({ invalidate() {}, render: (width: number) => hanging(lines, width) });

let lastError = "";

// Interrupts and API errors under a reply -> "⎿  Interrupted by user" / "⎿  API Error: …".
const assistant = AssistantMessageComponent.prototype as any;
const updateContent = assistant.updateContent;
assistant.updateContent = function (message: any, ...rest: unknown[]) {
	updateContent.call(this, message, ...rest);
	if (message?.stopReason === "error") lastError = String(message.errorMessage ?? "");
	if (message.content?.some((c: any) => c.type === "toolCall")) return;
	let notice: string;
	if (message?.stopReason === "aborted") {
		if (message.errorMessage && !ABORT_TEXTS.has(message.errorMessage)) return; // e.g. "Aborted after 2 retry attempts"
		notice = "Interrupted by user";
	} else if (message?.stopReason === "error") {
		const error = message.errorMessage || "Unknown error";
		notice = /^\d{3}\b/.test(error) ? `API Error: ${error}` : `Error: ${error}`;
	} else return;
	const children = this.contentContainer?.children;
	const last = children?.[children.length - 1];
	if (!(last instanceof Text)) return;
	children[children.length - 1] = block([fg(COLOR.error, notice)]);
	// pi puts a blank line before the notice; Claude Code hangs "⎿" right under the message.
	if (children[children.length - 2] instanceof Spacer) children.splice(children.length - 2, 1);
};

// "Retrying (1/10) in 3s..." -> Claude Code's "⎿  API Error (Overloaded) · Retrying in 3 seconds… (attempt 1/10)".
const reason = (error: string) => {
	if (/overload|\b529\b/i.test(error)) return "Overloaded";
	if (/rate.?limit|\b429\b/i.test(error)) return "Rate limited";
	if (/timed? ?out|timeout/i.test(error)) return "Request timed out";
	if (/ECONN|socket|network|fetch failed|connection/i.test(error)) return "Connection error";
	return truncateToWidth(error.split("\n")[0] || "Unknown error", 40, "…");
};
const loader = Loader.prototype as any;
const loaderRender = loader.render;
loader.render = function (width: number) {
	const match = this.kind === "retry" && /\((\d+)\/(\d+)\) in (\d+)s/.exec(String(this.message ?? ""));
	if (!match) return loaderRender.call(this, width);
	const [, attempt, max, seconds] = match;
	const spinner = this.getRenderedIndicator?.() ?? fg(COLOR.claude, "✻");
	return [
		"",
		truncateToWidth(`${spinner} ${fg(COLOR.shimmer, "Retrying…")} ${fg(COLOR.muted, `(${key("app.interrupt")} to cancel)`)}`, width, ""),
		...hanging(
			[`${fg(COLOR.error, `API Error (${reason(lastError)})`)}${fg(COLOR.muted, ` · Retrying in ${seconds} second${seconds === "1" ? "" : "s"}… (attempt ${attempt}/${max})`)}`],
			width,
		),
	];
};

// "!" commands: "! cmd" on the user-message background with the output hanging under "⎿",
// instead of a bordered "$ cmd" box. pi's 20-line tail preview and truncation notes stay.
const PREVIEW_LINES = 20;
const bash = BashExecutionComponent.prototype as any;
const bashLines = (self: any, width: number) => {
	const theme = shared.ui?.theme;
	const bg = (s: string) => theme?.bg?.("userMessageBg", s) ?? `\x1b[48;5;237m${s}\x1b[49m`;
	const marker = self.ccExcluded ? fg(COLOR.muted, "!!") : fg(COLOR.bash, "!");
	const header = wrapTextWithAnsi(self.command, Math.max(1, width - 3)).map((line, i) => {
		const text = `${i ? "   ".slice(self.ccExcluded ? 0 : 1) : `${marker} `}${line}`;
		return bg(text + " ".repeat(Math.max(0, width - visibleWidth(text))));
	});

	const output = truncateTail(self.outputLines.join("\n"), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	const logical = output.content ? output.content.replace(/\n+$/, "").split("\n") : [];
	let rows = logical.flatMap((line: string) => wrapTextWithAnsi(line, Math.max(1, width - 5)));
	const notes: string[] = [];
	if (!self.expanded && rows.length > PREVIEW_LINES) {
		notes.push(fg(COLOR.muted, `… +${rows.length - PREVIEW_LINES} lines (${key("app.tools.expand")} to expand)`));
		rows = rows.slice(-PREVIEW_LINES);
	}
	if (self.status === "running") rows.push(fg(COLOR.muted, `Running… (${key("tui.select.cancel")} to cancel)`));
	else {
		if (!logical.length && self.status === "complete") rows.push(fg(COLOR.muted, "(No content)"));
		if (self.status === "cancelled") rows.push(fg(COLOR.error, "Interrupted by user"));
		if (self.status === "error") rows.push(fg(COLOR.error, `Exit code ${self.exitCode}`));
		if ((self.truncationResult?.truncated || output.truncated) && self.fullOutputPath)
			rows.push(theme?.fg?.("warning", `Output truncated. Full output: ${self.fullOutputPath}`) ?? `Output truncated. Full output: ${self.fullOutputPath}`);
	}
	return ["", ...header, ...hanging([...notes, ...rows], width).map((line) => truncateToWidth(line, width, ""))];
};
bash.updateDisplay = function () {
	// Commands run with "!!" (kept out of context) get pi's dim border; remember that before dropping the borders.
	this.ccExcluded ??= this.children?.some((c: any) => c instanceof DynamicBorder && c.color("x") === shared.ui?.theme?.fg?.("dim", "x"));
};
bash.render = function (width: number) {
	bash.updateDisplay.call(this);
	return bashLines(this, width);
};

// Tool calls cut off by an interrupt show the same wording; rejected calls read like Claude Code's.
// Only the display changes: the model still receives the original result.
const tool = ToolExecutionComponent.prototype as any;
const updateResult = tool.updateResult;
tool.updateResult = function (result: any, ...rest: unknown[]) {
	const content = result?.content;
	const text = result?.isError && content?.length === 1 && content[0].type === "text" ? content[0].text : undefined;
	if (text && ABORT_TEXTS.has(text)) result = { ...result, content: [{ type: "text", text: "Interrupted by user" }] };
	else if (text && /^The user declined this \S+ call\./.test(text)) result = { ...result, content: [{ type: "text", text: "No (tell pi what to do differently)" }] };
	return updateResult.call(this, result, ...rest);
};

// Queued messages: "❯ text" in gray instead of "Steering: text" / "Follow-up: text".
const mode = InteractiveMode.prototype as any;
const updatePending = mode.updatePendingMessagesDisplay;
mode.updatePendingMessagesDisplay = function () {
	if (typeof this.getAllQueuedMessages !== "function" || !this.pendingMessagesContainer) return updatePending.call(this);
	const { steering, followUp } = this.getAllQueuedMessages();
	const queued = [...steering, ...followUp];
	this.pendingMessagesContainer.clear();
	if (!queued.length) return;
	this.pendingMessagesContainer.addChild(new Spacer(1));
	for (const message of queued) {
		const first = String(message).split("\n")[0];
		const more = String(message).includes("\n") ? " …" : "";
		this.pendingMessagesContainer.addChild(new TruncatedText(fg(COLOR.muted, `❯ ${first}${more}`), 0, 0));
	}
	this.pendingMessagesContainer.addChild(new TruncatedText(fg(COLOR.muted, `  ${key("app.message.dequeue")} to edit queued messages`), 0, 0));
};

// ctrl+c: Claude Code's "Press ctrl+c again to exit" in the second status row, with its 800ms double-press window.
const DOUBLE_PRESS_MS = 800;
const handleCtrlC = mode.handleCtrlC;
mode.handleCtrlC = function () {
	if (typeof this.clearEditor !== "function" || typeof this.shutdown !== "function") return handleCtrlC.call(this);
	const now = Date.now();
	if (now - (this.lastSigintTime ?? 0) < DOUBLE_PRESS_MS) return void this.shutdown();
	this.clearEditor();
	this.lastSigintTime = now;
	shared.exitHintUntil = now + DOUBLE_PRESS_MS;
	this.ui?.requestRender();
	setTimeout(() => this.ui?.requestRender(), DOUBLE_PRESS_MS + 10).unref?.();
};

// The capability tools draw their own Claude Code rows (Update Todos, Task, Plan, questions). Renderers
// that merge neighbouring tool calls into one row (pi-cc-extensions' "Multiple Tools") would hide
// them, so each gets an empty component on both sides, which ends any group.
const OWN_ROWS = new Set(["todo", "ask", "propose_plan", "subagent"]);
const BOUNDARY = Symbol.for("pi-cc-tui.tool-boundary");
const boundary = () => ({ [BOUNDARY]: true, invalidate() {}, render: () => [] });
const container = Container.prototype as any;
const addChild = container.addChild;
container.addChild = function (component: any) {
	if (!(component instanceof ToolExecutionComponent) || !OWN_ROWS.has((component as any).toolName)) return addChild.call(this, component);
	if (!this.children?.at(-1)?.[BOUNDARY]) addChild.call(this, boundary());
	const result = addChild.call(this, component);
	addChild.call(this, boundary());
	return result;
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		// Collapsed thinking (ctrl+t) reads like Claude Code's.
		ctx.ui.setHiddenThinkingLabel(`✻ Thinking… (${key("app.thinking.toggle")} to expand)`);
	});
}
