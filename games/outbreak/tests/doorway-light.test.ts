import { describe, expect, test } from "bun:test"
import { OCC_FLOATS, POLAR_RAYS } from "@arcade/kit/limits"
import { clearLine, type Rect } from "@arcade/kit/sim/geom"
import { CoopRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { sharedEdges } from "../shared/houses/geometry"
import { makeTown, sightRects, type Town } from "../shared/map"
import type { Command } from "../shared/session"
import { Vision } from "../shared/vision"
import { generateWorldChunk } from "../shared/world"
import { outbreakClientFeatures as features } from "../src/features"
import { MAX_OCCLUDERS } from "@arcade/kit/limits"
import { packLightOccluders } from "../src/light-occluders"
import { SoundOcclusion } from "../src/audio/space"
import { NetSession } from "../src/net-session"
import { createOutbreakSettings } from "../src/settings"
import { OutbreakSceneLevel } from "../src/world/scene-level"
import { Loopback } from "./loopback"

const TAU = Math.PI * 2
/** Lens height of a hand-held flashlight over flat ground (`frame-lighting.ts`). */
const LENS = 1.34

/**
 * CPU twin of the polar shadow pass (`polarShader` in `@arcade/kit/gpu/shaders`) for the full-height casters: how far
 * one of the light's RAYS rays travels before a caster at least as tall as the lens stops it.
 */
function polarFull(occ: Float32Array, count: number, ox: number, oy: number, ray: number, maxD: number): number {
  const ang = ((ray + 0.5) / POLAR_RAYS) * TAU
  const dx = Math.cos(ang)
  const dy = Math.sin(ang)
  let full = maxD + 0.5
  for (let i = 0; i < count; i++) {
    const o = i * OCC_FLOATS
    if (occ[o + 5]! > 0.5 || occ[o + 4]! < LENS - 0.02) continue
    let t0 = 0
    let t1 = 1e6
    const slab = (p: number, d: number, lo: number, hi: number) => {
      if (Math.abs(d) < 1e-9) return p >= lo && p <= hi
      let a = (lo - p) / d
      let b = (hi - p) / d
      if (a > b) [a, b] = [b, a]
      t0 = Math.max(t0, a)
      t1 = Math.min(t1, b)
      return t0 <= t1
    }
    if (slab(ox, dx, occ[o]!, occ[o + 2]!) && slab(oy, dy, occ[o + 1]!, occ[o + 3]!) && t0 < full) full = t0
  }
  return full
}

/** Flashlight visibility of a ground point, interpolated between the two nearest polar rays like `lensVis`. */
function lightReaches(occ: Float32Array, count: number, ox: number, oy: number, px: number, py: number): number {
  const d = Math.hypot(px - ox, py - oy)
  let a = Math.atan2(py - oy, px - ox)
  if (a < 0) a += TAU
  const f = (a / TAU) * POLAR_RAYS - 0.5
  const lo = Math.floor(f)
  const vis = (i: number) => (d >= polarFull(occ, count, ox, oy, ((i % POLAR_RAYS) + POLAR_RAYS) % POLAR_RAYS, 30) + 0.03 ? 0 : 1)
  return vis(lo) + (vis(lo + 1) - vis(lo)) * (f - lo)
}

type Opening = { id: string; axis: "x" | "z"; at: number; a0: number; a1: number }

/** Every doorway (doors open) and archway (gaps left in a styled home's partitions) in a town. */
function openings(town: Town): Opening[] {
  const out: Opening[] = town.doors.map((d) => ({ id: d.id, axis: "x", at: (d.rect[1] + d.rect[3]) / 2, a0: d.rect[0], a1: d.rect[2] }))
  const walls = town.barriers.filter((w) => w.kind === "wall").map((w) => w.rect)
  for (const b of town.buildings) {
    for (const s of b.style ? sharedEdges(b.style.rooms) : []) {
      if (s.axis !== "z") continue
      const covered = (a: number) => walls.some((w) => a >= w[1] && a <= w[3] && s.at >= w[0] && s.at <= w[2])
      let start = -1
      for (let a = s.a0 + 0.025; a <= s.a1 + 0.025; a += 0.05) {
        const open = a <= s.a1 && !covered(a)
        if (open && start < 0) start = a
        if (!open && start >= 0) {
          if (a - start > 0.6) out.push({ id: `${b.id}-arch@${s.at}`, axis: "z", at: s.at, a0: start, a1: a })
          start = -1
        }
      }
    }
  }
  return out
}

/**
 * For each opening, from 1.6 m back on either side, every ground point 1.2–3 m past it that a straight line through the
 * opening reaches must be lit by the flashlight and in sight. Returns the openings where either disagrees.
 */
function blockedOpenings(town: Town): string[] {
  for (const d of town.doors) d.open = true
  const blockers = sightRects(town)
  const occ = new Float32Array(MAX_OCCLUDERS * OCC_FLOATS)
  const { count } = packLightOccluders(town, blockers, occ, MAX_OCCLUDERS - 4)
  const tall: Rect[] = []
  for (let i = 0; i < count; i++) if (occ[i * OCC_FLOATS + 4]! >= LENS - 0.02) tall.push([occ[i * OCC_FLOATS]!, occ[i * OCC_FLOATS + 1]!, occ[i * OCC_FLOATS + 2]!, occ[i * OCC_FLOATS + 3]!])
  const vision = new Vision()
  const bad: string[] = []
  const cache = new Map<readonly Rect[], Rect[]>()
  const grown = (rs: readonly Rect[]) => {
    let g = cache.get(rs)
    if (!g) cache.set(rs, (g = rs.map((r): Rect => [r[0] - 0.06, r[1] - 0.06, r[2] + 0.06, r[3] + 0.06])))
    return g
  }
  for (const o of openings(town)) {
    const c = (o.a0 + o.a1) / 2
    const half = (o.a1 - o.a0) / 2
    const at = (along: number, off: number): [number, number] => (o.axis === "x" ? [along, o.at + off] : [o.at + off, along])
    for (const side of [-1, 1]) {
      const [ex, ey] = at(c, side * 1.6)
      for (const lat of [-0.5, 0, 0.5]) {
        for (const dist of [1.2, 2, 3]) {
          const [tx, ty] = at(c + (lat * half * (1.6 + dist)) / 1.6, -side * dist)
          // Points on a wall face or off past a wall end are not the opening's business.
          if (blockers.some((r) => tx > r[0] - 0.1 && tx < r[2] + 0.1 && ty > r[1] - 0.1 && ty < r[3] + 0.1)) continue
          // Lines that graze a jamb within the polar rays' spacing are a coin toss in both, so keep 6 cm clear.
          if (!clearLine(ex, ey, tx, ty, grown(blockers))) continue
          if (clearLine(ex, ey, tx, ty, grown(tall)) && lightReaches(occ, count, ex, ey, tx, ty) < 0.5) bad.push(`${o.id} light ${ex.toFixed(2)},${ey.toFixed(2)} -> ${tx.toFixed(2)},${ty.toFixed(2)}`)
          vision.update(ex, ey, Math.atan2(ty - ey, tx - ex), blockers, { range: 27, cone: 110, awareness: 2.5 }, null, null, false)
          if (!vision.visible(tx, ty)) bad.push(`${o.id} sight ${ex.toFixed(2)},${ey.toFixed(2)} -> ${tx.toFixed(2)},${ty.toFixed(2)}`)
        }
      }
    }
  }
  return [...new Set(bad)]
}

function townOf(seed: number, cx: number, cy: number): Town {
  const town = makeTown(seed)
  town.chunks = []
  town.buildings = []
  town.barriers = []
  town.doors = []
  town.windows = []
  town.props = []
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ch = generateWorldChunk(seed, seed, cx + dx, cy + dy, "streaming")
      town.chunks.push(ch.bounds)
      town.buildings.push(...ch.buildings)
      town.barriers.push(...ch.barriers)
      town.doors.push(...ch.doors.map((d) => ({ ...d })))
      town.windows.push(...ch.windows)
      town.props.push(...ch.props)
    }
  }
  return town
}

const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })

describe("light and sight through doorways", () => {
  test("every open doorway and archway passes the flashlight and sight, across house forms and seeds", () => {
    const forms = new Set<string>()
    let checked = 0
    const bad: string[] = [...blockedOpenings(makeTown(7))]
    for (const seed of [7, 21, 1234]) {
      for (const [cx, cy] of [[-4, -4], [5, -4], [-4, 5], [6, 6], [-7, 2], [3, -7]] as const) {
        const town = townOf(seed, cx, cy)
        for (const b of town.buildings) if (b.style) forms.add(b.style.form)
        checked += openings(town).length
        bad.push(...blockedOpenings(town))
      }
    }
    expect(checked).toBeGreaterThan(300)
    expect(forms.size).toBeGreaterThanOrEqual(7)
    expect(bad, bad.join("\n")).toHaveLength(0)
  })

  test("a door the co-op player opens stops casting light and sight shadows (optimistic toggle)", () => {
    let virtualMs = 0
    const core = new CoopRoomCore("glitch", { ...DEFAULT_COOP_ROOM, zombieCount: 0 }, () => virtualMs, BUILD)
    const net = new Loopback(core, 4, 0)
    const a = new NetSession({ features, url: "loop", room: "glitch", name: "Ann", now: () => net.now, WebSocket: net.socketClass() })
    const settings = createOutbreakSettings()
    const stub = { addModel: () => 0, setVisibility() {}, setLevel() {}, clearVisibilityField() {} }
    const level = new OutbreakSceneLevel({
      renderer: stub as never,
      combatFx: { setLevel() {} } as never,
      settings,
      cam: { groundRect: () => [0, 0, 96, 96] } as never,
      session: () => a,
    })
    const frame = () =>
      level.stepFrame({
        drawn: { x: a.view.player.x, y: a.view.player.y },
        activePeek: null,
        visionPeek: null,
        view: [0, 0, 96, 96],
        watch: null,
        localVehicle: undefined,
        drivingHeadlights: false,
        effectiveVisionAim: -Math.PI / 2,
        lowBeam: { range: 12, cone: 50 } as never,
      })
    const tick = (cmd: Command) => {
      virtualMs = net.now * 1000
      net.step()
      a.update(TICK_DT, cmd)
      a.sync(TICK_DT)
      frame()
    }
    for (let i = 0; i < 12; i++) tick(idle())
    const srv = core.sim.slot(a.id)!
    Object.assign(srv.survivor, { x: 27.7, y: 36.3, aim: -Math.PI / 2 })
    Object.assign(a.local.survivor, { x: 27.7, y: 36.3, aim: -Math.PI / 2 })
    core.sim.rebuildSolids()
    a.sim.rebuildSolids()
    for (let i = 0; i < 10; i++) tick(idle(-Math.PI / 2))
    const door = a.sim.town.doors.find((d) => d.id === "ash-front")!
    expect(door.open).toBe(false)
    expect(level.blockers).toContain(door.rect)
    const occlusion = new SoundOcclusion()
    const cx = (door.rect[0] + door.rect[2]) / 2
    const through = () => occlusion.query(cx, door.rect[3] + 1.4, cx, door.rect[1] - 1.5)
    occlusion.sync(a.sim.town, a.view.revision)
    expect(through()).toBeGreaterThan(0)

    tick({ ...idle(-Math.PI / 2), interact: true })
    for (let i = 0; i < 24; i++) tick(idle(-Math.PI / 2))
    expect(door.open).toBe(true)
    expect(core.sim.town.doors.find((d) => d.id === "ash-front")!.open).toBe(true)
    // The drawn door is open, so the light and the sight cone must go through it.
    expect(level.blockers).not.toContain(door.rect)
    // Everything keyed on the topology revision (sound occlusion here) hears the open door too.
    occlusion.sync(a.sim.town, a.view.revision)
    expect(through()).toBe(0)
    expect(lightReaches(level.occluders, level.lightOccluders, cx, door.rect[3] + 1.4, cx, door.rect[1] - 1.5)).toBe(1)
    expect(level.vision.visible(cx, door.rect[1] - 1.5)).toBe(true)
  })
})
