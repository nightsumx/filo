import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GUI_EVENTS, type ApprovalMode } from "pi-capabilities/protocol";
import { setTuiStyle } from "pi-capabilities/tui/dialog.ts";
import { COLOR, fg, shared, type PermissionMode } from "./lib/shared.ts";

// Claude Code's permission modes on top of the approval and plan capabilities:
//   default = approval "ask", acceptEdits = "edits", bypassPermissions = "auto", plan = plan mode on.
// The capabilities own the state (per session, shared with the desktop app); this file only shows it
// under the input, cycles it with option+m (pi keeps shift+tab for thinking levels) and offers
// /permissions.

const CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
const LABEL: Record<PermissionMode, string> = {
	default: "Default (ask before edits and commands)",
	acceptEdits: "Accept edits (ask before commands)",
	plan: "Plan mode (read-only until you approve a plan)",
	bypassPermissions: "Bypass permissions (never ask)",
};
const APPROVAL: Record<Exclude<PermissionMode, "plan">, ApprovalMode> = {
	default: "ask",
	acceptEdits: "edits",
	bypassPermissions: "auto",
};

export default function (pi: ExtensionAPI) {
	let approval: ApprovalMode | undefined;
	let plan = false;
	const sync = () => {
		shared.mode = plan ? "plan" : approval === "ask" ? "default" : approval === "edits" ? "acceptEdits" : "bypassPermissions";
	};
	pi.events.on(GUI_EVENTS.approvalMode, (mode) => {
		approval = mode as ApprovalMode;
		sync();
	});
	pi.events.on(GUI_EVENTS.planMode, (on) => {
		plan = on === true;
		sync();
	});

	// Permission and plan boxes use Claude Code's lavender instead of the theme accent.
	setTuiStyle({ accent: (text) => fg(COLOR.suggestion, text) });

	const set = (mode: PermissionMode) => {
		if (mode === "plan") return pi.events.emit(GUI_EVENTS.planSet, true);
		pi.events.emit(GUI_EVENTS.planSet, false);
		pi.events.emit(GUI_EVENTS.approvalSet, APPROVAL[mode]);
	};

	pi.on("session_start", () => {
		approval = undefined;
		plan = false;
	});

	// Shown as option+m on macOS (MODE_KEY); the terminal sends it as alt+m.
	pi.registerShortcut("alt+m", {
		description: "Cycle permission mode",
		handler: () => set(CYCLE[(CYCLE.indexOf(shared.mode) + 1) % CYCLE.length]),
	});

	pi.registerCommand("permissions", {
		description: "Choose when pi asks before editing files or running commands",
		handler: async (args, ctx: ExtensionContext) => {
			const arg = args?.trim() as PermissionMode;
			if (CYCLE.includes(arg)) return set(arg);
			const labels = CYCLE.map((mode) => (mode === shared.mode ? `${LABEL[mode]}  ✔` : LABEL[mode]));
			const choice = await ctx.ui.select("Permission mode", labels);
			if (choice) set(CYCLE[labels.indexOf(choice)]);
		},
	});
}
