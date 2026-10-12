import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { channelHistory, type HistoryCache, type ModelHistory, modelKey, readChannelResults, saveChannelResult, sessionsRoot } from "pi-capabilities/lib/channelStore.ts";
import { type ChannelResult, estimateCost, IDLE_MS, type ProbeProgress, runChannelTest, sendThroughPi, type StepResult, type Verdict } from "pi-capabilities/lib/channelTest.ts";

// /channel-test [provider/model]: does this channel really cache prompts? The same script and
// judgement as Filo's Settings → Providers → Cache test (pi-capabilities/lib/channelTest.ts),
// sent through this pi's model registry; the result goes to <agent dir>/channel-tests.json, which
// Filo shows too. /channel-test last prints the saved result, /channel-test stop ends a run.

const c = (code: number, s: string) => `\x1b[38;5;${code}m${s}\x1b[39m`;
const OK = 114, WARN = 179, DANGER = 174, MUTED = 244;

const count = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const money = (n: number) => (n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);

const VERDICTS: Record<Verdict, [number, string]> = {
	healthy: [OK, "✓ Cache works"],
	partial: [WARN, "⚠ Cache partly lost"],
	none: [WARN, "⊘ Cache written, never read"],
	unreported: [MUTED, "? No cache figures"],
	fabricated: [DANGER, "⚠ Figures don't add up"],
	failed: [DANGER, "✗ Test failed"],
};

const STATUS: Record<StepResult["status"], [number, string]> = {
	fresh: [MUTED, "—"],
	hit: [OK, "read"],
	partial: [WARN, "partly"],
	miss: [WARN, "missed"],
	excess: [DANGER, "too much"],
};

function explain(r: ChannelResult): string {
	const checked = r.steps.filter((s) => s.kind !== "first");
	const short = checked.filter((s) => s.status === "partial" || s.status === "miss");
	const extra = r.extraCost ? `, about ${money(r.extraCost)} extra` : "";
	switch (r.verdict) {
		case "healthy":
			return "Every request read the previous prompt back from the cache.";
		case "partial":
			if (short.length === 1 && short[0].kind === "idle") return `The cache worked, but was gone after ${Math.round((r.idleMs ?? 0) / 60_000)} minutes idle${extra}.`;
			return `${short.length} of ${checked.length} requests read less than they should; ${count(short.reduce((n, s) => n + s.unread, 0))} billed again${extra}.`;
		case "none":
			return "The provider reports cache writes, but no request read them: every request pays full price.";
		case "unreported":
			return "The provider reported no cache reads or writes: it may not cache, or a relay drops the figures.";
		case "fabricated":
			return "Cache reads were reported on a prompt never sent before, or beyond what was sent: the figures are likely billed by ratio, not measured.";
		case "failed":
			return r.error ?? "";
	}
}

function stepRows(steps: readonly StepResult[]): string[] {
	const head = c(MUTED, `  ${"Request".padEnd(14)}${"Prompt".padStart(8)}${"Expected".padStart(10)}${"Read".padStart(8)}${"Written".padStart(9)}  ${"Result".padEnd(9)}${"TTFT".padStart(6)}`);
	return [
		head,
		...steps.map((s, i) => {
			const [color, label] = STATUS[s.status];
			return `  ${`${i + 1} ${s.kind === "idle" ? "after idle" : s.kind}`.padEnd(14)}${count(s.prompt).padStart(8)}${(s.kind === "first" ? "—" : count(s.expected)).padStart(10)}${count(s.cacheRead).padStart(8)}${count(s.cacheWrite).padStart(9)}  ${c(color, label.padEnd(9))}${secs(s.ttftMs).padStart(6)}`;
		}),
	];
}

export function historyLine(h: ModelHistory | undefined): string {
	if (!h) return "Past 7 days: no requests on this model.";
	if (!h.cachedRequests) return `Past 7 days: ${h.requests.toLocaleString("en-US")} requests, no cache figures.`;
	const rate = Math.round((h.read / Math.max(1, h.prompt)) * 100);
	const extra = h.extraCost >= 0.01 ? `, about ${money(h.extraCost)}` : "";
	const misses = h.misses ? `; ${h.misses.toLocaleString("en-US")} unexpected ${h.misses === 1 ? "miss" : "misses"}, ${count(h.missedTokens)} billed again${extra}` : "; no unexpected misses";
	return `Past 7 days: ${h.requests.toLocaleString("en-US")} requests, ${rate}% read from cache${misses}.`;
}

/** What /channel-test prints when a run ends, and /channel-test last. */
export function channelReport(r: ChannelResult, history?: ModelHistory): string {
	const [color, label] = VERDICTS[r.verdict];
	const metrics = [
		r.cost !== null ? `spent ${money(r.cost)}` : "",
		r.hitRate !== null ? `${Math.round(r.hitRate * 100)}% read from cache` : "",
		r.ttftMs !== null ? `first token ${secs(r.ttftMs)}` : "",
		r.outputTps !== null ? `${Math.round(r.outputTps)} tokens/s` : "",
	].filter(Boolean);
	return [
		`${c(color, label)}  ${r.provider}/${r.model}  ${c(MUTED, new Date(r.at).toLocaleString("en-US"))}`,
		explain(r),
		...(r.steps.length ? ["", ...stepRows(r.steps)] : []),
		...(metrics.length ? ["", c(MUTED, metrics.join(" · "))] : []),
		c(MUTED, historyLine(history)),
	].join("\n");
}

function progressLines(model: string, p: ProbeProgress): string[] {
	const head = p.waitUntil
		? `Cache test ${model}: waiting ${Math.max(0, Math.round((p.waitUntil - Date.now()) / 1000))}s idle before the last request`
		: `Cache test ${model}: request ${p.index + 1} of ${p.total}`;
	return [c(MUTED, `${head} · /channel-test stop to end it`), ...(p.done.length ? stepRows(p.done) : [])];
}

export default function (pi: ExtensionAPI) {
	let running: { controller: AbortController; model: string } | null = null;
	const historyCache: HistoryCache = new Map();
	const history = async (key: string) => (await channelHistory(await sessionsRoot(getAgentDir()), { cache: historyCache }).catch((): Record<string, ModelHistory> => ({})))[key];

	const run = async (ctx: ExtensionCommandContext, spec: string) => {
		const [provider, ...rest] = spec.includes("/") ? spec.split("/") : [];
		const model = spec ? ctx.modelRegistry.find(provider, rest.join("/")) : ctx.model;
		if (!model) {
			ctx.ui.notify(spec ? `No model ${spec} in pi's model list.` : "No model selected.", "error");
			return;
		}
		const key = modelKey(model.provider, model.id);
		const probeModel = { provider: model.provider, id: model.id, name: model.name, cost: model.cost };
		const plain = estimateCost(probeModel);
		const idle = estimateCost(probeModel, { idleMs: IDLE_MS });
		const price = (e: typeof plain) => (e.healthy !== null && e.worst !== null ? `about ${money(e.healthy)}, up to ${money(e.worst)}` : "no prices set");
		const options = [
			`Run: ${plain.requests} requests, ~${count(plain.promptTokens)} prompt tokens, ${price(plain)}`,
			`Run with a ${IDLE_MS / 60_000}-minute idle check: ${idle.requests} requests, ${price(idle)}`,
			"Cancel",
		];
		const choice = await ctx.ui.select(`Test whether ${key} really caches prompts`, options);
		if (!choice || choice === options[2]) return;

		const controller = new AbortController();
		running = { controller, model: key };
		let last: ProbeProgress | undefined;
		const show = () => last && ctx.ui.setWidget("channel-test", progressLines(key, last));
		const timer = setInterval(() => last?.waitUntil && show(), 1000);
		timer.unref?.();
		try {
			const result = await runChannelTest({
				model: probeModel,
				idleMs: choice === options[1] ? IDLE_MS : undefined,
				signal: controller.signal,
				send: (request, signal) => sendThroughPi((context, opts) => ctx.modelRegistry.streamSimple(model, context as any, opts), request, signal),
				onProgress: (p) => {
					last = p;
					show();
				},
			});
			await saveChannelResult(getAgentDir(), result).catch(() => {});
			ctx.ui.setWidget("channel-test", undefined);
			ctx.ui.notify(channelReport(result, await history(key)), result.verdict === "healthy" ? "info" : "warning");
		} catch (error) {
			ctx.ui.setWidget("channel-test", undefined);
			if ((error as Error).name === "AbortError") ctx.ui.notify("Cache test stopped.", "info");
			else ctx.ui.notify(`Cache test failed: ${(error as Error).message}`, "error");
		} finally {
			clearInterval(timer);
			running = null;
		}
	};

	pi.registerCommand("channel-test", {
		description: "Test whether the model's channel really caches prompts (costs a few requests)",
		getArgumentCompletions: (prefix) => {
			const items = ["last", "stop"].map((value) => ({ value, label: value }));
			return items.filter((i) => i.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "stop") {
				if (running) running.controller.abort();
				else ctx.ui.notify("No cache test is running.", "info");
				return;
			}
			if (arg === "last") {
				const model = ctx.model;
				const key = model ? modelKey(model.provider, model.id) : "";
				const result = (await readChannelResults(getAgentDir()))[key];
				ctx.ui.notify(result ? channelReport(result, await history(key)) : `${key || "This model"} has not been tested yet. ${historyLine(await history(key))}`, "info");
				return;
			}
			if (running) {
				ctx.ui.notify(`A cache test of ${running.model} is running; /channel-test stop ends it.`, "warning");
				return;
			}
			// In the background: the conversation stays usable while it runs (the idle check waits minutes).
			void run(ctx, arg);
		},
	});
}
