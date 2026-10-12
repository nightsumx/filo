import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readCapabilityState } from "pi-capabilities/lib/settings.ts";
import { ENV, type CapabilityId } from "pi-capabilities/protocol";

// Capabilities that need the user, who talks to the parent session, not to a subagent.
const PARENT_ONLY = new Set<CapabilityId>(["ask", "plan", "subagent", "review", "autopilot"]);

/**
 * One of pi-capabilities' extensions, loaded by this package when the choice in settings.json (shared
 * with the Filo desktop app; /capabilities changes it) has it on. It stays off where something else
 * owns it: the desktop app loads its own selection with -e, and a subagent's pi skips the ones that
 * need the user.
 */
export const capability = (id: CapabilityId, factory: (pi: ExtensionAPI) => unknown) => (pi: ExtensionAPI) => {
	if (process.env[ENV.host] === "gui") return;
	if (process.env[ENV.subagent] && PARENT_ONLY.has(id)) return;
	if (!readCapabilityState(getAgentDir()).ids.includes(id)) return;
	return factory(pi);
};
