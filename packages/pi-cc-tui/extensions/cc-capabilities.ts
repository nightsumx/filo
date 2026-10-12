// /capabilities: which of pi-capabilities' extensions load, the same choice the Filo desktop app's
// Settings → Capabilities shows (saved in settings.json). Saving reloads pi so it applies at once.
// The spending limit's amount is saved right away: the budget capability reads it at every check.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CAPABILITIES, isBudget, normalizeCapabilities, PRESETS, presetOf } from "pi-capabilities/lib/catalog.ts";
import { readCapabilityState, writeCapabilityChoice } from "pi-capabilities/lib/settings.ts";
import { ENV, type CapabilityId } from "pi-capabilities/protocol";

// The desktop app's own capabilities (appOnly) are not listed, and keep their state when toggling here.
const LISTED = CAPABILITIES.filter((c) => !c.appOnly);

const tokens = (ids: readonly CapabilityId[]) => LISTED.filter((c) => ids.includes(c.id)).reduce((sum, c) => sum + c.contextTokens, 0);

/** The menu rows for a set: presets, then each capability as a checkbox, then Save. */
export function capabilityMenu(ids: readonly CapabilityId[], budget: number): { label: string; pick: (ids: CapabilityId[]) => CapabilityId[] | "save" | "budget" }[] {
	const current = presetOf(ids)?.id;
	return [
		...PRESETS.map((p) => ({
			label: `${p.label.en}${p.id === current ? "  ✔" : ""}  · ~${tokens(p.capabilities)} tokens`,
			pick: () => [...p.capabilities],
		})),
		...LISTED.map((c) => ({
			label: `  ${ids.includes(c.id) ? "[x]" : "[ ]"} ${c.label.en}  · ${c.contextTokens}`,
			pick: (now: CapabilityId[]) => normalizeCapabilities(now.includes(c.id) ? now.filter((id) => id !== c.id) : [...now, c.id]),
		})),
		...(ids.includes("budget") ? [{ label: `      Spending limit: $${budget} per prompt  (change)`, pick: () => "budget" as const }] : []),
		{ label: "Save and reload", pick: () => "save" as const },
	];
}

export default function (pi: ExtensionAPI) {
	// The desktop app has its own settings page; a subagent's pi has no user to ask.
	if (process.env[ENV.host] === "gui" || process.env[ENV.subagent]) return;

	pi.registerCommand("capabilities", {
		description: "Choose which capabilities load (todo, questions, approvals, plan, subagents, review, autopilot); shared with Filo",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const saved = readCapabilityState(getAgentDir());
			let ids = [...saved.ids];
			let budget = saved.budget;
			for (;;) {
				const menu = capabilityMenu(ids, budget);
				const choice = await ctx.ui.select(`Capabilities · ~${tokens(ids)} tokens per request · shared with Filo`, menu.map((row) => row.label));
				// Esc: nothing changes.
				if (choice === undefined) return;
				const next = menu[menu.findIndex((row) => row.label === choice)].pick(ids);
				if (next === "budget") {
					const amount = Number(await ctx.ui.input("Spending limit per prompt, in US dollars", String(budget)));
					if (!isBudget(amount)) continue;
					try {
						await writeCapabilityChoice(getAgentDir(), { budget: amount });
						budget = amount;
					} catch (error) {
						ctx.ui.notify(`Spending limit not saved: ${(error as Error).message}`, "error");
					}
					continue;
				}
				if (next !== "save") {
					ids = next;
					continue;
				}
				if (ids.join(",") === saved.ids.join(",") && saved.saved) return;
				try {
					await writeCapabilityChoice(getAgentDir(), { enabled: presetOf(ids)?.id ?? ids });
				} catch (error) {
					return ctx.ui.notify(`Capabilities not saved: ${(error as Error).message}`, "error");
				}
				await ctx.waitForIdle();
				return ctx.reload();
			}
		},
	});
}
