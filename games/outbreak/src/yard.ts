import { MAT, type Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { emitGrassClump, emitGrassTuft, foliageSettings, scatterGrassClumps } from "@arcade/kit/gpu/foliage"
import { Rng } from "@arcade/kit/sim/rng"
import { frontageEnd, type Building, type Prop, type Town } from "../shared/map"
import { supportHeight } from "../shared/terrain"

/**
 * Lot grass and gravel shared by the authored origin build (`level.ts`) and streamed chunks (`world-streamer.ts`),
 * so a streamed lot is dressed by the same rules as Ash and Elm. `at` picks the mesh a tuft at (x, z) belongs to.
 */
type At = (x: number, z: number) => Mesh
type Avoid = (x: number, z: number) => boolean

const hex = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]

/**
 * Dense front-lawn and side-yard grass clumps either side of the walkway and beside the driveway and east wall.
 * `east` caps the east yard (the origin's sidewalk at x = 38); `west` floors the west yard.
 */
export function emitLawnPatches(at: At, b: Building, bIdx: number, town: Town, rng: Rng, opts: { hero: boolean; seed: number; west: number; east: number; avoid: Avoid }): void {
  const [bx0, bz0, bx1, bz1] = b.rect
  const sidewalkZ = frontageEnd(b) - 0.08
  const { hero, east, avoid } = opts
  const lawnPatches: readonly [number, number, number, number, number][] = [
    [bx0 + 0.20, bz1 + 0.72, bx0 + 4.90, sidewalkZ, hero ? 32 : 14],
    [bx0 + 6.50, bz1 + 0.72, Math.min(east, bx1 - 0.20), sidewalkZ, hero ? 36 : 16],
    [Math.max(opts.west, bx0 - 7.5), bz0 + 0.5, bx0 - 3.15, sidewalkZ, hero ? 20 : 12],
    [bx1 + 0.35, bz0 + 0.5, Math.min(east, bx1 + 3.2), sidewalkZ, hero ? 14 : 10],
  ]
  for (const [pIdx, [lx0, lz0, lx1, lz1, count]] of lawnPatches.entries()) {
    if (lz1 <= lz0 + 0.2 || lx1 <= lx0 + 0.2 || avoid(lx0, lz0 + 0.5)) continue
    const patchClumps = scatterGrassClumps({
      seed: (opts.seed ^ (bIdx * 4099 + pIdx * 613)) >>> 0,
      bounds: [lx0, lz0, lx1, lz1],
      clusterCount: Math.max(2, Math.round(count * (town.foliageDensity ?? 1))),
      tuftsPerCluster: 3,
      params: foliageSettings,
      avoid,
    })
    for (const t of patchClumps) {
      const y = supportHeight(town, t.x, t.z), m = at(t.x, t.z)
      if (t.weed) { emitGrassClump(m, t, y, rng); continue }
      emitGrassTuft(m, t.x, y, t.z, {
        bladeCount: 3,
        radius: t.radius * 0.96,
        height: t.height * 0.90,
        width: t.width * 0.86,
        curvature: t.curvature,
        leanAngle: t.leanAngle,
        rootColor: t.rootColor,
        tipColor: t.tipColor,
        rng,
      })
    }
  }
}

/** Shadowed root-collar tussock tufts around a street or yard tree. */
export function emitTreeCollar(at: At, p: Prop, town: Town, rng: Rng, avoid: Avoid): void {
  const collarCount = Math.max(3, Math.round(5 * (town.foliageDensity ?? 1)))
  for (let c = 0; c < collarCount; c++) {
    const a = c * 2.39996 + rng.next() * 0.45
    const d = 0.42 + rng.next() * 1.15
    const tx = p.x + Math.cos(a) * d
    const tz = p.y + Math.sin(a) * d
    if (avoid(tx, tz)) continue
    const y = supportHeight(town, tx, tz), m = at(tx, tz)
    emitGrassTuft(m, tx, y, tz, {
      bladeCount: 3,
      radius: 0.14 + rng.next() * 0.08,
      height: foliageSettings.bladeHeight * (0.85 + rng.next() * 0.35),
      width: foliageSettings.bladeWidth * 0.95,
      curvature: foliageSettings.bladeCurvature,
      leanAngle: a + (rng.next() - 0.5) * 0.5,
      rootColor: [foliageSettings.rootColorR * 0.85, foliageSettings.rootColorG * 0.85, foliageSettings.rootColorB * 0.85],
      tipColor: [foliageSettings.tipColorR * 1.02, foliageSettings.tipColorG * 1.02, foliageSettings.tipColorB * 0.95],
      rng,
    })
  }
}

/** Tufts lining both edges of the front walkway and the gravel driveway's edges and centre strip. */
export function emitPathTufts(at: At, b: Building, town: Town, rng: Rng): void {
  const [bx0, bz0, , bz1] = b.rect
  const walkEnd = frontageEnd(b) - 0.12
  for (let wz = bz1 + 1.05; wz < walkEnd; wz += 0.54 + rng.next() * 0.42) {
    for (const wx of [bx0 + 4.88, bx0 + 6.52]) {
      const gx = wx + (rng.next() - 0.5) * 0.14
      const gz = wz + (rng.next() - 0.5) * 0.18
      const y = supportHeight(town, gx, gz)
      emitGrassTuft(at(gx, gz), gx, y, gz, {
        bladeCount: 3,
        radius: 0.16 + rng.next() * 0.05,
        height: (0.14 + rng.next() * 0.10) * (foliageSettings.bladeHeight / 0.20),
        width: foliageSettings.bladeWidth * 0.92,
        curvature: foliageSettings.bladeCurvature,
        leanAngle: wx < bx0 + 5.5 ? 0.12 : Math.PI - 0.12,
        rootColor: hex(0x1c1e12),
        tipColor: hex(0x3e3c24),
        rng,
      })
    }
  }
  for (let dz = bz0 + 1.2; dz < walkEnd; dz += 0.78 + rng.next() * 0.58) {
    for (const dx of [bx0 - 2.94, bx0 - 1.68, bx0 - 0.42]) {
      if (dx === bx0 - 1.68 && rng.next() < 0.42) continue
      const gx = dx + (rng.next() - 0.5) * 0.18
      const gz = dz + (rng.next() - 0.5) * 0.22
      const y = supportHeight(town, gx, gz)
      emitGrassTuft(at(gx, gz), gx, y, gz, {
        bladeCount: 2,
        radius: 0.13,
        height: 0.12 + rng.next() * 0.09,
        width: foliageSettings.bladeWidth * 0.88,
        curvature: foliageSettings.bladeCurvature,
        leanAngle: rng.next() * Math.PI * 2,
        rootColor: hex(0x1a1c10),
        tipColor: hex(0x3a3822),
        rng,
      })
    }
  }
}

/** Loose gravel stones scattered over the driveway strip west of the building. */
export function emitGravelDriveway(m: Mesh, b: Building, seed: number): void {
  const [x, z] = b.rect
  const gravel = new Rng(seed)
  for (let k = 0; k < 36; k++) {
    const px = x - 3 + gravel.next() * 2.65, pz = z + gravel.next() * (frontageEnd(b) + 2 - z), size = .025 + gravel.next() * .045
    m.prism(px, pz, size, size * .5, .036, .055, 5, hex(gravel.pick([0x949084, 0x65685f, 0x79776a, 0x585a50])), MAT.lit)
  }
}

/**
 * Radiating rosette grass & weed tussocks along an east-west street's verges and sidewalk borders, every ~0.9 m from
 * `v0` to `v1`. `rows` are the z of each run and whether it is the raised curb strip; `gap` leaves street crossings
 * bare and `blocked` keeps walkway and driveway mouths clear.
 */
export function emitStreetVerge(at: At, town: Town, rng: Rng, v0: number, v1: number, rows: readonly (readonly [number, boolean])[], gap: (v: number) => boolean, blocked: (v: number) => boolean): void {
  for (let v = v0; v < v1; v += 0.64 + rng.next() * 0.58) {
    if (gap(v)) continue
    for (const [zBase, inCurbStrip] of rows) {
      if (rng.next() < 0.14) continue
      if (blocked(v)) continue
      const x = v + (rng.next() - 0.5) * 0.30
      const z = zBase + (rng.next() - 0.5) * 0.14
      const y = inCurbStrip ? 0.10 : supportHeight(town, x, z)
      const m = at(x, z)
      const h = (inCurbStrip ? 0.16 + rng.next() * 0.12 : 0.13 + rng.next() * 0.11) * (foliageSettings.bladeHeight / 0.20)
      const rootCol = hex(rng.pick([0x1c1e12, 0x181a10, 0x222214]))
      const tipCol = hex(rng.pick([0x3e3c24, 0x484226, 0x343820]))
      emitGrassTuft(m, x, y, z, {
        bladeCount: inCurbStrip ? 4 : 3,
        radius: inCurbStrip ? 0.18 + rng.next() * 0.06 : 0.15 + rng.next() * 0.05,
        height: h,
        width: foliageSettings.bladeWidth * 0.96,
        curvature: Math.min(1.0, foliageSettings.bladeCurvature * 1.15),
        leanAngle: rng.next() * Math.PI * 2,
        rootColor: rootCol,
        tipColor: tipCol,
        rng,
      })
    }
  }
}
