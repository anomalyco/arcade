import { emitGrassClump, emitGrassTuft, foliageSettings, scatterGrassClumps } from "@arcade/kit/gpu/foliage"
import { MAT, type Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import type { Rect } from "@arcade/kit/sim/geom"
import { Rng, seedOf } from "@arcade/kit/sim/rng"
import type { HouseStyle, YardItem } from "../../shared/houses/style"
import type { Building, Town } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import { macroLocalCoord } from "../../shared/world"
import { gardenShed } from "../architecture"
import { porchRects } from "./exterior"

/**
 * A styled home's grounds (AR-79): the detached garage or carport, the fences the generic mesher leaves to their owner
 * (chain-link, hedge, split rail), the yard things `planHouse` placed, and the front path, driveway and lawn. All of it
 * stands on the ground and never cuts away, so it goes straight into the chunk's opaque mesh.
 */

const hex = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
const shade = (c: Rgb, k: number): Rgb => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)]

/** Whether a point is in a street corridor (with its sidewalks). */
export function inStreet(x: number, z: number): boolean {
  const lx = macroLocalCoord(x), lz = macroLocalCoord(z)
  return (lx > 37.8 && lx < 50.2) || (lz > 37.8 && lz < 50.2)
}

/** How far south from z the street begins (to 9 m), so paths and driveways run out to the sidewalk. */
function toStreet(x: number, z: number): number {
  for (let d = 0; d < 9; d += 0.25) if (inStreet(x, z + d)) return d
  return 2
}

/** Ground quad with the floor material `aux` (2 paving, 3 gravel, 6 path). */
function pad(m: Mesh, r: Rect, y: number, col: Rgb, aux: number): void {
  m.quad([r[0], y, r[3]], [r[2], y, r[3]], [r[2], y, r[1]], [r[0], y, r[1]], [0, 1, 0], col, MAT.ground, aux)
}

/** Rotates the vertices emitted since `from` by `yaw` about (cx, cz). */
function yawFrom(m: Mesh, from: number, cx: number, cz: number, yaw: number): void {
  if (!yaw) return
  const c = Math.cos(yaw), s = Math.sin(yaw)
  for (let i = from; i < m.v.length; i += 11) {
    const x = m.v[i]! - cx, z = m.v[i + 2]! - cz, nx = m.v[i + 3]!, nz = m.v[i + 5]!
    m.v[i] = cx + x * c - z * s
    m.v[i + 2] = cz + x * s + z * c
    m.v[i + 3] = nx * c - nz * s
    m.v[i + 5] = nx * s + nz * c
  }
}

/** Rects the yard planting and lawn keep off: outbuilding, yard things, porches, paths and driveway. */
export function groundKeepOut(b: Building, town: Town): Rect[] {
  const s = b.style
  if (!s) return []
  const out: Rect[] = [...s.yard.map((y) => y.rect), ...porchRects(b, town)]
  if (s.outbuilding) out.push(s.outbuilding)
  for (const d of town.doors) {
    if (!d.id.startsWith(`${b.id}-front`)) continue
    const cx = (d.rect[0] + d.rect[2]) / 2
    out.push([cx - 0.75, d.rect[3], cx + 0.75, d.rect[3] + toStreet(cx, d.rect[3]) + 0.3])
  }
  out.push(driveway(b))
  return out
}

const driveway = (b: Building): Rect => [b.rect[0] - 3.2, b.rect[1] - 0.5, b.rect[0] - 0.2, b.rect[3] + toStreet(b.rect[0] - 1.7, b.rect[3])]

export function emitStyledGrounds(m: Mesh, b: Building, town: Town): void {
  const s = b.style!
  const rng = new Rng((seedOf(b.id) ^ 0x6a09e667 ^ Math.imul(town.houseSeed + 1, 0x85ebca6b)) >>> 0)
  const g = (x: number, z: number) => supportHeight(town, x, z)

  // Front paths from each front door, the driveway, and the stoop-side lawn.
  for (const d of town.doors) {
    if (!d.id.startsWith(`${b.id}-front`)) continue
    const cx = (d.rect[0] + d.rect[2]) / 2, z0 = d.rect[3]
    const len = toStreet(cx, z0)
    if (s.form === "corner_store") pad(m, [cx - 1.6, z0, cx + 1.6, z0 + len], 0.04, hex(0x74706a), 2)
    else {
      // Stepping slabs on a derelict lot, a poured path otherwise.
      if (s.condition === "derelict") for (let z = z0 + 0.6; z < z0 + len - 0.3; z += 0.75) pad(m, [cx - 0.35 + (rng.next() - 0.5) * 0.12, z, cx + 0.35, z + 0.5], 0.035, hex(0x6a665c), 6)
      else pad(m, [cx - 0.6, z0, cx + 0.6, z0 + len], 0.035, hex(0x6e6658), 6)
    }
  }
  const dw = driveway(b)
  pad(m, dw, 0.03, s.condition === "kept" && rng.next() < 0.4 ? hex(0x6c6a64) : hex(0x66625a), s.condition === "kept" ? 2 : 3)

  // Outbuilding.
  if (s.outbuilding) {
    const [x0, z0, x1, z1] = s.outbuilding
    const y = g((x0 + x1) / 2, (z0 + z1) / 2)
    const wall = shade(hex(b.color), 0.9), trim = hex(s.trim), roof = hex(s.roofColor)
    if (s.garage === "carport") {
      const post = hex(0x4e5052)
      for (const [x, z] of [[x0 + 0.1, z0 + 0.1], [x1 - 0.1, z0 + 0.1], [x0 + 0.1, z1 - 0.1], [x1 - 0.1, z1 - 0.1]]) m.box(x - 0.05, y, z - 0.05, x + 0.05, y + 2.32, z + 0.05, post, MAT.shiny)
      m.box(x0 - 0.15, y + 2.32, z0 - 0.15, x1 + 0.15, y + 2.4, z1 + 0.15, hex(0x7c807e), MAT.lit, 0, hex(0x8a8e8c))
      for (let x = x0; x < x1; x += 0.3) m.box(x, y + 2.4, z0 - 0.15, x + 0.04, y + 2.43, z1 + 0.15, hex(0x6c706e), MAT.lit)
      pad(m, s.outbuilding, 0.045, hex(0x74716a), 2)
    } else {
      // Detached garage: walls, an up-and-over door to the street, gable roof along z.
      m.box(x0, y, z0, x1, y + 2.5, z1, wall, MAT.timber)
      const cx = (x0 + x1) / 2, w = Math.min(2.5, x1 - x0 - 0.5)
      m.box(cx - w / 2 - 0.1, y + 0.02, z1, cx + w / 2 + 0.1, y + 2.18, z1 + 0.03, trim, MAT.lit)
      const door = s.condition === "derelict" ? hex(0x7a766a) : hex(0xa8a496)
      m.box(cx - w / 2, y + 0.04, z1 + 0.03, cx + w / 2, y + 2.1, z1 + 0.06, door, MAT.lit)
      for (let yy = 0.55; yy < 2.05; yy += 0.5) m.box(cx - w / 2 + 0.05, y + yy, z1 + 0.06, cx + w / 2 - 0.05, y + yy + 0.03, z1 + 0.07, shade(door, 0.72), MAT.lit)
      const o = 0.25, mid = cx, ridge = y + 2.5 + (x1 - x0) * 0.32
      m.quadAuto([x0 - o, y + 2.42, z1 + o], [mid, ridge, z1 + o], [mid, ridge, z0 - o], [x0 - o, y + 2.42, z0 - o], roof, MAT.lit)
      m.quadAuto([x1 + o, y + 2.42, z0 - o], [mid, ridge, z0 - o], [mid, ridge, z1 + o], [x1 + o, y + 2.42, z1 + o], shade(roof, 0.92), MAT.lit)
      m.facet([x0, y + 2.5, z1], [x1, y + 2.5, z1], [mid, ridge - 0.04, z1], wall, MAT.timber)
      m.facet([x1, y + 2.5, z0], [x0, y + 2.5, z0], [mid, ridge - 0.04, z0], wall, MAT.timber)
      pad(m, [cx - w / 2 - 0.2, z1, cx + w / 2 + 0.2, z1 + 1.2], 0.04, hex(0x74716a), 2)
    }
  }

  // Fences the plan left to their owner.
  if (s.fence === "chainlink" || s.fence === "hedge" || s.fence === "rail") {
    for (const bar of town.barriers) {
      if (!bar.hidden || bar.kind !== "fence") continue
      if (s.yard.some((y) => overlaps(y.rect, bar.rect))) continue
      emitFence(m, bar.rect, s.fence, rng, g)
    }
  }

  for (const item of s.yard) emitYardItem(m, item, s, rng, g)
}

const overlaps = (a: Rect, b: Rect) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

function emitFence(m: Mesh, r: Rect, kind: "chainlink" | "hedge" | "rail", rng: Rng, g: (x: number, z: number) => number): void {
  const alongX = r[2] - r[0] >= r[3] - r[1]
  const a0 = alongX ? r[0] : r[1], a1 = alongX ? r[2] : r[3]
  const c = alongX ? (r[1] + r[3]) / 2 : (r[0] + r[2]) / 2
  const at = (u: number): [number, number] => (alongX ? [u, c] : [c, u])
  if (kind === "hedge") {
    const greens = [0x1e2818, 0x223020, 0x1a2414, 0x26301c]
    for (let u = a0; u < a1; ) {
      const w = 0.6 + rng.next() * 0.5, u1 = Math.min(a1, u + w)
      const [x, z] = at((u + u1) / 2), y = g(x, z)
      const h = 1.15 + rng.next() * 0.35, half = (u1 - u) / 2 + 0.08, depth = 0.38 + rng.next() * 0.1
      const col = hex(greens[Math.floor(rng.next() * greens.length)]!)
      if (alongX) m.bevelBox(x - half, y, z - depth, x + half, y + h, z + depth, 0.16, col, shade(col, 1.25), MAT.lit)
      else m.bevelBox(x - depth, y, z - half, x + depth, y + h, z + half, 0.16, col, shade(col, 1.25), MAT.lit)
      u = u1
    }
    return
  }
  const post = kind === "rail" ? hex(0x4e3c2a) : hex(0x5e6264), wire = hex(0x4a4e50)
  const span = kind === "rail" ? 2.6 : 2.4
  const n = Math.max(1, Math.round((a1 - a0) / span))
  for (let k = 0; k <= n; k++) {
    const [x, z] = at(a0 + ((a1 - a0) * k) / n), y = g(x, z)
    if (kind === "rail") m.box(x - 0.07, y, z - 0.07, x + 0.07, y + 1.15, z + 0.07, post, MAT.timber)
    else m.prism(x, z, 0.04, 0.04, y, y + 1.28, 6, post, MAT.shiny)
  }
  const [mx, mz] = at((a0 + a1) / 2), y = g(mx, mz)
  const line = (h: number, t: number, col: Rgb) => {
    if (alongX) m.box(a0, y + h - t, c - t, a1, y + h + t, c + t, col, kind === "rail" ? MAT.timber : MAT.shiny)
    else m.box(c - t, y + h - t, a0, c + t, y + h + t, a1, col, kind === "rail" ? MAT.timber : MAT.shiny)
  }
  if (kind === "rail") {
    line(0.45, 0.05, hex(0x5a4632))
    line(0.95, 0.05, hex(0x5a4632))
  } else {
    // Top rail and the mesh read as close horizontal wires with a few verticals.
    line(1.25, 0.022, post)
    for (let h = 0.1; h < 1.2; h += 0.16) line(h, 0.006, wire)
    for (let u = a0 + 0.3; u < a1; u += 0.3) {
      const [x, z] = at(u)
      m.box(x - 0.006, y + 0.05, z - 0.006, x + 0.006, y + 1.24, z + 0.006, wire, MAT.shiny)
    }
  }
}

function emitYardItem(m: Mesh, it: YardItem, s: HouseStyle, rng: Rng, g: (x: number, z: number) => number): void {
  const [x0, z0, x1, z1] = it.rect
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, y = g(cx, cz)
  const from = m.v.length
  const steel = hex(0x5c6062), rust = hex(0x6a4a34)
  switch (it.kind) {
    case "shed":
      gardenShed(m, x0, z0, x1, z1, y)
      break
    case "swing": {
      for (const x of [x0 + 0.1, x1 - 0.1]) {
        m.quadAuto([x - 0.03, y, z0], [x + 0.03, y, z0], [x + 0.03, y + 2.1, cz], [x - 0.03, y + 2.1, cz], steel, MAT.shiny)
        m.quadAuto([x + 0.03, y, z1], [x - 0.03, y, z1], [x - 0.03, y + 2.1, cz], [x + 0.03, y + 2.1, cz], steel, MAT.shiny)
      }
      m.box(x0 + 0.05, y + 2.06, cz - 0.04, x1 - 0.05, y + 2.14, cz + 0.04, steel, MAT.shiny)
      const seats = s.condition === "kept" ? [cx - 0.6, cx + 0.6] : [cx - 0.6]
      for (const sx of seats) {
        for (const dx of [-0.2, 0.2]) m.box(sx + dx - 0.006, y + 0.45, cz - 0.006, sx + dx + 0.006, y + 2.06, cz + 0.006, hex(0x3a3a38), MAT.lit)
        m.box(sx - 0.24, y + 0.42, cz - 0.1, sx + 0.24, y + 0.47, cz + 0.1, hex(0x2c3a46), MAT.lit)
      }
      break
    }
    case "garden": {
      const frame = hex(0x4e3c2a), soil = hex(0x2a221a)
      m.box(x0, y, z0, x1, y + 0.28, z1, frame, MAT.timber, 0, soil)
      const alive = s.condition === "kept" && s.household !== "ransacked"
      for (let x = x0 + 0.25; x < x1 - 0.1; x += 0.4) {
        for (let z = z0 + 0.25; z < z1 - 0.1; z += 0.45) {
          if (rng.next() < 0.25) continue
          const h = alive ? 0.25 + rng.next() * 0.3 : 0.12 + rng.next() * 0.2
          m.prism(x, z, 0.12, 0.03, y + 0.28, y + 0.28 + h, 5, alive ? hex(rng.pick([0x2c3a20, 0x34421e, 0x283418])) : hex(0x4a4430), MAT.lit)
        }
      }
      // Bean poles.
      if (alive) for (const x of [x0 + 0.3, x1 - 0.3]) m.box(x - 0.015, y + 0.28, cz - 0.015, x + 0.015, y + 1.5, cz + 0.015, frame, MAT.timber)
      break
    }
    case "pool": {
      // An above-ground pool gone green.
      const r = Math.min(x1 - x0, z1 - z0) / 2 - 0.05
      m.prism(cx, cz, r, r, y, y + 1.05, 14, s.condition === "kept" ? hex(0x6a7a80) : hex(0x5a5c56), MAT.lit, 0, false)
      m.prism(cx, cz, r - 0.03, r - 0.03, y + 0.85, y + 0.86, 14, s.condition === "kept" ? hex(0x23332e) : hex(0x262a1a), MAT.lit)
      m.prism(cx, cz, r + 0.06, r + 0.06, y + 1.02, y + 1.09, 14, hex(0x8a8e8a), MAT.lit, 0, false)
      m.box(x1 - 0.1, y, cz - 0.3, x1 + 0.45, y + 1.15, cz + 0.3, steel, MAT.shiny)
      break
    }
    case "junk_car": {
      // A rusted car up on blocks, no wheels.
      const paint = hex(rng.pick([0x5a4a3a, 0x4a4e44, 0x6a5a48, 0x3e4448]))
      for (const [dx, dz] of [[-0.7, -1.3], [0.7, -1.3], [-0.7, 1.3], [0.7, 1.3]]) m.box(cx + dx - 0.18, y, cz + dz - 0.12, cx + dx + 0.18, y + 0.3, cz + dz + 0.12, hex(0x6a665e), MAT.lit)
      m.bevelBox(cx - 0.86, y + 0.3, cz - 2.05, cx + 0.86, y + 0.85, cz + 2.05, 0.06, paint, shade(paint, 1.1))
      m.box(cx - 0.5, y + 0.851, cz - 1.6, cx + 0.3, y + 0.86, cz - 0.9, rust, MAT.lit)
      m.bevelBox(cx - 0.72, y + 0.85, cz - 0.6, cx + 0.72, y + 1.32, cz + 1.0, 0.05, shade(paint, 0.95), shade(paint, 1.05))
      m.box(cx - 0.73, y + 0.95, cz - 0.5, cx + 0.73, y + 1.25, cz + 0.9, hex(0x15171a), MAT.lit)
      m.box(cx - 0.6, y + 0.86, cz - 2.06, cx - 0.1, y + 0.9, cz - 1.0, rust, MAT.lit)
      break
    }
    case "woodpile": {
      const wood = [0x5a4430, 0x6a5038, 0x4e3a28]
      for (let row = 0; row < 4; row++) {
        for (let x = x0 + 0.08; x < x1 - 0.08; x += 0.18) {
          if (row === 3 && rng.next() < 0.4) continue
          m.prism(x, cz, 0.08, 0.08, y + row * 0.15, y + row * 0.15 + 0.01, 6, hex(0x2a2018), MAT.lit)
          m.box(x - 0.08, y + row * 0.15, z0 + 0.05, x + 0.08, y + row * 0.15 + 0.15, z1 - 0.05, hex(wood[Math.floor(rng.next() * 3)]!), MAT.timber)
        }
      }
      break
    }
    case "clothesline": {
      for (const x of [x0 + 0.05, x1 - 0.05]) {
        m.box(x - 0.04, y, cz - 0.04, x + 0.04, y + 1.9, cz + 0.04, steel, MAT.shiny)
        m.box(x - 0.04, y + 1.82, z0, x + 0.04, y + 1.88, z1, steel, MAT.shiny)
      }
      for (const z of [z0 + 0.04, z1 - 0.04]) m.box(x0 + 0.05, y + 1.84, z - 0.004, x1 - 0.05, y + 1.85, z + 0.004, hex(0x9a968a), MAT.lit)
      const cloths = [0x8a8270, 0x6a5a4a, 0x5a6670, 0x8a7a64, 0x704a40]
      for (let x = x0 + 0.4; x < x1 - 0.4; x += 0.5 + rng.next() * 0.3) {
        if (s.condition !== "kept" && rng.next() < 0.5) continue
        const h = 0.4 + rng.next() * 0.35, w = 0.3 + rng.next() * 0.2
        m.box(x, y + 1.84 - h, z0 + 0.03, x + w, y + 1.84, z0 + 0.05, hex(cloths[Math.floor(rng.next() * cloths.length)]!), MAT.lit)
      }
      break
    }
    case "tyres": {
      for (let k = 0; k < 3 + Math.floor(rng.next() * 3); k++) {
        const tx = cx + (k < 3 ? 0 : (rng.next() - 0.5) * 0.6), tz = cz + (k < 3 ? 0 : 0.5), ty = y + (k < 3 ? k * 0.2 : 0)
        m.prism(tx, tz, 0.34, 0.34, ty, ty + 0.2, 10, hex(0x1a1a18), MAT.lit, 0, false)
        m.prism(tx, tz, 0.16, 0.16, ty + 0.2, ty + 0.201, 10, hex(0x0c0c0b), MAT.lit)
      }
      break
    }
    case "trampoline": {
      const r = Math.min(x1 - x0, z1 - z0) / 2 - 0.05
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2
        m.box(cx + Math.cos(a) * r - 0.03, y, cz + Math.sin(a) * r - 0.03, cx + Math.cos(a) * r + 0.03, y + 0.85, cz + Math.sin(a) * r + 0.03, steel, MAT.shiny)
      }
      m.prism(cx, cz, r + 0.05, r + 0.05, y + 0.8, y + 0.88, 14, hex(0x2a4a5a), MAT.lit, 0, false)
      m.prism(cx, cz, r - 0.15, r - 0.15, y + 0.83, y + 0.84, 14, hex(0x141414), MAT.lit)
      break
    }
  }
  if (it.kind !== "shed") yawFrom(m, from, cx, cz, it.yaw)
}

/** Lawn tufts in front of a styled home and along its sides, off the paths, porches and yard things. */
export function emitStyledLawn(at: (x: number, z: number) => Mesh, b: Building, town: Town, seed: number, avoid: (x: number, z: number) => boolean): void {
  const [x0, z0, x1, z1] = b.rect
  const front = toStreet((x0 + x1) / 2, z1)
  const rng = new Rng(seed ^ 0x2545f491)
  const patches: Rect[] = [
    [x0 - 0.2, z1 + 0.5, x1 + 0.5, z1 + front - 0.1],
    [x1 + 0.4, z0 + 0.4, x1 + 3.2, z1],
  ]
  const lush = b.style?.condition === "derelict" ? 2 : 1
  patches.forEach((p, k) => {
    if (p[2] - p[0] < 0.5 || p[3] - p[1] < 0.5) return
    const clumps = scatterGrassClumps({
      seed: (seed ^ Math.imul(k + 1, 0x632be5ab)) >>> 0,
      bounds: p,
      clusterCount: Math.max(2, Math.round(((p[2] - p[0]) * (p[3] - p[1]) * 0.35 * lush) * (town.foliageDensity ?? 1))),
      tuftsPerCluster: 3,
      params: foliageSettings,
      avoid,
    })
    for (const t of clumps) {
      const y = supportHeight(town, t.x, t.z), m = at(t.x, t.z)
      if (t.weed) {
        emitGrassClump(m, t, y, rng)
        continue
      }
      emitGrassTuft(m, t.x, y, t.z, { bladeCount: 3, radius: t.radius, height: t.height * (lush > 1 ? 1.5 : 1), width: t.width * 0.9, curvature: t.curvature, leanAngle: t.leanAngle, rootColor: t.rootColor, tipColor: t.tipColor, rng })
    }
  })
}
