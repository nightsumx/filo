import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENV, PRESENCE_DIR, type Presence, type PresenceState } from "pi-capabilities/protocol";

// Tools that sit waiting for the user while they run.
const WAITING_TOOLS = new Set(["ask", "propose_plan"]);

/**
 * Tells the Filo desktop app what this terminal pi is doing: idle, running, or waiting for an answer.
 * The app lists terminal sessions next to its own threads; with this they get the same status dot.
 */
export default function (pi: ExtensionAPI) {
	// The desktop app's own pi processes report over RPC; subagents are part of their parent's run.
	if (process.env[ENV.host] === "gui" || process.env[ENV.subagent]) return;
	let file: string | null = null;
	let current: Omit<Presence, "state" | "since"> | null = null;
	let state: PresenceState = "idle";
	let since = Date.now();
	const waiting = new Set<string>();

	const write = () => {
		if (!file || !current) return;
		try {
			// Rename over the old file: the app never reads a half-written one.
			writeFileSync(`${file}.tmp`, JSON.stringify({ ...current, state, since } satisfies Presence));
			renameSync(`${file}.tmp`, file);
		} catch {}
	};
	const set = (next: PresenceState) => {
		if (next === state) return;
		state = next;
		since = Date.now();
		write();
	};
	const remove = () => {
		if (file) rmSync(file, { force: true });
	};
	const onExit = () => remove();

	pi.on("session_start", (_e, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const dir = join(getAgentDir(), PRESENCE_DIR);
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			return;
		}
		file = join(dir, `${process.pid}.json`);
		current = { pid: process.pid, cwd: ctx.cwd, session: ctx.sessionManager.getSessionFile() };
		state = "idle";
		since = Date.now();
		waiting.clear();
		write();
		// session_shutdown does not run when the terminal is closed under pi.
		process.off("exit", onExit);
		process.on("exit", onExit);
	});
	pi.on("agent_start", () => set("running"));
	pi.on("tool_execution_start", (e) => {
		if (!WAITING_TOOLS.has(e.toolName)) return;
		waiting.add(e.toolCallId);
		set("waiting");
	});
	pi.on("tool_execution_end", (e) => {
		if (!waiting.delete(e.toolCallId) || waiting.size) return;
		set(state === "waiting" ? "running" : state);
	});
	pi.on("agent_settled", () => {
		waiting.clear();
		set("idle");
	});
	pi.on("session_shutdown", () => {
		remove();
		file = null;
		current = null;
		process.off("exit", onExit);
	});
}
