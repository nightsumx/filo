import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { COLOR, fg, key, MODE_KEY } from "./lib/shared.ts";

// Claude Code's startup box:
// ╭────────────────────────────╮
// │ ✻ Welcome to Claude Code!  │
// │                            │
// │   /help for help, …        │
// │                            │
// │   cwd: /path/to/project    │
// ╰────────────────────────────╯
export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader(() => ({
			invalidate() {},
			render(width: number) {
				const border = (s: string) => fg(COLOR.claude, s);
				const cwd = ctx.cwd.startsWith(homedir()) ? `~${ctx.cwd.slice(homedir().length)}` : ctx.cwd;
				const rows = [
					`${fg(COLOR.claude, "✻")} Welcome to \x1b[1mpi\x1b[22m!`,
					"",
					fg(COLOR.muted, `  /hotkeys for shortcuts, /settings for your current setup`),
					fg(COLOR.muted, `  ${key("app.model.select")} to switch models, ${MODE_KEY} for permission modes`),
					"",
					fg(COLOR.muted, `  cwd: ${cwd}`),
				];
				const inner = Math.min(Math.max(...rows.map(visibleWidth)) + 2, width - 2);
				if (inner < 10) return [];
				const line = (row: string) => {
					const cell = truncateToWidth(` ${row}`, inner, "…");
					return border("│") + cell + " ".repeat(Math.max(0, inner - visibleWidth(cell))) + border("│");
				};
				return ["", border(`╭${"─".repeat(inner)}╮`), ...rows.map(line), border(`╰${"─".repeat(inner)}╯`), ""];
			},
		}));
	});
}
