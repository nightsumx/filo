import { keyText } from "@earendil-works/pi-coding-agent";

// State shared between this package's extensions.
// pi may load each extension file as its own module graph, so the store lives on globalThis.

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface Todo {
	content: string;
	status: "pending" | "in_progress" | "completed";
	activeForm: string;
}

export interface Shared {
	mode: PermissionMode;
	todos: Todo[];
	showShortcuts: boolean;
	/** Until this time (ms), the second status row reads "Press ctrl+c again to exit". */
	exitHintUntil: number;
	/** Live UI handle, used for the active theme (light/dark palette, message background). */
	ui?: { theme?: { appearance?: string; fg?(color: string, s: string): string; bg?(color: string, s: string): string } };
}

const KEY = Symbol.for("pi-cc-tui.shared");

export const shared: Shared = ((globalThis as any)[KEY] ??= {
	mode: "bypassPermissions",
	todos: [],
	showShortcuts: false,
	exitHintUntil: 0,
} satisfies Shared);

/** Key label for a pi keybinding, with Claude Code's "esc" spelling. */
export const key = (id: string) => keyText(id as any).replace(/\bescape\b/g, "esc");
/** The permission-mode shortcut, spelled the way pi spells alt on this platform. */
export const MODE_KEY = process.platform === "darwin" ? "option+m" : "alt+m";

export const REJECTED =
	"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

export const fg = (code: number, s: string) => `\x1b[38;5;${code}m${s}\x1b[39m`;

// 256-color approximations of Claude Code's dark and light palettes.
const DARK = {
	claude: 174,
	shimmer: 216,
	muted: 246,
	suggestion: 147, // #b1b9f9
	autoAccept: 141, // #af87ff
	bash: 205, // #fd5db1
	plan: 66, // #48968c
	error: 211,
	info: 153,
	spinner: 110,
	barOn: 250,
	barOff: 239,
};
const LIGHT: typeof DARK = {
	claude: 173, // #d77757
	shimmer: 173,
	muted: 242, // #666666
	suggestion: 63, // #5769f7
	autoAccept: 93, // #8700ff
	bash: 198, // #ff0087
	plan: 23, // #006666
	error: 125, // #ab2b3f
	info: 25,
	spinner: 25,
	barOn: 240,
	barOff: 252,
};

export const COLOR = new Proxy(DARK, {
	get: (dark, key: keyof typeof DARK) => (shared.ui?.theme?.appearance === "light" ? LIGHT : dark)[key],
}) as Readonly<typeof DARK>;
