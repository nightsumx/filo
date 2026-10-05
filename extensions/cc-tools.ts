import { getLanguageFromPath, highlightCode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { relative, resolve } from "node:path";

const fg = (code: number, s: string) => `\x1b[38;5;${code}m${s}\x1b[39m`;
const green = (s: string) => `\x1b[38;2;153;213;143m${s}\x1b[39m`;
const bold = (s: string | number) => `\x1b[1m${s}\x1b[22m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const ELBOW = fg(246, "  ⎿ \xa0");
const HINT = "(ctrl+o to expand)";
const BUILTIN = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);
const TITLE: Record<string, string> = { bash: "Bash", read: "Read", edit: "Update", write: "Write", grep: "Search", find: "Search", ls: "List" };
const GROUP: Record<string, [string, string, string, string]> = {
	read: ["Read", "Reading", "file", "files"],
	grep: ["Searched for", "Searching for", "pattern", "patterns"],
	find: ["Searched for", "Searching for", "pattern", "patterns"],
	ls: ["Listed", "Listing", "directory", "directories"],
};
const MONOKAI = [["38;5;4", "38;5;197"], ["38;5;6", "38;5;81"], ["38;5;3", "38;5;148"], ["38;5;2", "38;5;141"], ["38;5;1", "38;5;186"], ["39", "38;5;231"]];
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
	if (name === "read" || name === "edit" || name === "write") return file(args.path, cwd);
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

function emphasize(s: string, from: number, to: number) {
	let out = "";
	let col = 0;
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\x1b") {
			let j = i + 1;
			if (s[j] === "[") {
				j++;
				while (j < s.length && !(s[j] >= "@" && s[j] <= "~")) j++;
			}
			out += s.slice(i, j + 1);
			i = j;
			continue;
		}
		if (col === from) out += "\x1b[48;5;28m";
		if (col === to) out += "\x1b[48;5;22m";
		out += s[i];
		col++;
	}
	return out + "\x1b[48;5;22m";
}

function diffRows(diff: string, path: string, width: number) {
	const lang = getLanguageFromPath(path);
	const hl = (code: string) =>
		MONOKAI.reduce((out, [from, to]) => out.split(`\x1b[${from}m`).join(`\x1b[${to}m`), lang ? (highlightCode(code, lang)[0] ?? code) : code);
	const rows = diff.split("\n").map((line) => {
		let i = 1;
		while (line[i] === " ") i++;
		while (line[i] >= "0" && line[i] <= "9") i++;
		return { mark: line[0], num: line.slice(1, i), code: line.slice(i + 1) };
	});
	const fill = (row: string) => {
		const cut = truncateToWidth(row, width - 5, "");
		return cut + " ".repeat(Math.max(0, width - 5 - visibleWidth(cut))) + "\x1b[39m\x1b[49m";
	};
	return rows.map((row, i) => {
		if (!row.num.trim()) return dim(` ${row.num}   ...`);
		if (row.mark === "-") return fill(`\x1b[48;5;52m\x1b[38;5;167m ${row.num} -\x1b[38;5;231m${row.code}`);
		if (row.mark !== "+") return `${dim(`\x1b[38;5;231m ${row.num} `)}\x1b[38;5;231m ${hl(row.code)}\x1b[39m`;
		let start = i;
		while (rows[start - 1]?.mark === "+") start--;
		let removedEnd = start;
		while (rows[removedEnd - 1]?.mark === "-") removedEnd--;
		const old = start - removedEnd > i - start ? rows[removedEnd + (i - start)].code : undefined;
		let code = hl(row.code);
		if (old !== undefined) {
			let p = 0;
			while (p < old.length && p < row.code.length && old[p] === row.code[p]) p++;
			let s = 0;
			while (s < old.length - p && s < row.code.length - p && old[old.length - 1 - s] === row.code[row.code.length - 1 - s]) s++;
			if ((p || s) && p < row.code.length - s) code = emphasize(code, p, row.code.length - s);
		}
		return fill(`\x1b[48;5;22m\x1b[38;5;77m ${row.num} +\x1b[38;5;231m${code}`);
	});
}

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
	if (name === "edit") {
		const diff = String(result?.details?.diff ?? "");
		let added = 0;
		let removed = 0;
		for (const line of diff.split("\n")) {
			if (line[0] === "+") added++;
			if (line[0] === "-") removed++;
		}
		const head = [added ? `Added ${plural(added, "line")}` : "", removed ? `${added ? "removed" : "Removed"} ${plural(removed, "line")}` : ""].filter(Boolean).join(", ");
		return [head || "No changes", ...(diff ? diffRows(diff, String(args?.path ?? ""), width) : [])];
	}
	if (name === "write") {
		const content = String(args?.content ?? "");
		const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
		const lang = getLanguageFromPath(String(args?.path ?? ""));
		const pad = String(lines.length).length;
		const rows = lines.map((line, i) => `${dim(`\x1b[38;5;231m ${String(i + 1).padStart(pad)} `)}\x1b[38;5;231m${lang ? (highlightCode(line, lang)[0] ?? line) : line}\x1b[39m`);
		return [`Wrote ${plural(lines.length, "line")} to ${bold(file(args?.path, cwd))}`, ...preview(rows, expanded, 10)];
	}
	if (name === "read" && !expanded) return [`Read ${plural(out ? out.split("\n").length : 0, "line")}`];
	if (!out) return [fg(246, "(No output)")];
	return preview(out.split("\n"), expanded, 3);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => {
		session = ctx.sessionManager;
	});

	pi.registerToolRenderer((name, next) => {
		const base = next();
		if (!BUILTIN.has(name) && base?.renderShell === "self") return base;
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
