// pi's model list as prices (pi-capabilities/lib/prices.ts): what Claude Code and Codex threads and
// their logs are counted at. Read through the provider helper, so models.json and the pi version are
// the user's, and read again when providers change or it is a few minutes old.
import type { PriceList } from 'pi-capabilities/lib/prices.ts'

const STALE_MS = 10 * 60_000

let list: PriceList = {}
let readAt = 0
let reading: Promise<PriceList> | null = null
let source: (() => Promise<PriceList>) | null = null

/** The list last read; empty until the first read lands. */
export const priceList = () => {
    if (Date.now() - readAt > STALE_MS)
        void refreshPrices()
    return list
}

/** Where the list is read from (the provider helper); reads it at once. */
export function readPricesFrom(read: () => Promise<PriceList>) {
    source = read
    readAt = 0
    return refreshPrices()
}

/** Reads the list again (or joins the read under way); resolves to the newest list either way. */
export function refreshPrices(): Promise<PriceList> {
    if (!source)
        return Promise.resolve(list)
    readAt = Date.now()
    reading ??= source().then(
        (read) => {
            list = read
            return read
        },
        () => {
            // pi not set up yet, or broken: try again in a minute.
            readAt = Date.now() - STALE_MS + 60_000
            return list
        },
    ).finally(() => {
        reading = null
    })
    return reading
}
