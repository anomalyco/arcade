/** A town and its house layouts are separate seeds; preserve both after New town. */
export type RunSeed = { seed: number; houseSeed: number; terrain: number }

export function runSeedCode(run: RunSeed): string {
  return run.seed === run.houseSeed ? String(run.seed) : `${run.seed}.${run.houseSeed}`
}

export function parseRunSeed(raw: string): { seed: number; houseSeed: number } | null {
  if (!/^\d{1,10}(\.\d{1,10})?$/.test(raw.trim())) return null
  const [seed, houseSeed = seed] = raw.trim().split(".").map(Number)
  if (seed! > 0xffffffff || houseSeed! > 0xffffffff) return null
  return { seed: seed!, houseSeed: houseSeed! }
}

/** Only public world-generation inputs belong in a replay link, never room credentials or debug flags. */
export function runSeedLink(run: RunSeed): string {
  const url = new URL("https://anoma.ly/arcade/outbreak/")
  url.searchParams.set("seed", String(run.seed))
  url.searchParams.set("houseSeed", String(run.houseSeed))
  url.searchParams.set("terrain", String(run.terrain))
  return url.href
}

/** Reload this page with a new run, retaining the player's URL-selected look, name and other options. */
export function runSeedLocation(run: RunSeed, href: string): string {
  const url = new URL(href)
  for (const [key, value] of new URL(runSeedLink(run)).searchParams) url.searchParams.set(key, value)
  return url.href
}
