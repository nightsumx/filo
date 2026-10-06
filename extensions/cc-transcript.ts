import { AssistantMessageComponent, InteractiveMode, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";
import { COLOR, fg, key, REJECTED } from "./lib/shared.ts";

const INTERRUPTED = `${fg(COLOR.muted, "  ⎿  ")}${fg(COLOR.error, "Interrupted by user")}`;
const ABORT_TEXTS = new Set(["Operation aborted", "Request was aborted"]);

// "Operation aborted" under an interrupted reply -> "⎿  Interrupted by user".
const assistant = AssistantMessageComponent.prototype as any;
const updateContent = assistant.updateContent;
assistant.updateContent = function (message: any, ...rest: unknown[]) {
	updateContent.call(this, message, ...rest);
	if (message?.stopReason !== "aborted" || message.content?.some((c: any) => c.type === "toolCall")) return;
	if (message.errorMessage && !ABORT_TEXTS.has(message.errorMessage)) return; // e.g. "Aborted after 2 retry attempts"
	const children = this.contentContainer?.children;
	const last = children?.[children.length - 1];
	if (last instanceof Text) children[children.length - 1] = new Text(INTERRUPTED, 0, 0);
};

// Tool calls cut off by an interrupt show the same wording; rejected calls read like Claude Code's.
// Only the display changes: the model still receives the original result.
const tool = ToolExecutionComponent.prototype as any;
const updateResult = tool.updateResult;
tool.updateResult = function (result: any, ...rest: unknown[]) {
	const content = result?.content;
	const text = result?.isError && content?.length === 1 && content[0].type === "text" ? content[0].text : undefined;
	if (text && ABORT_TEXTS.has(text)) result = { ...result, content: [{ type: "text", text: "Interrupted by user" }] };
	else if (text === REJECTED) result = { ...result, content: [{ type: "text", text: "No (tell pi what to do differently)" }] };
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

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		// Collapsed thinking (ctrl+t) reads like Claude Code's.
		ctx.ui.setHiddenThinkingLabel(`✻ Thinking… (${key("app.thinking.toggle")} to expand)`);
	});
}
