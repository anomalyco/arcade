import { existsSync, readFileSync, writeFileSync } from "node:fs"

export type MotionLedger = Record<string, Record<string, number>>

/** Partial refreshes preserve unsampled tapes. Raising/removing a channel requires an explicit debt acceptance. */
export function writeMotionLedger(path: string, proposed: MotionLedger, acceptRegression = false) {
  const existing: MotionLedger = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}
  const changes: { tape: string; channel: string; before: number | undefined; after: number | undefined }[] = []
  for (const [tape, values] of Object.entries(proposed)) {
    for (const [channel, after] of Object.entries(values)) {
      if (!Number.isFinite(after) || after < 0) throw new Error(`Invalid ledger value: ${tape} ${channel} ${after}`)
      const before = existing[tape]?.[channel]
      if (Object.keys(existing).length && (before === undefined || after > before)) changes.push({ tape, channel, before, after })
    }
    for (const [channel, before] of Object.entries(existing[tape] ?? {}))
      if (!(channel in values)) changes.push({ tape, channel, before, after: undefined })
  }
  for (const c of changes) console.log(`ledger ${c.tape} ${c.channel}: ${c.before ?? "new"} -> ${c.after ?? "removed"}`)
  if (changes.length && !acceptRegression)
    throw new Error(`${changes.length} raised/new/removed ledger channels. Review the findings, then use --accept-regression to write them.`)
  writeFileSync(path, JSON.stringify({ ...existing, ...proposed }) + "\n")
  return changes
}
