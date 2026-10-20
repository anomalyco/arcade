import * as THREE from "three/webgpu"
import { materialFor } from "../../render/materials"
import { MODELS } from "../../render/models"
import type { Lamp } from "../context"
import { renderState } from "../../render/shared"
import { type Builder, CEIL_Y, DOOR_H, FLOOR_Y, M, PANEL_ON, PANEL_WARM, T, TUBE, flicker, fluorescentPanel, glow, louvre, paint, solidsOf, troffer } from "./kit"
import { placeModels } from "./props"

// Light fixtures: each builds its visible fixture AND (when on) registers its real lamp, so no emissive "on" surface
// exists without a light near it (building program rule). Intensities are calibrated to the current exposure:
// corridor troffer ≈ 4–6 cd, room troffer pair ≈ 12–16 cd, desk lamp ≈ 60 cd (shadowed hero lamps up to ~260).
// Positions are ground-floor coordinates (the builder lifts them). Lamps carry the storey's zone automatically.

export const WARM: [number, number, number] = [1.0, 0.68, 0.38]
export const INCANDESCENT: [number, number, number] = [1.0, 0.74, 0.46]

/** A downward troffer lamp just above a panel (`b.lamp(fluoro(...))`). */
export function fluoroLamp(x: number, z: number, intensity = 6, opts: { flicker?: number; warm?: boolean } = {}): Lamp {
  return {
    kind: "fluorescent",
    position: [x, CEIL_Y + 0.1, z],
    direction: [0, -1, 0],
    color: opts.warm ? [1.0, 0.86, 0.55] : TUBE,
    intensity,
    range: 7,
    angle: 1.3,
    penumbra: 0.7,
    size: 1.2,
    ...(opts.flicker ? { flicker: opts.flicker } : {}),
  }
}

export type TrofferCell = { x: number; z: number; on: boolean; flicker?: number }
export type TrofferOpts = { louvre?: boolean; warm?: boolean; /** cd per registered lamp. */ intensity?: number; /** registered lamp per N lit fittings (default 2). */ perLamp?: number }

/**
 * Recessed troffers at grid cells (x = 0.6k, z = 1.2k, long side along z). Lit fittings are grouped in runs of
 * `perLamp` (default 2: one lamp per lit pair, at their midpoint). Flickering fittings get their own animated panel and
 * lamp; `update(time)` on the returned handle keeps panel and light in step (call it from your storey's update).
 */
export function troffers(b: Builder, cells: readonly TrofferCell[], opts: TrofferOpts = {}) {
  const panel = opts.warm ? PANEL_WARM : PANEL_ON
  const per = opts.perLamp ?? 2
  const flick: { level: THREE.UniformNode<"float", number>; lamp: Lamp; seed: number; amount: number }[] = []
  const steady: TrofferCell[] = []
  // A troffer never straddles a wall: placed at flush (every wall of the storey known), cells whose 0.62 × 1.22 m
  // housing a wall runs through are dropped.
  b.defer(() => {
    const solids = solidsOf(b.ctx)
    const ceil = CEIL_Y + b.oy - 0.03
    const clear = (c: TrofferCell) =>
      !solids.some((k) => k.min[1] < ceil && k.max[1] > ceil && k.min[0] < c.x + 0.31 && k.max[0] > c.x - 0.31 && k.min[2] < c.z + 0.61 && k.max[2] > c.z - 0.61)
    const placed: TrofferCell[] = []
    const free = (c: TrofferCell) => clear(c) && !placed.some((q) => Math.abs(q.x - c.x) < 0.6 && Math.abs(q.z - c.z) < 1.2) && !cells.some((q) => q !== c && Math.abs(q.x - c.x) < 0.6 && Math.abs(q.z - c.z) < 1.2)
    for (const c0 of cells) {
      // Over a wall: move one grid step off it (along the tile's long side first), or drop it.
      let c: TrofferCell | undefined = c0
      if (!clear(c0)) c = [[0, 1.2], [0, -1.2], [0.6, 0], [-0.6, 0]].map(([dx, dz]) => ({ ...c0, x: c0.x + dx!, z: c0.z + dz! })).find(free)
      if ((globalThis as { __trofferLog?: boolean }).__trofferLog && c !== c0) console.warn(`troffer over a wall at ${c0.x}, ${c0.z} (storey ${b.storey}) → ${c ? `${c.x}, ${c.z}` : "dropped"}`)
      if (!c) continue
      placed.push(c)
      if (opts.louvre) louvre(b, c.x, c.z)
      if (!c.on) {
        troffer(b, c.x, c.z, "off", panel)
        continue
      }
      if (c.flicker) {
        const p = fluorescentPanel(1)
        troffer(b, c.x, c.z, { flicker: c.flicker, ...p }, panel)
        const lamp = b.lamp(fluoroLamp(c.x, c.z, (opts.intensity ?? 14) / 2, { flicker: c.flicker, warm: opts.warm }))
        flick.push({ level: p.level, lamp, seed: c.x * 7 + c.z * 13, amount: c.flicker })
        continue
      }
      troffer(b, c.x, c.z, "on", panel)
      steady.push(c)
    }
    for (let k = 0; k < steady.length; k += per) {
      const run = steady.slice(k, k + per)
      const x = run.reduce((s, c) => s + c.x, 0) / run.length
      const z = run.reduce((s, c) => s + c.z, 0) / run.length
      b.lamp(fluoroLamp(x, z, ((opts.intensity ?? 14) * run.length) / per, { warm: opts.warm }))
    }
  })
  return {
    update(time: number) {
      // The Lab's Flicker scale (0 = steady; also the hygiene sweep) applies to the panels, not only the lamps.
      const k = Number((b.ctx.settings as unknown as Record<string, unknown>)["light.flicker"] ?? 1)
      for (const f of flick) f.level.value = rigLevelOf(f.lamp) ?? flicker(time, f.seed, f.amount * k)
    },
  }
}

/** Troffer cells on the global grid inside a rect: every `dx` m across, `dz` m along, inset from the walls. */
export function trofferGrid(r: { x0: number; x1: number; z0: number; z1: number }, dx = 2.4, dz = 3.6, inset = 0.9) {
  const out: { x: number; z: number }[] = []
  const xa = Math.ceil((r.x0 + inset) / 0.6) * 0.6
  const za = Math.ceil((r.z0 + inset) / 1.2) * 1.2
  const nx = Math.max(1, Math.floor((r.x1 - inset - xa) / dx) + 1)
  const nz = Math.max(1, Math.floor((r.z1 - inset - za) / dz) + 1)
  // Centre the pattern in the room, snapped back to the grid.
  const sx = Math.round((((r.x0 + r.x1) / 2 - ((nx - 1) * dx) / 2) - 0) / 0.6) * 0.6
  const sz = Math.round(((r.z0 + r.z1) / 2 - ((nz - 1) * dz) / 2) / 1.2) * 1.2
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++) {
      const x = sx + i * dx
      const z = sz + j * dz
      if (x - 0.31 < r.x0 || x + 0.31 > r.x1 || z - 0.61 < r.z0 || z + 0.61 > r.z1) continue
      out.push({ x: +x.toFixed(3), z: +z.toFixed(3) })
    }
  return out
}

/** Sprung-arm desk lamp (library model) on a surface at (x, y, z) facing `yaw`; its spot hangs under the shade. */
export function deskLamp(b: Builder, x: number, y: number, z: number, yaw: number, on = true, opts: { intensity?: number; shadow?: boolean } = {}) {
  placeModels(b, "desk_lamp", [{ position: [x, y, z], yaw, collide: false, blob: 0 }])
  if (!on) return
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  const reach = MODELS.desk_lamp.size[2] * 0.42
  b.lamp({
    kind: "incandescent",
    position: [x + fx * reach, y + 0.4, z + fz * reach],
    direction: [fx * 0.53, -0.85, fz * 0.53],
    color: WARM,
    intensity: opts.intensity ?? 60,
    range: 5,
    angle: 1.0,
    penumbra: 0.8,
    shadow: opts.shadow ?? false,
    size: 0.08,
  })
}

const BRASS = paint(0x7a5a24, 0.35, 0.9)
const BANKER_GREEN = materialFor("flat", { color: 0x0c3a1e, roughness: 0.2, emissive: 0x0a2a12, intensity: 0.25, name: "interior_banker_shade" })

/** Banker's lamp (brass base, green glass shade) on a desk at (x, y, z), long axis along yaw. */
export function bankerLamp(b: Builder, x: number, y: number, z: number, yaw = 0, on = true) {
  const m = T(x, y, z, yaw)
  b.cyl(BRASS, m.clone().multiply(T(0, 0.012, 0)), 0.07, 0.08, 0.024, 20)
  b.cyl(BRASS, m.clone().multiply(T(0, 0.18, 0)), 0.008, 0.008, 0.33, 8)
  const shade = m.clone().multiply(T(0, 0.34, 0.06, 0, 0, Math.PI / 2))
  const g = new THREE.CylinderGeometry(0.07, 0.07, 0.3, 20, 1, true, 0, Math.PI)
  g.applyMatrix4(shade)
  b.add(BANKER_GREEN, g, { worldUV: false })
  if (on) {
    b.box(M.bulbWarm, x - 0.1, y + 0.31, z + 0.04, x + 0.1, y + 0.315, z + 0.08, { cast: false })
    b.lamp({ kind: "incandescent", position: [x, y + 0.3, z + 0.06], direction: [0, -1, 0], color: WARM, intensity: 18, range: 3.5, angle: 1.2, penumbra: 0.8, size: 0.05 })
  }
}

/** Ceiling pendant: cord, enamel cone shade, bulb, a downward spot (`shadow` hint for hero rooms). */
export function pendant(b: Builder, x: number, z: number, opts: { drop?: number; on?: boolean; shadow?: boolean; intensity?: number; /** Cone half-angle (rad, default 1.0) and range (m, default 7): an open shade spills wider. */ angle?: number; range?: number } = {}) {
  const drop = opts.drop ?? 0.9
  const y = CEIL_Y - drop
  b.rod(M.rubber, [x, CEIL_Y, z], [x, y + 0.16, z], 0.004, 4)
  b.cyl(M.darkSteel, T(x, CEIL_Y - 0.01, z), 0.05, 0.05, 0.02, 12)
  b.cyl(paint(0x2a3a30, 0.35, 0.2), T(x, y + 0.08, z), 0.04, 0.2, 0.16, 24, { open: true })
  b.cyl(paint(0xd8d4c4, 0.5), T(x, y + 0.081, z), 0.039, 0.198, 0.158, 24, { open: true, cast: false })
  if (opts.on ?? true) {
    const bulb = new THREE.SphereGeometry(0.04, 12, 8)
    bulb.translate(x, y + 0.02, z)
    b.add(M.bulbWarm, bulb, { cast: false })
    b.lamp({ kind: "incandescent", position: [x, y - 0.02, z], direction: [0, -1, 0], color: INCANDESCENT, intensity: opts.intensity ?? 40, range: opts.range ?? 7, angle: opts.angle ?? 1.0, penumbra: 0.6, shadow: opts.shadow ?? false, size: 0.08 })
  }
}

/** Caged bulkhead light on a wall at (x, y, z) with outward normal (nx, nz): steel body, glass dome, cage bars, and
 *  its lamp when on (stairwells, plant rooms, the freezer, the FL-1 lobby). */
export function bulkhead(b: Builder, x: number, y: number, z: number, nx: number, nz: number, on = true, opts: { warm?: boolean; intensity?: number; range?: number } = {}) {
  const m = T(x, y, z, Math.atan2(nx, nz))
  b.rbox(M.darkSteel, m, 0.3, 0.2, 0.06, 0.02, 0, 0, 0.03)
  b.cyl(on ? (opts.warm ? M.bulbWarm : M.bulbCool) : M.hazardOff, m.clone().multiply(T(0, 0, 0.08, 0, Math.PI / 2)), 0.085, 0.09, 0.06, 16, { cast: false })
  for (let k = -1; k <= 1; k++) b.boxM(M.darkSteel, m, 0.012, 0.2, 0.012, k * 0.06, 0, 0.12)
  b.boxM(M.darkSteel, m, 0.2, 0.012, 0.012, 0, 0, 0.12)
  if (on)
    b.lamp({
      kind: opts.warm ? "incandescent" : "fluorescent",
      position: [x + nx * 0.28, y - 0.05, z + nz * 0.28],
      direction: norm3(nx * 0.5, -0.8, nz * 0.5),
      color: opts.warm ? INCANDESCENT : TUBE,
      intensity: opts.intensity ?? 6,
      range: opts.range ?? 6,
      angle: 1.35,
      penumbra: 0.8,
      size: 0.18,
    })
}

const norm3 = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
}

/** Wall sconce (storey 4 directorate): brass backplate, frosted half-shade, warm uplight + spill. Mounted on a wall
 *  plane at (x, z) whose outward normal is (nx, nz) (axis-aligned). */
export function sconce(b: Builder, x: number, z: number, nx: number, nz: number, on = true) {
  const yaw = Math.atan2(nx, nz)
  const m = T(x, FLOOR_Y + 1.75, z, yaw)
  b.rbox(BRASS, m, 0.12, 0.2, 0.015, 0.005, 0, 0, 0.008)
  const g = new THREE.SphereGeometry(0.09, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)
  g.scale(1, 0.8, 0.8)
  g.applyMatrix4(m.clone().multiply(T(0, 0.02, 0.09, 0, Math.PI)))
  b.add(on ? glow(0x553a20, 0xffc890, 1.2, "sconce_glass") : M.paper, g, { worldUV: false, cast: false })
  // A spot aimed out of the wall (not an omni light): the clustered lights aren't occluded by walls, so an omni sconce
  // lit the room behind the wall.
  if (on) b.lamp({ kind: "incandescent", position: [x + nx * 0.18, FLOOR_Y + 1.8, z + nz * 0.18], direction: norm3(nx, 0.15, nz), color: INCANDESCENT, intensity: 8, range: 3.6, angle: 1.4, penumbra: 0.9, size: 0.08 })
}

/** Clamp halogen work light on a tripod stand, head aimed along yaw and tilted down `pitch`. */
export function clampWorkLight(b: Builder, x: number, z: number, yaw: number, opts: { on?: boolean; shadow?: boolean; height?: number; pitch?: number; intensity?: number } = {}) {
  const h = opts.height ?? 1.7
  const y = FLOOR_Y
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + yaw
    b.rod(M.darkSteel, [x + Math.cos(a) * 0.45, y, z + Math.sin(a) * 0.45], [x, y + 0.55, z], 0.012, 6)
  }
  b.rod(M.darkSteel, [x, y + 0.5, z], [x, y + h, z], 0.016, 8)
  const pitch = opts.pitch ?? 0.5
  const m = T(x, y + h + 0.08, z, yaw, -pitch)
  b.rbox(M.safety, m, 0.26, 0.2, 0.12, 0.015, 0, 0, 0)
  b.boxM(M.darkSteel, m, 0.3, 0.02, 0.02, 0, -0.11, 0.05)
  b.quad(glow(0x332a1a, 0xfff0d0, 6, "halogen"), m.clone().multiply(T(0, 0, -0.061, Math.PI)), 0.2, 0.14, { cast: false })
  b.rod(M.rubber, [x, y + h, z], [x + 0.3, y, z + 0.5], 0.006, 4)
  if (opts.on ?? true) {
    const d = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(-pitch, yaw, 0, "YXZ"))
    b.lamp({ kind: "incandescent", position: [x + d.x * 0.15, y + h + 0.08 + d.y * 0.15, z + d.z * 0.15], direction: [d.x, d.y, d.z], color: [1, 0.86, 0.66], intensity: opts.intensity ?? 120, range: 12, angle: 0.75, penumbra: 0.5, shadow: opts.shadow ?? false, size: 0.12 })
  }
}

/** Fluorescent task tube under an overhead bin or cabinet: diffuser strip + a short-range lamp. */
export function underBinTube(b: Builder, x0: number, x1: number, z: number, y: number, on = true) {
  b.box(M.housing, x0, y - 0.03, z - 0.04, x1, y, z + 0.04, { cast: false })
  b.box(on ? glow(0x202418, 0xe8f0c8, 1.6, "task_tube") : M.diffuserOff, x0 + 0.02, y - 0.032, z - 0.03, x1 - 0.02, y - 0.03, z + 0.03, { cast: false })
  if (on) b.lamp({ kind: "fluorescent", position: [(x0 + x1) / 2, y - 0.05, z], direction: [0, -1, 0], color: TUBE, intensity: 3, range: 2.5, angle: 1.4, penumbra: 0.8, size: 0.4 })
}

/** Glowing screen (CRT, scope, panel) as an emissive quad in frame `m` (facing local +Z); `lamp` adds a tiny light
 *  (hero screens only — most screens are emissive material alone). */
export function screen(b: Builder, m: THREE.Matrix4, w: number, h: number, colour: number, opts: { intensity?: number; lamp?: boolean; /** Own node material (CCTV feed, slide, static): drawn as an unmerged mesh with the quad's 0..1 UVs. Build such materials once and reuse them. */ material?: THREE.Material } = {}) {
  if (opts.material) {
    const g = new THREE.PlaneGeometry(w, h)
    g.applyMatrix4(m)
    b.mesh(opts.material, g)
  } else b.quad(glow(0x050605, colour, opts.intensity ?? 0.6, `screen_${colour.toString(16)}`), m, w, h, { cast: false })
  if (opts.lamp) {
    const p = new THREE.Vector3(0, 0, 0.3).applyMatrix4(m)
    const c = new THREE.Color(colour)
    b.lamp({ kind: "window", position: [p.x, p.y, p.z], color: [c.r, c.g, c.b], intensity: 0.8, range: 2.5, size: 0.2 })
  }
}

/** Twin-head battery emergency pack on a wall at (x, y, z) with outward normal (nx, nz); off unless `on` (power cuts). */
export function emergencyPack(b: Builder, x: number, y: number, z: number, nx: number, nz: number, on = false) {
  const m = T(x + nx * 0.06, y, z + nz * 0.06, Math.atan2(nx, nz))
  b.rbox(M.beige, m, 0.34, 0.16, 0.12, 0.015)
  for (const s of [-1, 1]) {
    const h = m.clone().multiply(T(s * 0.12, 0.12, 0.03, 0, -0.5))
    b.cyl(M.beige, h, 0.035, 0.045, 0.07, 12)
    b.cyl(on ? M.bulbWarm : M.diffuserOff, h.clone().multiply(T(0, 0.036, 0)), 0.03, 0.03, 0.005, 12, { cast: false })
  }
  if (on) b.lamp({ kind: "incandescent", position: [x + nx * 0.25, y + 0.1, z + nz * 0.25], direction: [nx * 0.6, -0.8, nz * 0.6], color: [1, 0.8, 0.55], intensity: 2.5, range: 6, angle: 0.8, penumbra: 0.6, size: 0.06 })
}

/** Exit sign over a door: box on the wall at (x, z) with outward normal (nx, nz), lamp included. */
export function exitSign(b: Builder, x: number, z: number, nx: number, nz: number, y = FLOOR_Y + DOOR_H + 0.38) {
  const m = T(x + nx * 0.05, y, z + nz * 0.05, Math.atan2(nx, nz))
  // Pressed-steel housing (painted cream, a 1980s fitting) with a face-panel lip around the red diffuser.
  b.boxM(M.beige, m, 0.6, 0.29, 0.1, 0, 0, 0)
  b.boxM(M.darkSteel, m, 0.58, 0.012, 0.012, 0, 0.115, 0.051, { cast: false })
  b.boxM(M.darkSteel, m, 0.58, 0.012, 0.012, 0, -0.115, 0.051, { cast: false })
  b.quad(M.exitSign, m.clone().multiply(T(0, 0, 0.053)), 0.54, 0.21, { cast: false })
  b.lamp({ kind: "exit", position: [x + nx * 0.2, y, z + nz * 0.2], color: [1, 0.08, 0.04], intensity: 0.6, range: 2, size: 0.18 })
}

/** Rotating-type warning beacon (halon, RF hazard, UV): coloured dome on a base, warning lamp (blinks via the rig). */
export function beacon(b: Builder, x: number, y: number, z: number, colour: "red" | "amber" | "violet", on = true, opts: { intensity?: number; range?: number } = {}) {
  const c = { red: [0xff2a12, [1, 0.12, 0.05]], amber: [0xffa018, [1, 0.55, 0.1]], violet: [0x9a40ff, [0.55, 0.25, 1]] }[colour] as [number, [number, number, number]]
  b.cyl(M.darkSteel, T(x, y, z), 0.06, 0.07, 0.04, 12)
  b.cyl(on ? glow(0x1a0804, c[0], 1.6, `beacon_${colour}`) : M.hazardOff, T(x, y + 0.08, z), 0.045, 0.05, 0.12, 12, { cast: false })
  if (on) b.lamp({ kind: "warning", position: [x, y + 0.1, z], color: c[1], intensity: opts.intensity ?? 1.2, range: opts.range ?? 3.5, size: 0.08 })
}

// Flicker coupling: follow the light rig's flicker when it drives the lamp, so panel and light stutter together.
const rigIndex = new Map<Lamp, number>()
export function rigLevelOf(lamp: Lamp): number | undefined {
  const list = renderState.lamps
  let i = rigIndex.get(lamp)
  if (i === undefined || list[i]?.lamp !== lamp) {
    i = list.findIndex((r) => r.lamp === lamp)
    if (i < 0) return undefined
    rigIndex.set(lamp, i)
  }
  return list[i]!.level
}
