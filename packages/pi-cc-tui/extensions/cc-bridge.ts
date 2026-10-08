import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BRIDGE_SOCKET_SUFFIX,
	DIALOG_EVENTS,
	ENV,
	GUI_EVENTS,
	GUI_STATUS,
	PRESENCE_DIR,
	type DialogAnswer,
	type DialogRequest,
} from "pi-capabilities/protocol";

// Lets the Filo desktop app join this terminal pi instead of starting a second one on the same session
// file (two processes appending to one file fork the conversation). It listens on a unix socket next
// to cc-presence's file and speaks pi's RPC protocol there, as `pi --mode rpc` does on stdio: the app
// sees the run live, token by token, and its prompts, stops, model and mode changes go to this
// process. A client that joins mid-run first gets the run so far. Only the user's own processes can
// connect (mode 0600 in their agent dir), the same ones that could start pi themselves.
//
// Built on the extension API, so some RPC commands have no equivalent here (fork, queue editing);
// they answer with an error and the app keeps those for its own pi.

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Unix socket paths are limited (104 bytes on macOS); a longer agent dir goes without a bridge. */
const MAX_SOCKET_PATH = 100;

type Json = Record<string, any>;

interface ToolRun {
	toolName: string;
	args: unknown;
	partial?: unknown;
}

/** pi's RPC shape of message_update (json-event.ts): deltas only, no partial message. */
function jsonUpdate(message: any, event: any): Json {
	let update = event;
	if (event?.type === "toolcall_start") {
		const call = event.partial?.content?.[event.contentIndex];
		const { partial: _partial, ...rest } = event;
		update = { ...rest, id: call?.id, toolName: call?.name };
	} else if (event && typeof event === "object" && "partial" in event) {
		const { partial: _partial, ...rest } = event;
		update = rest;
	}
	return { type: "message_update", usage: message?.usage, assistantMessageEvent: update };
}

/** The streamed blocks of a partial assistant message, as the updates that would have built it. */
export function replayMessage(message: any): Json[] {
	const out: Json[] = [{ type: "message_start", message: { ...message, content: [] } }];
	const content: any[] = Array.isArray(message?.content) ? message.content : [];
	content.forEach((block, contentIndex) => {
		const update = (event: Json) => out.push({ type: "message_update", usage: message.usage, assistantMessageEvent: { contentIndex, ...event } });
		if (block?.type === "text") {
			update({ type: "text_start" });
			update({ type: "text_delta", delta: block.text ?? "" });
		} else if (block?.type === "thinking") {
			update({ type: "thinking_start" });
			update({ type: "thinking_delta", delta: block.thinking ?? "" });
		} else if (block?.type === "toolCall") {
			update({ type: "toolcall_start", id: block.id, toolName: block.name });
			update({ type: "toolcall_delta", delta: JSON.stringify(block.arguments ?? {}) });
		}
	});
	return out;
}

/** pi-ai's getSupportedThinkingLevels (not importable from here: pi-cc-tui does not depend on pi-ai). */
function thinkingLevels(model: any): string[] {
	if (!model) return THINKING_LEVELS;
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		return level === "xhigh" || level === "max" ? mapped !== undefined : true;
	});
}

/** pi's get_session_stats, from the session file this process writes. */
function sessionStats(ctx: ExtensionContext): Json {
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	let cost = 0;
	const add = (usage: any) => {
		if (!usage) return;
		tokens.input += usage.input ?? 0;
		tokens.output += usage.output ?? 0;
		tokens.cacheRead += usage.cacheRead ?? 0;
		tokens.cacheWrite += usage.cacheWrite ?? 0;
		cost += usage.cost?.total ?? 0;
	};
	for (const entry of ctx.sessionManager.getEntries() as any[]) {
		if (entry.type === "usage" || ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage)) add(entry.usage);
		else if (entry.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")) add(entry.message.usage);
	}
	tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
	return { sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId(), tokens, cost, contextUsage: ctx.getContextUsage() };
}

export default function (pi: ExtensionAPI) {
	// The desktop app's own pi processes already talk to it over RPC; subagents belong to their parent.
	if (process.env[ENV.host] === "gui" || process.env[ENV.subagent]) return;

	let ctx: ExtensionContext | null = null;
	let server: Server | null = null;
	let socketPath: string | null = null;
	const clients = new Set<Socket>();

	// What a client joining mid-run needs to catch up.
	let running = false;
	let streaming: any = null;
	const tools = new Map<string, ToolRun>();
	const statuses = new Map<string, string>();
	const dialogs = new Map<string, DialogRequest>();

	const line = (record: Json) => `${JSON.stringify(record)}\n`;
	const broadcast = (record: Json) => {
		if (!clients.size) return;
		const text = line(record);
		for (const client of clients) client.write(text);
	};
	const statusEvent = (key: string, text: string | undefined): Json => ({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: key, statusText: text });
	const setStatus = (key: string, text: string | undefined) => {
		if (text) statuses.set(key, text);
		else statuses.delete(key);
		broadcast(statusEvent(key, text));
	};

	const catchUp = (): Json[] => {
		const out: Json[] = [...[...statuses].map(([key, text]) => statusEvent(key, text))];
		if (running) {
			out.push({ type: "agent_start" });
			for (const [toolCallId, run] of tools) {
				out.push({ type: "tool_execution_start", toolCallId, toolName: run.toolName, args: run.args });
				if (run.partial !== undefined) out.push({ type: "tool_execution_update", toolCallId, toolName: run.toolName, args: run.args, partialResult: run.partial });
			}
			if (streaming) out.push(...replayMessage(streaming));
		}
		for (const dialog of dialogs.values()) out.push({ type: "extension_ui_request", ...dialog });
		return out;
	};

	// ------------------------------------------------------------ events out

	// Every handler gets the current context; the one from session_start goes stale on a reload.
	pi.on("agent_start", (_e, c) => {
		ctx = c;
		running = true;
		broadcast({ type: "agent_start" });
	});
	pi.on("message_start", (e, c) => {
		ctx = c;
		if (e.message.role === "assistant") streaming = e.message;
		broadcast({ type: "message_start", message: e.message });
	});
	pi.on("message_update", (e) => {
		streaming = e.message;
		if (clients.size) broadcast(jsonUpdate(e.message, e.assistantMessageEvent));
	});
	pi.on("message_end", (e) => {
		if (e.message.role === "assistant") streaming = null;
		broadcast({ type: "message_end", message: e.message });
	});
	pi.on("tool_execution_start", (e) => {
		tools.set(e.toolCallId, { toolName: e.toolName, args: e.args });
		broadcast({ type: "tool_execution_start", toolCallId: e.toolCallId, toolName: e.toolName, args: e.args });
	});
	pi.on("tool_execution_update", (e) => {
		const run = tools.get(e.toolCallId);
		if (run) run.partial = e.partialResult;
		broadcast({ type: "tool_execution_update", toolCallId: e.toolCallId, toolName: e.toolName, args: e.args, partialResult: e.partialResult });
	});
	pi.on("tool_execution_end", (e) => {
		tools.delete(e.toolCallId);
		broadcast({ type: "tool_execution_end", toolCallId: e.toolCallId, toolName: e.toolName, result: e.result, isError: e.isError });
	});
	pi.on("agent_end", () => broadcast({ type: "agent_end" }));
	pi.on("agent_settled", () => {
		running = false;
		streaming = null;
		tools.clear();
		broadcast({ type: "agent_settled" });
	});
	pi.on("session_before_compact", (e) => {
		broadcast({ type: "compaction_start", reason: e.reason });
	});
	pi.on("session_compact", (e) => broadcast({ type: "compaction_end", reason: e.reason }));
	pi.on("session_compact_failed", (e) => broadcast({ type: "compaction_end", reason: e.reason, aborted: e.aborted, errorMessage: e.aborted ? undefined : e.errorMessage }));
	pi.on("session_info_changed", (e) => broadcast({ type: "session_info_changed", name: e.name }));
	pi.on("thinking_level_select", (e) => broadcast({ type: "thinking_level_changed", level: e.level }));
	// Not pi's: the app re-reads get_state (the model shows in its picker).
	pi.on("model_select", () => broadcast({ type: "state_changed" }));

	// Mode state: the capabilities publish it as events next to their (terminal-only) statuses.
	pi.events.on(GUI_EVENTS.approvalMode, (mode) => setStatus(GUI_STATUS.approval, typeof mode === "string" ? mode : undefined));
	pi.events.on(GUI_EVENTS.planMode, (on) => setStatus(GUI_STATUS.plan, on === true ? "on" : undefined));

	// Terminal dialogs the app may answer too (approval prompts).
	pi.events.on(DIALOG_EVENTS.open, (data) => {
		const dialog = data as DialogRequest;
		if (!dialog?.id) return;
		dialogs.set(dialog.id, dialog);
		broadcast({ type: "extension_ui_request", ...dialog });
	});
	pi.events.on(DIALOG_EVENTS.close, (data) => {
		const id = (data as { id?: string })?.id;
		// Not pi's: the app drops the prompt it shows for this dialog.
		if (id && dialogs.delete(id)) broadcast({ type: "extension_ui_cancel", id });
	});

	// ------------------------------------------------------------ commands in

	const ok = (id: unknown, command: string, data?: unknown): Json => (data === undefined ? { id, type: "response", command, success: true } : { id, type: "response", command, success: true, data });
	const fail = (id: unknown, command: string, error: string): Json => ({ id, type: "response", command, success: false, error });

	const state = (c: ExtensionContext): Json => ({
		model: c.model,
		thinkingLevel: pi.getThinkingLevel(),
		isStreaming: !c.isIdle(),
		isCompacting: false,
		sessionFile: c.sessionManager.getSessionFile(),
		sessionId: c.sessionManager.getSessionId(),
		sessionName: pi.getSessionName(),
		messageCount: c.sessionManager.getEntries().filter((e: any) => e.type === "message").length,
		pendingMessageCount: c.hasPendingMessages() ? 1 : 0,
		terminalPid: process.pid,
	});

	const prompt = (c: ExtensionContext, command: Json): Json => {
		const text = String(command.message ?? "");
		const images = Array.isArray(command.images) ? command.images : [];
		const busy = !c.isIdle();
		const name = text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0] : "";
		const isCommand = !!name && pi.getCommands().some((cmd) => cmd.source === "extension" && cmd.name === name);
		const deliverAs = command.type === "steer" ? "steer" : command.type === "follow_up" ? "followUp" : busy ? (command.streamingBehavior === "steer" ? "steer" : "followUp") : undefined;
		// expandPromptTemplates runs extension commands, templates and skills, as typed in the terminal.
		pi.sendUserMessage(images.length ? [{ type: "text", text }, ...images] : text, { deliverAs, expandPromptTemplates: true });
		return { disposition: isCommand ? "handled" : busy ? "queued" : "started" };
	};

	const handle = async (command: Json): Promise<Json | undefined> => {
		const { id, type } = command;
		const c = ctx;
		if (!c) return fail(id, type, "pi is not ready");
		switch (type) {
			case "get_state":
				return ok(id, type, state(c));
			case "get_available_models":
				return ok(id, type, { models: c.modelRegistry.getAvailable() });
			case "get_available_thinking_levels":
				return ok(id, type, { levels: thinkingLevels(c.model) });
			case "get_commands":
				return ok(id, type, { commands: pi.getCommands().map((cmd) => ({ name: cmd.name, description: cmd.description, source: cmd.source })) });
			case "get_session_stats":
				return ok(id, type, sessionStats(c));
			case "prompt":
			case "steer":
			case "follow_up":
				return ok(id, type, prompt(c, command));
			case "abort":
				c.abort();
				return ok(id, type);
			case "clear_queue":
				// The extension API cannot take queued messages back; they stay queued in the terminal.
				return ok(id, type, { steering: [], followUp: [] });
			case "set_model": {
				const model = c.modelRegistry.find(command.provider, command.modelId);
				if (!model) return fail(id, type, `Model not found: ${command.provider}/${command.modelId}`);
				if (!(await pi.setModel(model))) return fail(id, type, `No API key for ${command.provider}/${command.modelId}`);
				return ok(id, type, model);
			}
			case "set_thinking_level":
				pi.setThinkingLevel(command.level);
				return ok(id, type);
			case "set_session_name": {
				const name = String(command.name ?? "").trim();
				if (!name) return fail(id, type, "Session name cannot be empty");
				pi.setSessionName(name);
				return ok(id, type);
			}
			case "compact":
				return new Promise((resolve) => {
					c.compact({
						customInstructions: command.customInstructions,
						onComplete: (result) => resolve(ok(id, type, result)),
						onError: (error) => resolve(fail(id, type, error.message)),
					});
				});
			default:
				return fail(id, type, `${type} is not available for a pi running in a terminal`);
		}
	};

	const onLine = async (client: Socket, text: string) => {
		let record: Json;
		try {
			record = JSON.parse(text);
		} catch {
			return;
		}
		if (record?.type === "extension_ui_response") {
			if (typeof record.id === "string" && dialogs.has(record.id))
				pi.events.emit(DIALOG_EVENTS.answer, { id: record.id, value: record.cancelled ? undefined : record.value } satisfies DialogAnswer);
			return;
		}
		if (typeof record?.type !== "string") return;
		let response: Json | undefined;
		try {
			response = await handle(record);
		} catch (error) {
			response = fail(record.id, record.type, error instanceof Error ? error.message : String(error));
		}
		if (response && !client.destroyed) client.write(line(response));
	};

	const accept = (client: Socket) => {
		clients.add(client);
		client.setEncoding("utf8");
		let buffer = "";
		client.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const text = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (text.trim()) void onLine(client, text);
				newline = buffer.indexOf("\n");
			}
		});
		const drop = () => clients.delete(client);
		client.on("close", drop);
		client.on("error", drop);
		for (const record of catchUp()) client.write(line(record));
	};

	// ------------------------------------------------------------ lifecycle

	const removeSocket = () => {
		if (socketPath) rmSync(socketPath, { force: true });
	};
	const stop = () => {
		for (const client of clients) client.destroy();
		clients.clear();
		server?.close();
		server = null;
		removeSocket();
		socketPath = null;
		process.off("exit", removeSocket);
	};

	pi.on("session_start", (_e, c) => {
		if (c.mode !== "tui") return;
		ctx = c;
		running = !c.isIdle();
		stop();
		const dir = join(getAgentDir(), PRESENCE_DIR);
		const path = join(dir, `${process.pid}${BRIDGE_SOCKET_SUFFIX}`);
		if (path.length > MAX_SOCKET_PATH) return;
		try {
			mkdirSync(dir, { recursive: true });
			rmSync(path, { force: true });
		} catch {
			return;
		}
		socketPath = path;
		const next = createServer(accept);
		next.on("error", () => {
			if (server === next) stop();
		});
		next.listen(path, () => {
			try {
				chmodSync(path, 0o600);
			} catch {}
		});
		server = next;
		// session_shutdown does not run when the terminal is closed under pi.
		process.on("exit", removeSocket);
	});
	pi.on("session_shutdown", () => {
		stop();
		ctx = null;
		running = false;
		streaming = null;
		tools.clear();
		dialogs.clear();
	});
}
