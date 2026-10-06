import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REJECTED, shared, type PermissionMode } from "./lib/shared.ts";

// Claude Code's shift+tab order. pi keeps shift+tab for thinking levels, so alt+m cycles here
// (the key Claude Code itself uses where shift+tab is unavailable).
const CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
const LABEL: Record<PermissionMode, string> = {
	default: "Default (ask before edits and commands)",
	acceptEdits: "Accept edits (ask before commands)",
	plan: "Plan mode (no edits, ask before commands)",
	bypassPermissions: "Bypass permissions (never ask)",
};
const EDIT_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

const PLAN_BLOCKED =
	"Plan mode is on, so files can't be changed yet. Finish researching, then present your plan and wait for the user to approve it.";
const PLAN_REMINDER =
	"<system-reminder>Plan mode is active. The user wants you to research and plan, not to change anything yet. Do not edit or write files, and do not run commands that modify the system. When your plan is ready, present it and wait for the user to approve it.</system-reminder>";

const isMode = (value: unknown): value is PermissionMode => CYCLE.includes(value as PermissionMode);

const preview = (text: string, sign: string, max = 8) => {
	const lines = text.replace(/\n$/, "").split("\n");
	const shown = lines.slice(0, max).map((line) => `  ${sign} ${line}`);
	if (lines.length > max) shown.push(`  … ${lines.length - max} more lines`);
	return shown.join("\n");
};

export default function (pi: ExtensionAPI) {
	// Commands approved with "don't ask again", for this session only.
	const allowedCommands = new Set<string>();
	// One prompt at a time: parallel tool calls wait, then re-check the (possibly changed) mode.
	let queue: Promise<unknown> = Promise.resolve();

	pi.registerFlag("permission-mode", {
		description: `Starting permission mode: ${CYCLE.join(", ")} (default: bypassPermissions)`,
		type: "string",
		default: "bypassPermissions",
	});

	const setMode = (mode: PermissionMode, ctx?: ExtensionContext) => {
		shared.mode = mode;
		ctx?.ui.notify(`Permission mode: ${LABEL[mode]}`, "info");
	};

	pi.on("session_start", () => {
		const flag = pi.getFlag("permission-mode");
		if (isMode(flag)) shared.mode = flag;
		allowedCommands.clear();
	});

	pi.registerShortcut("alt+m", {
		description: "Cycle permission mode",
		handler: () => {
			shared.mode = CYCLE[(CYCLE.indexOf(shared.mode) + 1) % CYCLE.length];
		},
	});

	pi.registerCommand("permissions", {
		description: "Choose when pi asks before editing files or running commands",
		handler: async (args, ctx) => {
			const arg = args?.trim();
			if (isMode(arg)) return setMode(arg, ctx);
			const labels = CYCLE.map((mode) => (mode === shared.mode ? `${LABEL[mode]}  ✔` : LABEL[mode]));
			const choice = await ctx.ui.select("Permission mode", labels);
			if (choice) setMode(CYCLE[labels.indexOf(choice)], ctx);
		},
	});

	pi.on("before_agent_start", () => {
		if (shared.mode !== "plan") return;
		return { message: { customType: "cc-plan-mode", content: PLAN_REMINDER, display: false } };
	});

	const ask = async (event: any, ctx: ExtensionContext) => {
		const name = event.toolName as string;
		const input = event.input ?? {};
		const mode = shared.mode;
		if (mode === "bypassPermissions") return undefined;

		if (EDIT_TOOLS.has(name)) {
			if (mode === "plan") return { block: true, reason: PLAN_BLOCKED };
			if (mode === "acceptEdits") return undefined;
		} else if (SHELL_TOOLS.has(name)) {
			if (allowedCommands.has(String(input.command ?? "").trim())) return undefined;
		} else {
			return undefined;
		}

		// Print/JSON modes can't ask; keep pi's default of running the tool.
		if (!ctx.hasUI) return undefined;

		let title: string;
		let always: string;
		if (SHELL_TOOLS.has(name)) {
			const command = String(input.command ?? "").trim();
			title = `${name === "bash" ? "Bash" : "PowerShell"} command\n\n${preview(command, " ", 12)}\n${input.description ? `  ${input.description}\n` : ""}\nDo you want to proceed?`;
			always = "Yes, and don't ask again for this command this session";
		} else {
			const path = String(input.path ?? input.file_path ?? "");
			const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path);
			const body =
				name === "edit"
					? (Array.isArray(input.edits) ? input.edits : [input])
							.map((e: any) => `${preview(String(e.oldText ?? e.old_string ?? ""), "-", 4)}\n${preview(String(e.newText ?? e.new_string ?? ""), "+", 4)}`)
							.join("\n\n")
					: preview(String(input.content ?? ""), "+");
			const verb = name === "edit" ? "Edit file" : existsSync(abs) ? "Overwrite file" : "Create file";
			title = `${verb}  ${path}\n\n${body}\n\nDo you want to ${name === "edit" ? "make this edit to" : verb === "Create file" ? "create" : "overwrite"} ${basename(path)}?`;
			always = "Yes, allow all edits during this session";
		}

		const options = ["1. Yes", `2. ${always}`, "3. No, and tell pi what to do differently (esc)"];
		const choice = await ctx.ui.select(title, options);
		if (choice === options[0]) return undefined;
		if (choice === options[1]) {
			if (SHELL_TOOLS.has(name)) allowedCommands.add(String(input.command ?? "").trim());
			else shared.mode = "acceptEdits";
			return undefined;
		}
		return { block: true, reason: REJECTED, terminate: true };
	};

	pi.on("tool_call", (event, ctx) => {
		const result = queue.then(() => ask(event, ctx));
		queue = result.catch(() => undefined);
		return result;
	});
}
