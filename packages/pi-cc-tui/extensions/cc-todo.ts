import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { shared, type Todo } from "./lib/shared.ts";

const TOOL = "TodoWrite";

const TodoParams = Type.Object({
	todos: Type.Array(
		Type.Object({
			content: Type.String({ minLength: 1, description: 'What needs to be done, imperative form ("Run tests")' }),
			status: StringEnum(["pending", "in_progress", "completed"] as const),
			activeForm: Type.String({ minLength: 1, description: 'Present continuous form shown while working ("Running tests")' }),
		}),
		{ description: "The complete updated todo list" },
	),
});

const DESCRIPTION = `Create and manage a structured task list for the current session. It helps you track progress on multi-step work and shows the user what you are doing.

Use it when a task has 3 or more distinct steps, when the user gives you several things to do, or when the user asks for a todo list. Skip it for a single trivial task or a purely conversational answer.

Each call replaces the whole list. Keep exactly one task in_progress while working, mark a task completed as soon as it is fully done (not when tests fail or work is partial), and add new tasks as you discover them. Remove tasks that are no longer relevant.`;

const STRIKE = (s: string) => `\x1b[9m${s}\x1b[29m`;

// Claude Code's todo rendering: ☒ struck-through when done, bold ☐ for the current task.
export const renderTodos = (todos: Todo[], theme: any, prefix = "⎿  ", indent = "   ") =>
	todos
		.map((todo, i) => {
			const lead = i === 0 ? prefix : indent;
			if (todo.status === "completed") return lead + theme.fg("dim", `☒ ${STRIKE(todo.content)}`);
			if (todo.status === "in_progress") return lead + theme.bold(`☐ ${todo.content}`);
			return lead + `☐ ${todo.content}`;
		})
		.join("\n");

export default function (pi: ExtensionAPI) {
	// Restore the list for the active branch, so /tree and resumed sessions show the right state.
	const restore = (ctx: ExtensionContext) => {
		shared.todos = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== TOOL) continue;
			const todos = (entry.message.details as { todos?: Todo[] } | undefined)?.todos;
			if (Array.isArray(todos)) shared.todos = todos;
		}
	};
	pi.on("session_start", (_e, ctx) => restore(ctx));
	pi.on("session_tree", (_e, ctx) => restore(ctx));

	pi.registerTool({
		name: TOOL,
		label: "Update Todos",
		description: DESCRIPTION,
		promptSnippet: "Track multi-step work as a todo list the user can see",
		parameters: TodoParams,
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		executionMode: "sequential",

		async execute(_id, params) {
			const todos = params.todos.map((t) => ({ content: t.content, status: t.status, activeForm: t.activeForm }));
			const active = todos.filter((t) => t.status === "in_progress").length;
			shared.todos = todos;
			let text = "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable";
			if (active > 1) text += `\n\nNote: ${active} tasks are in_progress; keep exactly one in_progress at a time.`;
			return { content: [{ type: "text", text }], details: { todos } };
		},

		// Drawn without pi's tool box, like Claude Code: "⏺ Update Todos" with the list hanging under "⎿".
		renderShell: "self",

		renderCall(_args, theme, context) {
			const dot = context.isError ? theme.fg("error", "⏺") : context.executionStarted && !context.isPartial ? theme.fg("success", "⏺") : theme.fg("dim", "⏺");
			return new Text(`${dot} ${theme.bold("Update Todos")}`, 0, 0);
		},

		renderResult(result, _options, theme, context) {
			const todos = (result.details as { todos?: Todo[] } | undefined)?.todos;
			if (context.isError) {
				const text = result.content.find((c) => c.type === "text")?.text ?? "Error";
				return new Text(`${theme.fg("dim", "  ⎿  ")}${theme.fg("error", text)}`, 0, 0);
			}
			if (!todos?.length) return new Text(theme.fg("dim", "  ⎿  (no todos)"), 0, 0);
			return new Text(renderTodos(todos, theme, theme.fg("dim", "  ⎿  "), "     "), 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current todo list",
		handler: async (_args, ctx) => {
			const todos = shared.todos;
			if (!todos.length) return ctx.ui.notify("No todos yet", "info");
			const done = todos.filter((t) => t.status === "completed").length;
			ctx.ui.notify(`${done}/${todos.length} done\n${todos.map((t) => `${t.status === "completed" ? "☒" : "☐"} ${t.content}`).join("\n")}`, "info");
		},
	});
}
