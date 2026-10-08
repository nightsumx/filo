// Session entries the transcript shows: custom entries (`pi.appendEntry`) a capability writes outside
// the model's context. The main process reads them from the file, the renderer from `entry_appended`.
import { AUTOPILOT_TYPES, REVIEW_TYPES } from './capabilities'

export function isShownEntry(entry: any): boolean {
    switch (entry?.customType) {
        case REVIEW_TYPES.report:
            return entry.data?.kind === 'review'
        case AUTOPILOT_TYPES.decision:
            return entry.data?.kind === 'autopilot'
        case AUTOPILOT_TYPES.card:
            return entry.data?.kind === 'autopilot-card'
        case AUTOPILOT_TYPES.answer:
            return typeof entry.data?.cardId === 'string'
        default:
            return false
    }
}
