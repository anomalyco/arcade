import { afterAll, describe, expect, test } from "bun:test"
import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { VERT_BYTES } from "@arcade/kit/gpu/mesh"
import { buildingFootprint, inBuildingFootprint, makeTown, type Building, type Town } from "../shared/map"
import { OUTER_WALL } from "../shared/houses/geometry"
import { HOUSE_CONDITIONS, HOUSE_FORMS } from "../shared/houses/style"
import { resetHouseVariety, setHouseVariety } from "../shared/houses/variety"
import { houseGroundRects } from "../shared/houses/plan"
import { TRAINING_HOUSE } from "../shared/onboarding/training"
import { generateWorldChunk, type WorldChunk } from "../shared/world"
import { plantFootprints } from "../src/architecture"
import { porchRects } from "../src/houses/exterior"
import { buildLevel } from "../src/level"
import { CUTAWAY_TOP, stemClearance } from "../src/vegetation/indoors"
import { compileSingleWorldChunk, ensurePropTemplates, lastChunkYardPlants, recycleCompiledChunk } from "../src/world-streamer"

/**
 * Kit, on Ash in the lobby's practice space: "Why are there trees inside the house? It's kind of fucked up." Indoors the
 * roof cutaway hides everything above the wall tops and nothing below them, so no yard leaf or limb may stand inside a
 * building below them, and no trunk or stem stands in a building, on its porch or in its garage or shed, or near one.
 */

afterAll(() => resetHouseVariety())

const toFloat = (h: number) => {
  const e = (h >> 10) & 31, f = h & 1023
  return (h >> 15 ? -1 : 1) * (e === 0 ? (f / 1024) * 2 ** -14 : 2 ** (e - 15) * (1 + f / 1024))
}

type Indoor = { building: string; x: number; y: number; z: number }

/** Inside a room: in the footprint and further in than its outer walls (a blade inside a wall is out of sight). */
const inRoom = (b: Building, x: number, z: number, wall = OUTER_WALL + 0.03) =>
  inBuildingFootprint(b, x, z) && inBuildingFootprint(b, x - wall, z) && inBuildingFootprint(b, x + wall, z) && inBuildingFootprint(b, x, z - wall) && inBuildingFootprint(b, x, z + wall)

type Chunk = { data: ArrayBuffer; byteLength?: number; cutBox?: readonly number[]; customCutaway?: unknown }

/** Whether the renderer skips (or cuts) a chunk while the camera stands anywhere in `b`. */
const hiddenInside = (c: Chunk, b: Building) =>
  (c.customCutaway === true || c.customCutaway === "outside") && !!c.cutBox && c.cutBox[0]! <= b.rect[0] && c.cutBox[2]! <= b.rect[1] && c.cutBox[3]! >= b.rect[2] && c.cutBox[5]! >= b.rect[3]

/**
 * Yard leaves and swaying limbs over a room that the camera would see from inside that house: below the wall tops in
 * any chunk, above them in a chunk not hidden with the house's roof.
 */
function seenIndoors(chunks: readonly Chunk[], buildings: readonly Building[]): Indoor[] {
  // Houseplants are plant()s too: their stems stand indoors on a stand. Leave them out.
  const houseplants = plantFootprints.filter((f) => f.ground > 0.3 || buildings.some((b) => inBuildingFootprint(b, f.x, f.z)))
  const found: Indoor[] = []
  for (const c of chunks) {
    const bytes = c.byteLength ?? c.data.byteLength
    const f32 = new Float32Array(c.data, 0, bytes / 4)
    const u16 = new Uint16Array(c.data, 0, bytes / 2)
    for (let v = 0; v < bytes / VERT_BYTES; v++) {
      const mat = Math.round(toFloat(u16[v * 12 + 10]!))
      if (mat !== 22 && !(mat === 24 && toFloat(u16[v * 12 + 11]!) >= 7.5)) continue
      const x = f32[v * 6]!, y = f32[v * 6 + 1]!, z = f32[v * 6 + 2]!
      const b = buildings.find((b) => inRoom(b, x, z))
      if (!b || (y > CUTAWAY_TOP && hiddenInside(c, b))) continue
      if (houseplants.some((p) => Math.hypot(x - p.x, z - p.z) < p.radius * 2 + 0.3)) continue
      found.push({ building: b.id, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2) })
    }
  }
  return found
}

/** A building's walls, porches, garage wing, outbuildings and yard things: no trunk or stem stands in or near them. */
function keepOuts(b: Building, town: Town): Rect[] {
  const out = [...buildingFootprint(b), ...houseGroundRects(b), ...porchRects(b, town)]
  // The origin bungalow's gabled porch (`houseFrontage`).
  if (!b.style && b.kind === "house") out.push([b.rect[0] + 4.14, b.rect[3], b.rect[0] + 7.26, b.rect[3] + 1.3])
  return out
}

function stemsTooClose(stems: readonly { x: number; z: number; h: number }[], buildings: readonly Building[], town: Town): string[] {
  const bad: string[] = []
  for (const s of stems) {
    for (const b of buildings) {
      for (const r of keepOuts(b, town)) {
        const d = distToRect(s.x, s.z, r)
        if (d < stemClearance(s.h) - 1e-6) bad.push(`${s.h > 2.1 ? "tree" : "shrub"} at ${s.x.toFixed(2)},${s.z.toFixed(2)} is ${d.toFixed(2)} m from ${b.id}`)
      }
    }
  }
  return bad
}

/** The buildings and doors of a chunk and the eight around it. */
function neighbourhood(seed: number, cx: number, cy: number): { buildings: Building[]; town: Town } {
  const town = makeTown(seed, seed, 0.22, 1)
  const buildings: Building[] = [], doors: Town["doors"] = []
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = generateWorldChunk(seed, seed, cx + dx, cy + dy, "streaming")
      buildings.push(...c.buildings)
      doors.push(...c.doors)
    }
  }
  return { buildings, town: { ...town, doors } }
}

describe("trees stay out of houses", () => {
  test("Ash and the origin block (the practice space and every run's start): no leaf indoors, no stem near a wall", () => {
    ensurePropTemplates()
    for (const seed of [7, 1, 2, 3, 11, 42, 99, 1234, 4242, 31337]) {
      const town = makeTown(seed, seed, 0.22, 1)
      const level = buildLevel(town)
      // Streaming another chunk replaces this shared scratch list. A cache hit must restore the origin's plants,
      // otherwise houseplants are mistaken for outdoor foliage and the stem checks inspect the wrong generation.
      const footprints = plantFootprints.map((f) => ({ ...f }))
      plantFootprints.length = 0
      expect(buildLevel(town)).toBe(level)
      expect(plantFootprints.length).toBeGreaterThan(40)
      expect(plantFootprints).toEqual(footprints)
      const indoor = seenIndoors(level.chunks, town.buildings)
      expect({ seed, indoor: indoor.slice(0, 5), count: indoor.length }).toEqual({ seed, indoor: [], count: 0 })
      expect(indoor.filter((p) => p.building === TRAINING_HOUSE)).toEqual([])
      const stems = plantFootprints.filter((f) => f.ground <= 0.3 && !town.buildings.some((b) => inBuildingFootprint(b, f.x, f.z))).map((f) => ({ x: f.x, z: f.z, h: f.tree ? 5 : 1 }))
      expect(stems.length).toBeGreaterThan(40)
      expect(stemsTooClose(stems, town.buildings, town)).toEqual([])
    }
  })

  test("generated trees keep clear of every streamed building, porch, garage and shed", () => {
    for (const seed of [7, 21, 1234]) {
      for (let cy = -9; cy <= 9; cy++) {
        for (let cx = -9; cx <= 9; cx++) {
          const chunk = generateWorldChunk(seed, seed, cx, cy, "streaming")
          const trees = chunk.props.filter((p) => p.kind === "tree").map((p) => ({ x: p.x, z: p.y, h: 5 }))
          if (!trees.length) continue
          const near = neighbourhood(seed, cx, cy)
          expect(stemsTooClose(trees, near.buildings, near.town)).toEqual([])
        }
      }
    }
  })

  /** Streamed chunks holding every house form and condition (styled), then Today's bungalows and shops. */
  function streamedChunks(seed: number, styled: boolean): WorldChunk[] {
    setHouseVariety({ enabled: styled })
    const want = new Set<string>(styled ? [...HOUSE_FORMS.map((f) => `form:${f}`), ...HOUSE_CONDITIONS.map((c) => `condition:${c}`)] : ["house", "poi"])
    const per = new Map<string, number>()
    const out: WorldChunk[] = []
    for (let ring = 3; ring <= 14 && [...want].some((k) => (per.get(k) ?? 0) < 2); ring++) {
      for (let cy = -ring; cy <= ring; cy++) {
        for (let cx = -ring; cx <= ring; cx++) {
          if (Math.max(Math.abs(cx), Math.abs(cy)) !== ring) continue
          const chunk = generateWorldChunk(seed, seed, cx, cy, "streaming")
          const keys = chunk.buildings.flatMap((b) => (b.style ? [`form:${b.style.form}`, `condition:${b.style.condition}`] : [b.kind === "house" ? "house" : "poi"]))
          if (!keys.some((k) => want.has(k) && (per.get(k) ?? 0) < 2)) continue
          for (const k of keys) per.set(k, (per.get(k) ?? 0) + 1)
          out.push(chunk)
        }
      }
    }
    for (const k of want) expect(per.get(k) ?? 0).toBeGreaterThan(0)
    return out
  }

  for (const styled of [true, false]) {
    test(`${styled ? "styled homes of every form and condition" : "Today's streamed bungalows and shops"}: no leaf indoors, no stem near a wall`, () => {
      ensurePropTemplates()
      for (const seed of [7, 21]) {
        for (const chunk of streamedChunks(seed, styled)) {
          const c = compileSingleWorldChunk(chunk, seed, seed, 0.22, 1)
          const near = neighbourhood(seed, chunk.cx, chunk.cy)
          const indoor = seenIndoors([...c.staticOpaqueChunks, ...(c.roofChunks ?? [])], near.buildings)
          expect({ chunk: chunk.key, indoor: indoor.slice(0, 5), count: indoor.length }).toEqual({ chunk: chunk.key, indoor: [], count: 0 })
          expect(stemsTooClose(lastChunkYardPlants(), near.buildings, near.town)).toEqual([])
          recycleCompiledChunk(c)
        }
      }
      resetHouseVariety()
    })
  }
})
