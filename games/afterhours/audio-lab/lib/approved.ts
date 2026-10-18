// Takes the user approved by listening. They are never regenerated, replaced or renumbered; only loudness-normalised.
// Source of truth: every audio-lab/picks-*.json export (entries with category + variant) plus the list below.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const EXTRA = [{ category: "light-breaker", variant: "v3", prompt: "industrial knife switch pulled, power shuts off with descending hum" }]

export interface ApprovedPick {
  category: string
  variant: string
  prompt: string
  source: string
}

export function loadApproved(root = join(import.meta.dir, "..")): ApprovedPick[] {
  const out: ApprovedPick[] = EXTRA.map((p) => ({ ...p, source: "user (earlier session)" }))
  for (const f of readdirSync(root).filter((f) => /^picks-.*\.json$/.test(f)).sort()) {
    const j = JSON.parse(readFileSync(join(root, f), "utf8"))
    for (const p of j.picks ?? []) {
      if (!p.category || !p.variant) continue
      if (p.fav === false) continue
      if (!out.some((o) => o.category === p.category && o.variant === p.variant))
        out.push({ category: p.category, variant: p.variant, prompt: p.prompt ?? "", source: f })
    }
  }
  return out
}

export const APPROVED = loadApproved()
export const isApproved = (category: string, variant: string) =>
  APPROVED.some((p) => p.category === category && p.variant === variant)
/** Prompts of approved takes: the house style for new prompts. */
export const styleExamples = (category?: string) => {
  const same = APPROVED.filter((p) => p.category === category).map((p) => p.prompt)
  const rest = APPROVED.filter((p) => p.category !== category).map((p) => p.prompt)
  return [...same, ...rest]
}
