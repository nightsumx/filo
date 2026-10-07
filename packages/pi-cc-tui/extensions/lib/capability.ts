import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENV, type CapabilityId } from "pi-capabilities/protocol";

// Capabilities that need the user, who talks to the parent session, not to a subagent.
const PARENT_ONLY = new Set<CapabilityId>(["ask", "plan", "subagent", "review"]);

/**
 * One of pi-capabilities' extensions, loaded by this package. It stays off where something else owns
 * it: the Pi desktop app loads its own selection with -e, and a subagent's pi skips the ones that
 * need the user.
 */
export const capability = (id: CapabilityId, factory: (pi: ExtensionAPI) => unknown) => (pi: ExtensionAPI) => {
	if (process.env[ENV.host] === "gui") return;
	if (process.env[ENV.subagent] && PARENT_ONLY.has(id)) return;
	return factory(pi);
};
