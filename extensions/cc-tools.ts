import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { relative, resolve } from "node:path";

const fg = (code: number, s: string) => `\x1b[38;5;${code}m${s}\x1b[39m`;
const green = (s: string) => `\x1b[38;2;153;213;143m${s}\x1b[39m`;
const bold = (s: string | number) => `\x1b[1m${s}\x1b[22m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const ELBOW = fg(246, "  ⎿ \xa0");
const HINT = "(ctrl+o to expand)";
const BUILTIN = new Set(["bash", "read", "grep", "find", "ls"]);
const TITLE: Record<string, string> = { bash: "Bash", read: "Read", grep: "Search", find: "Search", ls: "List" };
const GROUP: Record<string, [string, string, string, string]> = {
	read: ["Read", "Reading", "file", "files"],
	grep: ["Searched for", "Searching for", "pattern", "patterns"],
	find: ["Searched for", "Searching for", "pattern", "patterns"],
	ls: ["Listed", "Listing", "directory", "directories"],
};
const EMPTY = { render: () => [], invalidate() {} };

let session: { getBranch(): any[] } | undefined;
let cache = { key: "", runs: new Map<string, { id: string; name: string }[]>(), done: new Set<string>() };

function groups() {
	const entries = session?.getBranch() ?? [];
	const key = `${entries.length}:${entries.at(-1)?.id}`;
	if (cache.key === key) return cache;
	cache = { key, runs: new Map(), done: new Set() };
	let run: { id: string; name: string }[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const m = entry.message;
		if (m.role === "toolResult") {
			cache.done.add(m.toolCallId);
			continue;
		}
		if (m.role !== "assistant") {
			run = [];
			continue;
		}
		for (const part of m.content) {
			if (part.type === "text" && part.text.trim()) run = [];
			if (part.type !== "toolCall") continue;
			if (!GROUP[part.name]) {
				run = [];
				continue;
			}
			run.push({ id: part.id, name: part.name });
			cache.runs.set(part.id, run);
		}
	}
	return cache;
}

const textOf = (result: any) =>
	(result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

function file(path: unknown, cwd: string) {
	if (typeof path !== "string") return "";
	const abs = resolve(cwd, path);
	const rel = relative(cwd, abs);
	const shown = rel && !rel.startsWith("..") ? rel : path;
	return getCapabilities().hyperlinks ? hyperlink(shown, `file://${abs}`) : shown;
}

function argsOf(name: string, args: any, cwd: string) {
	if (!args) return "";
	if (name === "bash") return String(args.command ?? "").split("\n")[0];
	if (name === "read") return file(args.path, cwd);
	if (name === "ls") return file(args.path ?? ".", cwd);
	if (name === "grep" || name === "find")
		return [`pattern: ${JSON.stringify(args.pattern ?? "")}`, args.path ? `path: ${JSON.stringify(args.path)}` : ""].filter(Boolean).join(", ");
	return Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
}

function block(lines: string[], width: number) {
	const w = Math.max(1, width - 5);
	return lines.flatMap((line) => (visibleWidth(line) > w ? wrapTextWithAnsi(line, w) : [line])).map((line, i) => (i ? "     " : ELBOW) + line);
}

function preview(lines: string[], expanded: boolean, max: number) {
	if (expanded || lines.length <= max) return lines;
	return [...lines.slice(0, max), dim(`… +${lines.length - max} lines ${HINT}`)];
}

const plural = (n: number, word: string) => `${bold(n)} ${word}${n === 1 ? "" : "s"}`;

function resultLines(name: string, result: any, expanded: boolean, isPartial: boolean, isError: boolean, args: any, cwd: string, width: number) {
	const out = textOf(result).trimEnd();
	if (isError) {
		const marker = "Command exited with code ";
		const at = out.lastIndexOf(marker);
		const head = at >= 0 ? `Error: Exit code ${out.slice(at + marker.length).trim()}` : `Error: ${out.split("\n")[0]}`;
		const rest = (at >= 0 ? out.slice(0, at).trim() : out.split("\n").slice(1).join("\n")).split("\n").filter(Boolean);
		return [head, ...preview(rest, expanded, 3)].map((line) => fg(211, line));
	}
	if (name === "bash" && isPartial) return [fg(246, "Running…")];
	if (isPartial) return [];
	if (name === "read" && !expanded) return [`Read ${plural(out ? out.split("\n").length : 0, "line")}`];
	if (!out) return [fg(246, "(No output)")];
	return preview(out.split("\n"), expanded, 3);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => {
		session = ctx.sessionManager;
		const grouping = (globalThis as any)[Symbol.for("pi.ccstyle.tool-grouping-patch")];
		if (grouping) grouping.enabled = () => false;
	});

	pi.registerToolRenderer((name, next) => {
		const base = next();
		if (!BUILTIN.has(name) && (base?.renderShell === "self" || name === "edit" || name === "write")) return base;
		return {
			renderShell: "self",
			renderCall(args: any, _theme: any, context: any) {
				if (GROUP[name] && !context.expanded) {
					return {
						invalidate() {},
						render(width: number) {
							const { runs, done } = groups();
							const run = runs.get(context.toolCallId) ?? [{ id: context.toolCallId, name }];
							if (run[0].id !== context.toolCallId) return [];
							const pending = run.some((t) => !done.has(t.id));
							const counts = new Map<string, [number, string[]]>();
							for (const t of run) {
								const label = GROUP[t.name];
								counts.set(label[2], [(counts.get(label[2])?.[0] ?? 0) + 1, label]);
							}
							const phrases = [...counts.values()].map(([n, label], i) => {
								const verb = label[pending ? 1 : 0];
								return `${i ? verb.toLowerCase() : verb} ${bold(n)} ${n === 1 ? label[2] : label[3]}`;
							});
							return [truncateToWidth(`  ${fg(246, `${phrases.join(", ")}${pending ? "…" : ""} ${HINT}`)}`, width, "…")];
						},
					};
				}
				const title = TITLE[name] ?? name;
				const shown = argsOf(name, args, context.cwd);
				const icon = context.isError ? fg(211, "⏺") : context.isPartial ? fg(246, "⏺") : green("⏺");
				return {
					invalidate() {},
					render: (width: number) => [truncateToWidth(`${icon} ${bold(title)}${shown ? `(${shown})` : ""}`, width, "…")],
				};
			},
			renderResult(result: any, options: any, _theme: any, context: any) {
				if (GROUP[name] && !options.expanded) return EMPTY;
				return {
					invalidate() {},
					render: (width: number) =>
						block(resultLines(name, result, options.expanded, options.isPartial, context.isError, context.args, context.cwd, width), width),
				};
			},
		};
	});
}
