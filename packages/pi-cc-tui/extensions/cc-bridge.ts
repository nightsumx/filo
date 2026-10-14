import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	createLocalBashOperations,
	CustomEditor,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
	BRIDGE_HELLO,
	BRIDGE_PIPE_SUFFIX,
	BRIDGE_SOCKET_SUFFIX,
	DIALOG_EVENTS,
	ENV,
	PRESENCE_DIR,
	type BridgePipe,
	type DialogAnswer,
	type DialogRequest,
} from "pi-capabilities/protocol";
import { thinkingLevels } from "pi-capabilities/lib/thinking.ts";

// Lets the Filo desktop app join this terminal pi instead of starting a second one on the same session
// file (two processes appending to one file fork the conversation). It listens on a unix socket next
// to cc-presence's file and speaks pi's RPC protocol there, as `pi --mode rpc` does on stdio: the app
// sees the run live, token by token, and its prompts, stops, model and mode changes go to this
// process. A client that joins mid-run first gets the run so far. Only the user's own processes can
// connect (mode 0600 in their agent dir), the same ones that could start pi themselves. On Windows it
// is a named pipe announced by a file there, and a client must first send that file's token.
//
// What the app sends goes in as if typed: through the TUI's own Enter, Alt+Enter, Alt+Up and Esc
// (interactive-mode.js), taken from an editor it wired up. So `!cmd`, messages held during a
// compaction, history and the input's source are the terminal's. Images go in as pasted ones do, a
// pi-clipboard file whose path cc-input attaches. Some RPC commands have no equivalent here (fork);
// they answer with an error and the app keeps those for its own pi.
//
// What the extensions show goes out as RPC mode would send it: every extension shares one ui object
// (the runner's), so the bridge wraps it. Statuses, notices and text widgets reach the app; a
// select, confirm or input opens on both sides and the first answer closes the other. An editor or
// custom dialog only the terminal can show; the app hears that one is open.

/** Unix socket paths are limited (104 bytes on macOS); a longer agent dir goes without a bridge. */
const MAX_SOCKET_PATH = 100;

type Json = Record<string, any>;
type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

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

/** Marks the editor factory this bridge installed, so a second session_start does not wrap it again. */
const OWN_FACTORY = Symbol("cc-bridge editor");
/** Marks the ui object this bridge wrapped; a reload makes a new one. */
const SHARED = Symbol("cc-bridge ui");

export default function (pi: ExtensionAPI) {
	// The desktop app's own pi processes already talk to it over RPC; subagents belong to their parent.
	if (process.env[ENV.host] === "gui" || process.env[ENV.subagent]) return;

	let ctx: ExtensionContext | null = null;
	let server: Server | null = null;
	let socketPath: string | null = null;
	/** Windows: the `<pid>.pipe` file, and the token a client sends first. */
	let pipeFile: string | null = null;
	let token: string | null = null;
	const clients = new Set<Socket>();

	// What a client joining mid-run needs to catch up.
	let running = false;
	let streaming: any = null;
	const tools = new Map<string, ToolRun>();
	const statuses = new Map<string, string>();
	const widgets = new Map<string, Json>();
	/** Open dialogs, as RPC's extension_ui_request; a capability's (DIALOG_EVENTS) or one this bridge offers. */
	const dialogs = new Map<string, Json>();
	/** Answers from the app for the dialogs this bridge offers. */
	const answers = new Map<string, (response: Json) => void>();
	/** pi's steering and follow-up queues, as the input event announces them and delivery empties them. */
	const queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
	/** A `!cmd` is running (until pi records it, or its shell ends). */
	let bash = false;
	let compacting = false;
	/** An editor the TUI wired up: its onSubmit and actions are the TUI's own, whichever editor shows. */
	let editor: EditorComponent | null = null;

	const line = (record: Json) => `${JSON.stringify(record)}\n`;
	const broadcast = (record: Json) => {
		if (!clients.size) return;
		const text = line(record);
		for (const client of clients) client.write(text);
	};
	const statusEvent = (key: string, text: string | undefined): Json => ({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: key, statusText: text });
	const setStatusOut = (key: string, text: string | undefined) => {
		if (text) statuses.set(key, text);
		else statuses.delete(key);
		broadcast(statusEvent(key, text));
	};

	const sendQueue = () => broadcast({ type: "queue_update", steering: [...queue.steering], followUp: [...queue.followUp] });
	const clearQueued = () => {
		if (!queue.steering.length && !queue.followUp.length) return;
		queue.steering = [];
		queue.followUp = [];
		sendQueue();
	};

	/** A dialog the app is told about until `run` settles. */
	const shown = async <T>(request: Json, run: (id: string) => Promise<T>): Promise<T> => {
		const id = randomUUID();
		const dialog = { type: "extension_ui_request", id, ...request };
		dialogs.set(id, dialog);
		broadcast(dialog);
		try {
			return await run(id);
		} finally {
			dialogs.delete(id);
			answers.delete(id);
			broadcast({ type: "extension_ui_cancel", id });
		}
	};
	/** A terminal dialog the app may answer too: the first answer wins and closes the other side. */
	const offered = <T>(request: Json, local: (signal: AbortSignal) => Promise<T>, fromApp: (response: Json) => T, signal?: AbortSignal): Promise<T> => {
		const close = new AbortController();
		let answer: { value: T } | undefined;
		return shown(request, async (id) => {
			answers.set(id, (response) => {
				if (close.signal.aborted) return;
				answer = { value: fromApp(response) };
				close.abort();
			});
			const value = await local(signal ? AbortSignal.any([signal, close.signal]) : close.signal);
			return answer ? answer.value : value;
		});
	};
	/** What the extensions show, sent on as RPC mode sends it. */
	const share = (ui: ExtensionUIContext) => {
		if (SHARED in ui) return;
		const { select, confirm, input, editor: edit, custom, notify, setStatus: status, setWidget } = ui;
		const value = (response: Json) => (response.cancelled ? undefined : response.value);
		// Capability dialogs with an app side of their own: approval (DIALOG_EVENTS), ask and plan (/gui-… commands).
		const covered = () => dialogs.size > 0 || [...tools.values()].some((run) => run.toolName === "ask" || run.toolName === "propose_plan");
		Object.assign(ui, {
			[SHARED]: true,
			select: (title: string, options: string[], opts?: Json) =>
				offered({ method: "select", title, options, timeout: opts?.timeout }, (signal) => select(title, options, { ...opts, signal }), value, opts?.signal),
			confirm: (title: string, message: string, opts?: Json) =>
				offered({ method: "confirm", title, message, timeout: opts?.timeout }, (signal) => confirm(title, message, { ...opts, signal }), (response) => !response.cancelled && response.confirmed === true, opts?.signal),
			input: (title: string, placeholder?: string, opts?: Json) =>
				offered({ method: "input", title, placeholder, timeout: opts?.timeout }, (signal) => input(title, placeholder, { ...opts, signal }), value, opts?.signal),
			// pi's editor dialog cannot be closed from outside, and a custom one is the terminal's own drawing.
			editor: (title: string, prefill?: string) => shown({ method: "terminal", title }, () => edit(title, prefill)),
			// Not pi's method: the app says the terminal is asking something only it can show.
			custom: (factory: any, options?: any) => (covered() ? custom(factory, options) : shown({ method: "terminal" }, () => custom(factory, options))),
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notify(message, type);
				broadcast({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType: type });
			},
			setStatus: (key: string, text: string | undefined) => {
				status(key, text);
				setStatusOut(key, text);
			},
			// As RPC mode: text widgets only; a drawn one leaves the app without this key.
			setWidget: (key: string, content: any, options?: any) => {
				setWidget(key, content, options);
				const lines = Array.isArray(content) ? content : undefined;
				const widget = { type: "extension_ui_request", id: randomUUID(), method: "setWidget", widgetKey: key, widgetLines: lines, widgetPlacement: options?.placement };
				if (lines) widgets.set(key, widget);
				else widgets.delete(key);
				broadcast(widget);
			},
		});
	};

	const catchUp = (): Json[] => {
		const out: Json[] = [...[...statuses].map(([key, text]) => statusEvent(key, text)), ...widgets.values()];
		if (queue.steering.length || queue.followUp.length) out.push({ type: "queue_update", steering: [...queue.steering], followUp: [...queue.followUp] });
		if (running) {
			out.push({ type: "agent_start" });
			for (const [toolCallId, run] of tools) {
				out.push({ type: "tool_execution_start", toolCallId, toolName: run.toolName, args: run.args });
				if (run.partial !== undefined) out.push({ type: "tool_execution_update", toolCallId, toolName: run.toolName, args: run.args, partialResult: run.partial });
			}
			if (streaming) out.push(...replayMessage(streaming));
		}
		out.push(...dialogs.values());
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
		// pi takes a delivered message off its queue by its text, steering first (agent-session.js).
		if (e.message.role === "user") {
			const content = e.message.content;
			const text = typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("");
			const kind = queue.steering.includes(text) ? "steering" : queue.followUp.includes(text) ? "followUp" : undefined;
			if (kind) {
				queue[kind].splice(queue[kind].indexOf(text), 1);
				sendQueue();
			}
		}
		// Taken back in the terminal (Alt+Up), or a text an extension changed on its way in.
		if (!c.hasPendingMessages()) clearQueued();
		broadcast({ type: "message_start", message: e.message });
	});
	pi.on("input", (e) => {
		if (!e.streamingBehavior) return;
		queue[e.streamingBehavior === "steer" ? "steering" : "followUp"].push(e.text);
		sendQueue();
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
	pi.on("agent_settled", (_e, c) => {
		if (!c.hasPendingMessages()) clearQueued();
		running = false;
		streaming = null;
		tools.clear();
		broadcast({ type: "agent_settled" });
	});
	pi.on("session_before_compact", (e) => {
		compacting = true;
		broadcast({ type: "compaction_start", reason: e.reason });
	});
	pi.on("session_compact", (e) => {
		compacting = false;
		broadcast({ type: "compaction_end", reason: e.reason });
	});
	pi.on("session_compact_failed", (e) => {
		compacting = false;
		broadcast({ type: "compaction_end", reason: e.reason, aborted: e.aborted, errorMessage: e.aborted ? undefined : e.errorMessage });
	});
	// pi records a `!cmd` without an event (agent-session.js recordBashResult; during a run, at its end).
	// While the app is here, it runs through pi's own local shell with its output copied out, as RPC's
	// bash_execution_update; the start and end around it, and the id, are not pi's.
	pi.on("user_bash", (e, c) => {
		const seen = c.sessionManager.getEntries().length;
		const file = c.sessionManager.getSessionFile();
		const id = clients.size ? randomUUID() : undefined;
		bash = true;
		const timer = setInterval(() => {
			if (ctx?.sessionManager.getSessionFile() !== file) {
				bash = false;
				return clearInterval(timer);
			}
			const entries = c.sessionManager.getEntries() as any[];
			const found = entries.slice(seen).find((entry) => entry.type === "message" && entry.message?.role === "bashExecution" && entry.message.command === e.command);
			if (!found) return;
			clearInterval(timer);
			bash = false;
			broadcast({ type: "message_start", message: found.message });
			broadcast({ type: "message_end", message: found.message, bashId: id });
		}, 200);
		if (!id) return;
		broadcast({ type: "bash_execution_start", id, command: e.command, excludeFromContext: e.excludeFromContext });
		const local = createLocalBashOperations({ shellPath: SettingsManager.create(c.cwd, getAgentDir(), { projectTrusted: c.isProjectTrusted() }).getShellPath() });
		const decoder = new TextDecoder();
		return {
			operations: {
				exec: async (command, cwd, options) => {
					try {
						const result = await local.exec(command, cwd, {
							...options,
							onData: (data) => {
								options.onData(data);
								// As pi cleans it (bash-executor.js): no escapes, no control characters but tab and newline.
								const delta = [...stripVTControlCharacters(decoder.decode(data, { stream: true }))]
									.filter((ch) => {
										const code = ch.charCodeAt(0);
										return code === 9 || code === 10 || (code > 31 && (code < 0xfff9 || code > 0xfffb));
									})
									.join("");
								if (delta) broadcast({ type: "bash_execution_update", id, delta });
							},
						});
						broadcast({ type: "bash_execution_end", id, exitCode: options.signal?.aborted ? undefined : (result.exitCode ?? undefined), cancelled: !!options.signal?.aborted });
						return result;
					} catch (error) {
						broadcast({ type: "bash_execution_end", id, cancelled: !!options.signal?.aborted });
						throw error;
					} finally {
						bash = false;
					}
				},
			},
		};
	});
	pi.on("session_info_changed", (e) => broadcast({ type: "session_info_changed", name: e.name }));
	pi.on("thinking_level_select", (e) => broadcast({ type: "thinking_level_changed", level: e.level }));
	// Not pi's: the app re-reads get_state (the model shows in its picker).
	pi.on("model_select", () => broadcast({ type: "state_changed" }));

	// A capability's own terminal dialog the app may answer too (approval prompts).
	pi.events.on(DIALOG_EVENTS.open, (data) => {
		const dialog = data as DialogRequest;
		if (!dialog?.id) return;
		dialogs.set(dialog.id, { type: "extension_ui_request", ...dialog });
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
		isCompacting: compacting,
		sessionFile: c.sessionManager.getSessionFile(),
		sessionId: c.sessionManager.getSessionId(),
		sessionName: pi.getSessionName(),
		messageCount: c.sessionManager.getEntries().filter((e: any) => e.type === "message").length,
		pendingMessageCount: queue.steering.length + queue.followUp.length,
		terminalPid: process.pid,
	});

	// Duck-typed as pi does: instanceof fails across jiti module boundaries.
	const action = (name: string): (() => unknown) | undefined => {
		const handlers = editor && "actionHandlers" in editor ? editor.actionHandlers : undefined;
		return handlers instanceof Map ? handlers.get(name) : undefined;
	};

	/** The TUI clears its editor as it takes input; what the user was typing there stays. */
	const keepDraft = (c: ExtensionContext, use: () => unknown) => {
		const draft = c.ui.getEditorText();
		void use();
		if (c.ui.getEditorText() !== draft) c.ui.setEditorText(draft);
	};

	const prompt = (c: ExtensionContext, command: Json): Json => {
		const text = String(command.message ?? "");
		const images = Array.isArray(command.images) ? command.images : [];
		const busy = !c.isIdle();
		const name = text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0] : "";
		const isCommand = !!name && pi.getCommands().some((cmd) => cmd.source === "extension" && cmd.name === name);
		const deliverAs = command.type === "steer" ? "steer" : command.type === "follow_up" ? "followUp" : busy ? (command.streamingBehavior === "steer" ? "steer" : "followUp") : undefined;
		const disposition = isCommand || text.startsWith("!") ? "handled" : busy ? "queued" : "started";
		const submit = editor?.onSubmit;
		const followUp = action("app.message.followUp");
		// Commands (the app's hidden /gui-… ones among them) skip the editor, so its history only has what the user typed.
		if (!submit || isCommand || (deliverAs === "followUp" && !followUp)) {
			// expandPromptTemplates runs extension commands, templates and skills, as typed in the terminal.
			pi.sendUserMessage(images.length ? [{ type: "text", text }, ...images] : text, { deliverAs, expandPromptTemplates: true });
			return { disposition };
		}
		const paths = images.map((image: any) => {
			const file = joinPath(tmpdir(), `pi-clipboard-${randomUUID()}.${String(image.mimeType ?? "image/png").split("/")[1] ?? "png"}`);
			writeFileSync(file, Buffer.from(String(image.data ?? ""), "base64"));
			return file;
		});
		const full = [text, ...paths].filter(Boolean).join(" ");
		if (deliverAs === "followUp" && followUp)
			keepDraft(c, () => {
				c.ui.setEditorText(full);
				return followUp();
			});
		else keepDraft(c, () => submit(full));
		return { disposition };
	};

	/** Alt+Up: the TUI puts the whole queue in its editor; the app takes it from there. */
	const clearQueue = (c: ExtensionContext): Json => {
		const dequeue = action("app.message.dequeue");
		if (!dequeue) return { steering: [], followUp: [] };
		const draft = c.ui.getEditorText();
		c.ui.setEditorText("");
		dequeue();
		const taken = c.ui.getEditorText();
		c.ui.setEditorText(draft);
		clearQueued();
		return { steering: taken ? [taken] : [], followUp: [] };
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
			case "bash": {
				const submit = editor?.onSubmit;
				if (!submit) return fail(id, type, "The terminal's editor is not available");
				keepDraft(c, () => submit(`${command.excludeFromContext ? "!!" : "!"}${command.command}`));
				return ok(id, type);
			}
			case "abort_bash": {
				// The TUI's Esc: idle, it cancels the running `!cmd` (mid-run it stops the run instead).
				const escape = editor && "onEscape" in editor ? editor.onEscape : undefined;
				if (bash && c.isIdle() && typeof escape === "function") escape();
				return ok(id, type);
			}
			case "abort":
				c.abort();
				return ok(id, type);
			case "clear_queue":
				return ok(id, type, clearQueue(c));
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
			if (typeof record.id !== "string" || !dialogs.has(record.id)) return;
			const answer = answers.get(record.id);
			if (answer) answer(record);
			else pi.events.emit(DIALOG_EVENTS.answer, { id: record.id, value: record.cancelled ? undefined : record.value } satisfies DialogAnswer);
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

	const join = (client: Socket) => {
		clients.add(client);
		for (const record of catchUp()) client.write(line(record));
	};

	const accept = (client: Socket) => {
		// With a token (Windows), a client hears nothing until it sent it.
		let joined = !token;
		if (joined) clients.add(client);
		client.setEncoding("utf8");
		let buffer = "";
		client.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const text = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!text.trim()) continue;
				if (joined) {
					void onLine(client, text);
					continue;
				}
				let hello: Json | null;
				try {
					hello = JSON.parse(text);
				} catch {
					hello = null;
				}
				if (hello?.type !== BRIDGE_HELLO || hello.token !== token) {
					client.destroy();
					return;
				}
				joined = true;
				join(client);
			}
		});
		const drop = () => clients.delete(client);
		client.on("close", drop);
		client.on("error", drop);
		if (joined) for (const record of catchUp()) client.write(line(record));
	};

	// ------------------------------------------------------------ lifecycle

	const removeSocket = () => {
		if (pipeFile) rmSync(pipeFile, { force: true });
		else if (socketPath) rmSync(socketPath, { force: true });
	};
	const stop = () => {
		for (const client of clients) client.destroy();
		clients.clear();
		server?.close();
		server = null;
		removeSocket();
		socketPath = null;
		pipeFile = null;
		token = null;
		process.off("exit", removeSocket);
	};

	pi.on("session_start", (_e, c) => {
		if (c.mode !== "tui") return;
		ctx = c;
		running = !c.isIdle();
		compacting = false;
		stop();
		share(c.ui);
		// An editor another extension set stays; this only keeps a hold of what the TUI builds.
		const prev = c.ui.getEditorComponent();
		if (!prev || !(OWN_FACTORY in prev)) {
			const factory: EditorFactory = (tui, theme, keybindings) => {
				editor = prev ? prev(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
				return editor;
			};
			c.ui.setEditorComponent(Object.assign(factory, { [OWN_FACTORY]: true }));
		}
		const dir = joinPath(getAgentDir(), PRESENCE_DIR);
		const windows = process.platform === "win32";
		const path = windows
			? `\\\\.\\pipe\\pi-cc-bridge-${process.pid}-${randomUUID()}`
			: joinPath(dir, `${process.pid}${BRIDGE_SOCKET_SUFFIX}`);
		if (!windows && path.length > MAX_SOCKET_PATH) return;
		try {
			mkdirSync(dir, { recursive: true });
			if (!windows) rmSync(path, { force: true });
		} catch {
			return;
		}
		socketPath = path;
		if (windows) token = randomBytes(24).toString("hex");
		const next = createServer(accept);
		next.on("error", () => {
			if (server === next) stop();
		});
		next.listen(path, () => {
			if (server !== next) return;
			if (token) {
				// Announced once it listens, so the app never finds a pipe nobody serves.
				const file = joinPath(dir, `${process.pid}${BRIDGE_PIPE_SUFFIX}`);
				try {
					writeFileSync(file, JSON.stringify({ path, token } satisfies BridgePipe), { mode: 0o600 });
					pipeFile = file;
				} catch {}
				return;
			}
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
		answers.clear();
		widgets.clear();
		queue.steering = [];
		queue.followUp = [];
	});
}
