import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { validateStations, type LabStation } from "@arcade/kit/lab/overworld/types"
import { LAB_GAMES } from "../src/games/registry"

const dir = join(import.meta.dir, "../src/stations")
const files = readdirSync(dir).filter(f => f.endsWith(".ts") && f !== "index.ts" && f !== "define.ts")
const stations: LabStation[] = await Promise.all(files.map(async f => (await import(join(dir, f))).default as LabStation))
// The Lab's own sections (packages/kit/lab/main.ts) plus the Audio section games/lab adds.
const SHARED = ["effects", "weather", "lighting", "looks", "materials", "foliage", "physics", "spawn", "audio"]

describe("Lab Overworld stations", () => {
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
})
