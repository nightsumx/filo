// Capabilities are pi extensions from the pi-capabilities workspace package, loaded per project with
// `-e`. Their catalog (labels, presets), where the choice is saved, and the wire protocol they speak
// live in the package and are re-exported here.
import type { AutopilotDecision as AutopilotDecisionOf, ReviewDetails as ReviewDetailsOf, SubagentDetails as SubagentDetailsOf } from 'pi-capabilities/protocol'
import type { AgentMessage, AssistantMessage } from './pi'
import type { CapabilityId } from 'pi-capabilities/protocol'
import { CAPABILITIES } from 'pi-capabilities/lib/catalog.ts'

export * from 'pi-capabilities/protocol'
export * from 'pi-capabilities/lib/catalog.ts'
export type SubagentDetails = SubagentDetailsOf<AgentMessage, AssistantMessage>
export type ReviewDetails = ReviewDetailsOf<AgentMessage, AssistantMessage>
export type AutopilotDecision = AutopilotDecisionOf<AgentMessage, AssistantMessage>

/** Tool name → capability, for transcript rendering. */
export const CAPABILITY_TOOLS: ReadonlyMap<string, CapabilityId> = new Map(CAPABILITIES.flatMap(c => c.tools.map(t => [t, c.id] as const)))

