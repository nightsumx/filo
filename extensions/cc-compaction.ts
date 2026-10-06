import { keyText, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Loader, truncateToWidth } from "@earendil-works/pi-tui";

const fg = (code: number, s: string) => `\x1b[38;5;${code}m${s}\x1b[39m`;
const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];
const SPIN = [...FRAMES, ...FRAMES.slice(1, -1).reverse()];
const BAR_MAX = 40;

// Shared between the stream tap (counts output) and the indicator render (draws it).
const state = {
	owner: undefined as object | undefined, // the CompactionStatusIndicator currently on screen
	start: 0,
	active: false, // between session_before_compact and session_compact(_failed)
	expected: 2000, // rough summary size in tokens; drives the progress curve
	base: 0, // progress already shown when the first output token arrived
	sizes: new Map<object, number>(), // partial message -> chars streamed so far
};

const outputTokens = () => {
	let chars = 0;
	for (const n of state.sizes.values()) chars += n;
	return Math.round(chars / 4);
};

const size = (message: any) =>
	(message?.content ?? []).reduce(
		(n: number, c: any) => n + (c.type === "text" ? c.text.length : c.type === "thinking" ? c.thinking.length : 0),
		0,
	);

// The summary length is unknown up front, so progress is an estimate:
// up to 10% while the model reads the prompt, then an ease-out on output tokens that never reaches 100%.
const waiting = (ms: number) => 10 * (1 - Math.exp(-ms / 8000));
const progress = (now: number) => {
	const out = outputTokens();
	if (!out) return waiting(now - state.start);
	return state.base + (99 - state.base) * (1 - Math.exp(-out / state.expected));
};

const duration = (ms: number) => {
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h ? `${h}h ${m}m ${s % 60}s` : m ? `${m}m ${s % 60}s` : `${s}s`;
};
const count = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

// Count streamed chars of every summarization request (split turns run two).
// Keyed by the partial message so a routed request forwarded through two streams counts once.
const tap = (stream: any) => {
	const push = stream.push;
	stream.push = function (event: any) {
		const message = event?.partial ?? event?.message;
		if (state.active && message && typeof message === "object") {
			if (!state.sizes.size) state.base = waiting(Date.now() - state.start);
			state.sizes.set(message, size(message));
		}
		return push.call(this, event);
	};
	return stream;
};

const patched = new WeakSet<object>();
const patchRuntime = (registry: any) => {
	// Compaction streams through the same ModelRuntime the extension registry wraps.
	const runtime = registry?.runtime;
	if (!runtime || patched.has(runtime) || typeof runtime.streamSimple !== "function") return;
	patched.add(runtime);
	const streamSimple = runtime.streamSimple;
	runtime.streamSimple = function (...args: any[]) {
		const stream = streamSimple.apply(this, args);
		return state.active ? tap(stream) : stream;
	};
};

const loader = Loader.prototype as any;
const loaderRender = loader.render;
loader.render = function (width: number) {
	if (this.kind !== "compaction") return loaderRender.call(this, width);
	const now = Date.now();
	if (state.owner !== this) {
		state.owner = this;
		state.start = now;
		state.base = 0;
		state.sizes.clear();
	}
	const label = String(this.message ?? "").includes("overflow") ? "Context full, compacting conversation…" : "Compacting conversation…";
	const out = outputTokens();
	const meta = [duration(now - state.start), out ? `↓ ${count(out)} tokens` : "", `${keyText("app.interrupt") || "esc"} to cancel`].filter(Boolean).join(" · ");
	const spinner = SPIN[Math.floor((now - state.start) / 120) % SPIN.length];

	const pct = Math.floor(progress(now));
	const cells = Math.max(10, Math.min(BAR_MAX, width - 7));
	const filled = Math.round((cells * pct) / 100);
	const bar = fg(250, "▰".repeat(filled)) + fg(239, "▱".repeat(cells - filled));

	return [
		"",
		truncateToWidth(`${fg(110, spinner)} ${fg(153, label)} ${fg(246, `(${meta})`)}`, width, ""),
		truncateToWidth(`  ${bar} ${fg(246, `${pct}%`)}`, width, ""),
	];
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => patchRuntime(ctx.modelRegistry));

	pi.on("session_before_compact", (event, ctx) => {
		patchRuntime(ctx.modelRegistry);
		state.active = true;
		state.base = 0;
		state.sizes.clear();
		// An iterative update tends to come out about as long as the previous summary.
		const previous = event.preparation.previousSummary;
		state.expected = previous ? Math.max(1500, Math.round((previous.length / 4) * 1.2)) : 2000;
		// Return nothing so pi runs its default compaction.
	});

	const stop = () => {
		state.active = false;
	};
	pi.on("session_compact", stop);
	pi.on("session_compact_failed", stop);
}
