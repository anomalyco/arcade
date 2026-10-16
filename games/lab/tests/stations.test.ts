import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { validateStations, type LabStation } from "@arcade/kit/lab/stations/types"
import { composedSetup, composes, defaultPicks, pickAfter, variantGroups } from "@arcade/kit/lab/stations/variants"
import { LAB_GAMES } from "../src/games/registry"

const dir = join(import.meta.dir, "../src/stations")
const files = readdirSync(dir).filter(f => f.endsWith(".ts") && f !== "index.ts" && f !== "define.ts")
const stations: LabStation[] = await Promise.all(files.map(async f => (await import(join(dir, f))).default as LabStation))
// The Lab's own sections (packages/kit/lab/main.ts) plus the Audio section games/lab adds.
const SHARED = ["effects", "weather", "lighting", "looks", "materials", "foliage", "physics", "spawn", "audio", "world"]

describe("Lab stations", () => {
  test("every station file validates", () => {
    expect(validateStations(stations)).toEqual([])
    expect(stations.length).toBeGreaterThanOrEqual(13)
  })
  test("section demos name a shared section or a game section with its game, unless the section is still on a branch", () => {
    for (const s of stations) {
      if (s.demo.kind !== "section") continue
      const owner = LAB_GAMES.find(g => g.sections.includes(s.demo.kind === "section" ? s.demo.section : ""))
      if (owner) expect({ station: s.id, game: s.demo.game }).toEqual({ station: s.id, game: owner.id })
      else if (!SHARED.includes(s.demo.section)) expect({ station: s.id, status: s.status }).not.toEqual({ station: s.id, status: "live" })
    }
  })
  test("orders are unique so quick-travel keys are stable", () => {
    expect(new Set(stations.map(s => s.order)).size).toBe(stations.length)
  })
  test("sets of variants are groups, not prefixes on one flat list", () => {
    // "Look · Today" or "Vignette: broken in" is a group squashed into a label: give the variants a `group` instead.
    const prefixed = stations.flatMap(s => {
      const prefixes = (s.variants ?? []).map(v => /^([A-Z][\w ]*)( · |: )/.exec(v.label)?.[1]).filter(p => p !== undefined)
      return [...new Set(prefixes.filter((p, i) => prefixes.indexOf(p) !== i))].map(p => `${s.id}: "${p}"`)
    })
    expect(prefixed).toEqual([])
  })
  test("Outbreak look's variants are six groups that compose, opening on today's look at the start house", () => {
    const st = stations.find(s => s.id === "outbreak-look")!
    expect(variantGroups(st.variants).map(g => g.id)).toEqual(["Look", "Hero", "Shot", "Weather", "Beam", "Unseen"])
    expect(composes(st)).toBe(true)
    const picks = defaultPicks(st)
    expect(Object.fromEntries([...picks].map(([g, v]) => [g, v.id]))).toEqual({ Look: "today", Hero: "hero-from-look", Shot: "front-walk-dusk", Weather: "clear", Beam: "beam-medium", Unseen: "unseen-shroud-blend" })
    // A Hero pick re-applies the Look under it rather than resetting it.
    const mannequin = st.variants!.find(v => v.id === "hero-mannequin")!
    const setup = composedSetup(st, pickAfter(st, picks, st.variants!.find(v => v.id === "deeper-noir")!), mannequin)
    const look = setup.findIndex(c => c.command === "look.preset" && c.args?.preset === "deeper-noir")
    const hero = setup.findIndex(c => c.args?.key === "heroStyle" && c.args?.value === 1)
    expect(look).toBeGreaterThanOrEqual(0)
    expect(hero).toBeGreaterThan(look)
  })
})
