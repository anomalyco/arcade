import { describe, expect, test } from "bun:test"
import { distToRect } from "@arcade/kit/sim/geom"
import { inBuildingFootprint, propShape, type Town } from "../shared/map"
import { LocalSession } from "../shared/session"
import { buildDetailMeshes } from "../src/details/models"
import {
  BLOOD_WORDS,
  BUILDING_DETAIL_BUDGET,
  DETAIL_MODELS,
  frontWallSpans,
  isHome,
  placeBuildingDetails,
  placeCarDetails,
  placeDetails,
  wordWidth,
  type DetailSite,
} from "../src/details/placement"
import { DEFAULT_DETAIL_SETTINGS, detailControls, type OutbreakDetailSettings } from "../src/details/settings"
import { createOutbreakSettings, getOutbreakSetting } from "../src/settings"

const settings = (patch: Partial<OutbreakDetailSettings> = {}): OutbreakDetailSettings => ({ ...DEFAULT_DETAIL_SETTINGS, ...patch })
const all = settings({ dtTurnedOver: 1, dtBoxes: 1, dtMarks: 1, dtStreetJunk: 2 })

/** The start block, a commercial strip, a civic block with houses, and a residential block, as the streamer loads them. */
function towns(): Town[] {
  return [
    [28, 44],
    [-50, 44],
    [44, 150],
    [150, 150],
  ].map(([x, y]) => {
    const s = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
    s.view.player.x = x!
    s.view.player.y = y!
    s.rebuildCollision()
    return s.view.town
  })
}

const INDOOR = new Set(["chair", "crockery", "mail", "boxes2", "boxes3", "books", "drawer", "tv"])
const indoor = (d: DetailSite) => INDOOR.has(d.model)
const onWall = (d: DetailSite) => d.model === "markX" || d.model.startsWith("word") || d.model.startsWith("blood")

describe("world details placement", () => {
  test("seeded from the town and dtSeed: the same town places the same details; a reroll moves them", () => {
    const [a, b] = [towns()[2]!, towns()[2]!]
    const first = placeDetails(a, all)
    expect(first.length).toBeGreaterThan(20)
    expect(placeDetails(b, all)).toEqual(first)
    expect(placeDetails(a, { ...all, dtSeed: 3 })).not.toEqual(first)
  })

  test("off places nothing, and each toggle removes only its own pieces", () => {
    const town = towns()[2]!
    expect(placeDetails(town, settings({ worldDetails: false }))).toEqual([])
    const base = placeDetails(town, all)
    const noMail = placeDetails(town, { ...all, dtMail: false })
    expect(noMail.some((d) => d.model === "mail")).toBe(false)
    expect(base.some((d) => d.model === "mail")).toBe(true)
    const noBins = placeDetails(town, { ...all, dtBins: false })
    expect(noBins.some((d) => d.model === "bins" || d.model === "binsBags" || d.model === "dumpster")).toBe(false)
    expect(placeDetails(town, { ...all, dtMarks: 0 }).some(onWall)).toBe(false)
    expect(placeDetails(town, { ...all, dtStreetJunk: 0 }).some((d) => d.model === "bike" || d.model === "pram" || d.model.startsWith("suitcase"))).toBe(false)
  })

  test("indoor pieces stand inside their building, off walls, doors and furniture", () => {
    for (const town of towns()) {
      for (const b of town.buildings) {
        const sites = placeBuildingDetails(town, b, all, true)
        expect(sites.length).toBeLessThanOrEqual(BUILDING_DETAIL_BUDGET)
        for (const d of sites.filter(indoor)) {
          expect(inBuildingFootprint(b, d.x, d.z)).toBe(true)
          for (const w of town.barriers) if (w.kind !== "fence") expect(distToRect(d.x, d.z, w.rect)).toBeGreaterThan(d.model.startsWith("boxes") || d.model === "tv" ? 0.25 : d.r)
          for (const p of town.props) {
            const s = propShape(p)
            if (s && p.kind !== "tree") expect(distToRect(d.x, d.z, s.rect)).toBeGreaterThan(d.r)
          }
          if (d.model !== "mail") for (const door of town.doors) expect(distToRect(d.x, d.z, door.rect)).toBeGreaterThan(d.r + 0.4)
        }
      }
    }
  })

  test("outdoor pieces keep off buildings, doorways and cars; marks sit on a bare stretch of the front wall", () => {
    for (const town of towns()) {
      for (const d of placeDetails(town, all)) {
        if (indoor(d)) continue
        if (onWall(d)) {
          const inner = town.doors.find((door) => door.id.endsWith("-room") && Math.abs(door.rect[3] + 0.014 - d.z) < 1e-6)
          if (inner) {
            // Indoors beside the inner door, clear of it.
            expect(d.x < inner.rect[0] - 0.3 || d.x > inner.rect[2] + 0.3).toBe(true)
            expect(town.buildings.some((o) => inBuildingFootprint(o, d.x, d.z + 0.3))).toBe(true)
            continue
          }
          const b = town.buildings.find((o) => Math.abs(o.rect[3] + 0.012 - d.z) < 1e-6 && d.x > o.rect[0] && d.x < o.rect[2])!
          expect(b).toBeDefined()
          expect(frontWallSpans(town, b).some((sp) => d.x > sp.a0 && d.x < sp.a1)).toBe(true)
          for (const door of town.doors) if (Math.abs(door.rect[3] - b.rect[3]) < 0.05) expect(d.x < door.rect[0] - 0.3 || d.x > door.rect[2] + 0.3).toBe(true)
          continue
        }
        if (d.model === "tape" || d.model === "tapeTail" || d.model === "cone") continue
        for (const b of town.buildings) expect(inBuildingFootprint(b, d.x, d.z)).toBe(false)
        for (const door of town.doors) expect(distToRect(d.x, d.z, door.rect)).toBeGreaterThan(1)
        for (const car of town.vehicles ?? []) expect(distToRect(d.x, d.z, car)).toBeGreaterThan(d.r)
      }
    }
  })

  test("homes get a mailbox and bins at the street; shops get a dumpster instead", () => {
    const town = towns()[2]!
    const sites = placeDetails(town, settings())
    const homes = town.buildings.filter(isHome)
    const shops = town.buildings.filter((b) => !isHome(b))
    expect(homes.length).toBeGreaterThan(0)
    expect(sites.filter((d) => d.model === "mailbox").length).toBeGreaterThan(0)
    expect(sites.filter((d) => d.model === "mailbox").length).toBeLessThanOrEqual(homes.length)
    expect(sites.filter((d) => d.model === "dumpster").length).toBeGreaterThan(0)
    expect(sites.filter((d) => d.model === "dumpster").length).toBeLessThanOrEqual(shops.length)
  })

  test("turned-over houses: a Blood incident always turns a house over, the share sets the rest", () => {
    const town = towns()[0]!
    const ash = town.buildings.find((b) => b.id === "ash")!
    const calm = placeBuildingDetails(town, ash, settings({ dtTurnedOver: 0 }), false)
    const hit = placeBuildingDetails(town, ash, settings({ dtTurnedOver: 0 }), true)
    expect(calm.some((d) => d.model === "chair")).toBe(false)
    expect(hit.some((d) => d.model === "chair" || d.model === "crockery" || d.model === "drawer")).toBe(true)
    // A toppled chair lies on its back or its side.
    for (const c of hit.filter((d) => d.model === "chair")) expect(Math.abs(c.roll) + Math.abs(c.pitch)).toBeCloseTo(Math.PI / 2, 5)
  })

  test("indoor warnings are written in blood (Today's spray one toggle away) and nothing else moves", () => {
    const town = towns()[0]!
    const ash = town.buildings.find((b) => b.id === "ash")!
    const seeds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    let found = 0
    for (const dtSeed of seeds) {
      const blood = placeBuildingDetails(town, ash, settings({ dtSeed }), true)
      const spray = placeBuildingDetails(town, ash, settings({ dtSeed, dtBloodWriting: false }), true)
      expect(blood.length).toBe(spray.length)
      blood.forEach((d, i) => {
        const o = spray[i]!
        if (d.model.startsWith("blood")) {
          found++
          expect(o.model.startsWith("word")).toBe(true)
          expect(d.z).toBeCloseTo(o.z, 6)
          expect(d.y - o.y).toBeCloseTo(0.22, 6)
        } else {
          expect(d).toEqual(o)
        }
      })
    }
    expect(found).toBeGreaterThan(0)
    // Every phrase is hand-drawn within its placement width, runs drip below the letters, and lies on the wall plane.
    const meshes = buildDetailMeshes()
    for (const w of BLOOD_WORDS) {
      const v = meshes[DETAIL_MODELS.indexOf(w.model)]!.v
      let minX = Infinity, maxX = -Infinity, minY = Infinity, minZ = Infinity, maxZ = -Infinity
      for (let i = 0; i < v.length; i += 11) {
        minX = Math.min(minX, v[i]!); maxX = Math.max(maxX, v[i]!); minY = Math.min(minY, v[i + 1]!)
        minZ = Math.min(minZ, v[i + 2]!); maxZ = Math.max(maxZ, v[i + 2]!)
      }
      const half = wordWidth(w.text, w.height) / 2
      expect(minX).toBeGreaterThan(-half * 1.12)
      expect(maxX).toBeLessThan(half * 1.12)
      expect(minY).toBeLessThan(-w.height * 0.2)
      expect(minZ).toBeGreaterThan(0.003)
      expect(maxZ).toBeLessThan(0.011)
    }
  })

  test("police cars get a ring of cones and tape; tape is cut into ~1 m segments", () => {
    const town = towns()[0]!
    const car = (town.vehicles ?? []).length ? town.vehicles![0]! : null
    const sites = placeCarDetails(town, settings({ dtStreetJunk: 0 }), [
      { key: "cruiser:" + (car ? `${((car[0] + car[2]) / 2).toFixed(1)},${((car[1] + car[3]) / 2).toFixed(1)}` : "12.2,46.3"), x: 0, z: 0, yaw: 0 },
    ])
    const cones = sites.filter((d) => d.model === "cone")
    expect(cones.length).toBeGreaterThanOrEqual(2)
    expect(cones.length).toBeLessThanOrEqual(4)
    for (const t of sites.filter((d) => d.model === "tape")) expect(t.scale).toBeGreaterThan(0.6)
    expect(placeCarDetails(town, settings({ dtPoliceTape: false, dtStreetJunk: 0 }), [{ key: "cruiser:12.2,46.3", x: 0, z: 0, yaw: 0 }])).toEqual([])
  })

  test("every model has a mesh and every setting is a Lab control in the Details groups", () => {
    const meshes = buildDetailMeshes()
    expect(meshes.length).toBe(DETAIL_MODELS.length)
    for (const m of meshes) expect(m.v.length).toBeGreaterThan(0)
    const keys = new Set(detailControls.map((c) => c.key))
    for (const k of Object.keys(DEFAULT_DETAIL_SETTINGS)) expect(keys.has(k)).toBe(true)
    for (const c of detailControls) expect(c.group?.startsWith("Details")).toBe(true)
    expect(getOutbreakSetting(createOutbreakSettings(), "dtMarks")).toBe(DEFAULT_DETAIL_SETTINGS.dtMarks)
  })
})
