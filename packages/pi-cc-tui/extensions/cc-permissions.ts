import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { COLOR, fg, REJECTED, shared, type PermissionMode } from "./lib/shared.ts";

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

const preview = (text: string, sign: string, max = 8, color = (s: string) => s) => {
	const lines = text.replace(/\n$/, "").split("\n");
	const shown = lines.slice(0, max).map((line) => color(sign ? `  ${sign} ${line}` : `  ${line}`));
	if (lines.length > max) shown.push(fg(COLOR.muted, `  … ${lines.length - max} more lines`));
	return shown;
};

interface Prompt {
	title: string;
	body: string[];
	question: string;
	options: string[];
}

// Claude Code's permission dialog: a rounded box with numbered choices, ❯ on the selected one.
// 1-9 pick directly, enter confirms, esc / ctrl+c choose the last option ("No").
const choose = async (ctx: ExtensionContext, prompt: Prompt): Promise<number> => {
	const { title, body, question, options } = prompt;
	const no = options.length - 1;
	if (ctx.mode !== "tui") {
		const labels = options.map((o, i) => `${i + 1}. ${o}`);
		const choice = await ctx.ui.select([title, "", ...body, "", question].join("\n"), labels);
		return choice ? labels.indexOf(choice) : no;
	}
	return ctx.ui.custom<number>((tui, _theme, _kb, done) => {
		let selected = 0;
		const accent = (s: string) => fg(COLOR.suggestion, s);
		return {
			invalidate() {},
			handleInput(data: string) {
				const digit = Number(data);
				if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) return done(digit - 1);
				if (matchesKey(data, "up")) selected = (selected + options.length - 1) % options.length;
				else if (matchesKey(data, "down") || matchesKey(data, "tab")) selected = (selected + 1) % options.length;
				else if (matchesKey(data, "enter")) return done(selected);
				else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return done(no);
				else return;
				tui.requestRender();
			},
			render(width: number) {
				const inner = Math.max(1, width - 4);
				const rows = [
					`\x1b[1m${accent(title)}\x1b[22m`,
					"",
					...body,
					"",
					question,
					...options.map((o, i) => (i === selected ? accent(`❯ ${i + 1}. ${o}`) : `  ${i + 1}. ${o}`)),
				];
				const lines = rows
					.flatMap((row) => (row ? wrapTextWithAnsi(row, inner) : [""]))
					.map((line) => {
						const text = truncateToWidth(line, inner, "");
						return `${accent("│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${accent("│")}`;
					});
				const rule = "─".repeat(Math.max(0, width - 2));
				return [accent(`╭${rule}╮`), ...lines, accent(`╰${rule}╯`)];
			},
		};
	});
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

		let prompt: Prompt;
		const no = "No, and tell pi what to do differently (esc)";
		if (SHELL_TOOLS.has(name)) {
			const command = String(input.command ?? "").trim();
			prompt = {
				title: `${name === "bash" ? "Bash" : "PowerShell"} command`,
				body: [...preview(command, "", 12), ...(input.description ? [fg(COLOR.muted, `  ${input.description}`)] : [])],
				question: "Do you want to proceed?",
				options: ["Yes", "Yes, and don't ask again for this command this session", no],
			};
		} else {
			const path = String(input.path ?? input.file_path ?? "");
			const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path);
			const removed = (s: string) => ctx.ui.theme.fg("toolDiffRemoved", s);
			const added = (s: string) => ctx.ui.theme.fg("toolDiffAdded", s);
			const body =
				name === "edit"
					? (Array.isArray(input.edits) ? input.edits : [input]).flatMap((e: any, i: number) => [
							...(i ? [""] : []),
							...preview(String(e.oldText ?? e.old_string ?? ""), "-", 4, removed),
							...preview(String(e.newText ?? e.new_string ?? ""), "+", 4, added),
						])
					: preview(String(input.content ?? ""), "+", 8, added);
			const verb = name === "edit" ? "Edit file" : existsSync(abs) ? "Overwrite file" : "Create file";
			prompt = {
				title: verb,
				body: [fg(COLOR.muted, path), "", ...body],
				question: `Do you want to ${name === "edit" ? "make this edit to" : verb === "Create file" ? "create" : "overwrite"} ${basename(path)}?`,
				options: ["Yes", "Yes, allow all edits during this session", no],
			};
		}

		const choice = await choose(ctx, prompt);
		if (choice === 0) return undefined;
		if (choice === 1) {
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
