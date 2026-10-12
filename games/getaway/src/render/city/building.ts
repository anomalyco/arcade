import { CELL, ROAD_HALF } from "../../../shared/config"
import { type Box, GROUND_FLOOR } from "../../../shared/sim/city"
import type { AtlasRegion } from "../atlas"
import { MAT, type Mesh, type Rgb } from "../mesh"
import { beam, cylinder, jitter, mix, shade, SKIP, slab, Wall } from "./kit"
import type { LampLight } from "./types"

const ROOF: Rgb = [0.2, 0.22, 0.28]
const ROOF_TRIM: Rgb = [0.33, 0.32, 0.32]
const ROOFS: Rgb[] = [
  [0.24, 0.23, 0.24],
  [0.27, 0.25, 0.24],
  [0.21, 0.21, 0.23],
  [0.28, 0.26, 0.23],
  [0.24, 0.24, 0.25],
]
const STONE: Rgb = [0.44, 0.41, 0.37]
const DARK_STONE: Rgb = [0.3, 0.3, 0.33]
const GLASS: Rgb = [0.09, 0.11, 0.16]
const DARK_PANE: Rgb = [0.05, 0.06, 0.09]
const FRAME: Rgb = [0.14, 0.13, 0.13]
const DOOR: Rgb = [0.2, 0.13, 0.1]
const METAL: Rgb = [0.27, 0.28, 0.3]
const LIT: Rgb[] = [
  [1.0, 0.62, 0.28],
  [1.0, 0.66, 0.32],
  [0.95, 0.55, 0.22],
  [1.0, 0.72, 0.4],
  [0.9, 0.58, 0.3],
  [1.0, 0.68, 0.36],
]
const SHOP_LIT: Rgb[] = [
  [1.0, 0.62, 0.3],
  [0.95, 0.56, 0.26],
  [0.9, 0.66, 0.42],
]
const AWNINGS: Rgb[] = [
  [0.3, 0.1, 0.1],
  [0.1, 0.2, 0.17],
  [0.12, 0.14, 0.24],
  [0.32, 0.23, 0.11],
  [0.24, 0.1, 0.13],
]
const SHOP_SIGNS: AtlasRegion[] = ["diner", "liquor", "pawn", "cafe", "pharmacy", "laundry", "pizza"]

export type BuildingCtx = {
  m: Mesh
  rng: () => number
  lamps: LampLight[]
  /** Other buildings touching this one, for blank party walls. */
  touching: Box[]
  sidewalk: number
  /** Art assigned to this building by the district: a vertical blade sign, a billboard, painted lettering. */
  blade: AtlasRegion | null
  billboard: AtlasRegion | null
  lettering: boolean
}

type Face = {
  side: 0 | 1 | 2 | 3
  wall: Wall
  street: boolean
  /** Height up to which a neighbor hides this face (0 = fully exposed). */
  covered: number
  /** The camera never sees +x / +z faces head-on, so they get flush windows. */
  detail: boolean
}

/** One city building: facade with real recessed windows, shopfronts, cornice, parapet and roof clutter. */
export function building(ctx: BuildingCtx, b: Box) {
  const { m, rng } = ctx
  const { x0, x1, z0, z1, h } = b
  const floors = Math.max(1, b.floors ?? Math.round((h - GROUND_FLOOR) / 3.4))
  const storey = (h - GROUND_FLOOR) / floors
  const g = GROUND_FLOOR
  const body = jitter(b.color, rng, 0.05)
  const brick = body[0] > body[2] * 1.25
  const trim: Rgb = brick ? mix(STONE, body, 0.25) : shade(body, 0.72)
  const special = b.label
  // Facade rhythm for this building.
  const bay = 3.0 + rng() * 0.9
  const winW = 0.95 + rng() * 0.3
  const winH = Math.min(storey - 1.1, 1.9 + rng() * 0.3)
  const sill = 0.85 + (storey - 3.4) * 0.3
  const litRatio = 0.42 + rng() * 0.33
  const paired = rng() < 0.3 && bay > 4
  const courses = rng() < 0.55

  const faces: Face[] = ([0, 1, 2, 3] as const).map((side) => {
    const wall = Wall.of(x0, x1, z0, z1, side)
    const street = isStreet(side, x0, x1, z0, z1, ctx.sidewalk)
    let covered = 0
    for (const o of ctx.touching) {
      const touch =
        side === 0 ? Math.abs(o.z1 - z0) < 0.3 : side === 1 ? Math.abs(o.z0 - z1) < 0.3 : side === 2 ? Math.abs(o.x1 - x0) < 0.3 : Math.abs(o.x0 - x1) < 0.3
      if (!touch) continue
      const overlap = side < 2 ? Math.min(o.x1, x1) - Math.max(o.x0, x0) : Math.min(o.z1, z1) - Math.max(o.z0, z0)
      if (overlap > wall.w * 0.5) covered = Math.max(covered, o.h)
    }
    return { side, wall, street, covered, detail: side === 0 || side === 2 }
  })

  // Plinth.
  slab(m, x0 - 0.12, x1 + 0.12, 0, 0.55, z0 - 0.12, z1 + 0.12, shade(trim, 0.7))

  for (const f of faces) {
    if (f.covered >= h - 0.5) continue
    const W = f.wall
    const w = W.w
    const y0 = Math.max(0.55, f.covered)
    if (f.covered > 0.5) {
      // Blank party wall above the neighbor, the classic spot for painted ads.
      W.rect(m, 0, w, y0, h, 0, shade(body, 0.92))
      if (f.detail && ctx.lettering && h - y0 > 4 && w > 9) {
        const lw = Math.min(w - 2, (h - y0 - 1) * 3.2)
        const lh = lw / 3.2
        const yy = y0 + (h - y0 - lh) / 2
        W.decal(m, (w - lw) / 2, (w + lw) / 2, yy, yy + lh, 0.03, "riverdale", [0.5, 0.48, 0.47], MAT.decal)
        ctx.lettering = false
      } else if (f.detail && ctx.billboard && h - y0 > 6 && w > 8) {
        const bw2 = Math.min(w - 2, (h - y0 - 1.5) * 0.8)
        billboardOn(ctx, W, (w - bw2) / 2, (w + bw2) / 2, y0 + 0.8, y0 + 0.8 + bw2 * 1.25, ctx.billboard)
        ctx.billboard = null
      }
      continue
    }
    const margin = 0.9
    const nb = Math.max(1, Math.floor((w - margin * 2) / bay))
    const bw = (w - margin * 2) / nb
    // Billboard on a street face: the bays it covers stay blank.
    let board: [number, number] | null = null
    if (f.detail && f.street && ctx.billboard && w > 11 && floors >= 2) {
      const bwid = Math.min(w * 0.5, 8, (h - g - 1.6) / 1.25)
      const u0 = w - margin - bwid - 0.4
      board = [u0, u0 + bwid]
    }
    // Painted district lettering: the upper floors of this face stay blank.
    const letter = !board && f.detail && ctx.lettering && w > 9 && floors >= 2
    if (letter) ctx.lettering = false
    const blocked = (u0: number, u1: number) => letter || (board !== null && u1 > board[0] - 0.3 && u0 < board[1] + 0.3)

    // Ground floor.
    const shop = f.street && !special && rng() < 0.75
    if (special) groundSpecial(ctx, f, b, body, trim)
    else if (shop) shopfront(ctx, f, g, trim, body)
    else groundPlain(ctx, f, g, body, trim, bw, nb, margin, winW, winH)

    // Upper floors.
    const darkFloor = Math.floor(rng() * (floors + 3))
    for (let fl = 0; fl < floors; fl++) {
      const fy = g + fl * storey
      const wy0 = fy + sill
      const wy1 = wy0 + winH
      const holes: [number, number][] = []
      for (let k = 0; k < nb; k++) {
        const c = margin + bw * (k + 0.5)
        if (paired) {
          const ww = winW * 0.8
          holes.push([c - ww - 0.15, c - 0.15], [c + 0.15, c + ww + 0.15])
        } else holes.push([c - winW / 2, c + winW / 2])
      }
      const open = holes.filter(([a, b2]) => !blocked(a, b2))
      if (courses && fl > 0 && f.detail) W.ledge(m, 0.55, w - 0.55, fy - 0.08, fy + 0.1, 0.07, shade(trim, 0.9))
      // Wall strips around the window band.
      W.rect(m, 0, w, fy, wy0, 0, body)
      W.rect(m, 0, w, wy1, fy + storey, 0, body)
      if (!f.detail) {
        W.rect(m, 0, w, wy0, wy1, 0, body)
        for (const [a, b2] of open) {
          const lit = fl !== darkFloor && rng() < litRatio
          W.rect(m, a, b2, wy0, wy1, 0.03, lit ? shade(LIT[Math.floor(rng() * LIT.length)]!, 0.7 + rng() * 0.3) : GLASS, lit ? MAT.emissive : MAT.glass)
        }
        continue
      }
      let u = 0
      for (const [a, b2] of open) {
        W.rect(m, u, a, wy0, wy1, 0, body)
        u = b2
      }
      W.rect(m, u, w, wy0, wy1, 0, body)
      for (const [a, b2] of open) {
        const lit = fl !== darkFloor && rng() < litRatio
        window(ctx, W, a, b2, wy0, wy1, body, trim, lit)
      }
    }

    if (letter) {
      const top = h - 0.9
      const lw = Math.min(w - 2, (top - g - 0.6) * 3.2)
      const lh = lw / 3.2
      const yy = g + 0.3 + (top - g - 0.3 - lh) / 2
      W.decal(m, (w - lw) / 2, (w + lw) / 2, yy, yy + lh, 0.03, "riverdale", shade(body, 1.35), MAT.decal)
    }
    // Fire escape on some brick side streets: landings at every floor and zigzag stairs.
    if (brick && f.detail && !board && !letter && floors >= 2 && nb >= 3 && rng() < 0.35) {
      const k = 1 + Math.floor(rng() * (nb - 2))
      fireEscape(ctx, W, margin + bw * k - 0.2, margin + bw * (k + 1) + 0.2, g, storey, floors, sill)
    }
    if (board && ctx.billboard) {
      billboardOn(ctx, W, board[0], board[1], g + 0.8, g + 0.8 + (board[1] - board[0]) * 1.25, ctx.billboard)
      ctx.billboard = null
    }
    // Blades read best on south faces (their letters then face the camera side-on), so prefer those.
    const southStreet = faces.some((o) => o.side === 0 && o.street && o.covered < h - 0.5)
    if (ctx.blade && f.detail && f.street && floors >= 2 && (f.side === 0 || !southStreet)) {
      bladeSign(ctx, W, Math.min(2.4, w * 0.2), g + 0.4, Math.min(h - 0.8, g + 0.4 + 7.5), ctx.blade, ctx.blade === "hotel" ? [0.2, 0.4, 1] : b.neon ?? [0.25, 0.45, 1])
      ctx.blade = null
    }
  }

  // Belt course above the ground floor and corner pilasters.
  slab(m, x0 - 0.14, x1 + 0.14, g - 0.35, g, z0 - 0.14, z1 + 0.14, trim)
  const pw = 0.55
  for (const cx of [x0, x1])
    for (const cz of [z0, z1]) {
      const [ax, bx] = cx === x0 ? [cx - 0.12, cx + pw] : [cx - pw, cx + 0.12]
      const [az, bz] = cz === z0 ? [cz - 0.12, cz + pw] : [cz - pw, cz + 0.12]
      slab(m, ax, bx, 0.55, h - 0.4, az, bz, brick ? shade(body, 0.85) : shade(trim, 1.05), MAT.lit, SKIP.bottom | SKIP.top)
    }

  // Cornice: a chunky overhang band, then the parapet with a coping.
  const co = 0.45
  slab(m, x0 - co, x1 + co, h - 0.7, h - 0.15, z0 - co, z1 + co, trim, MAT.lit, 0, ROOF_TRIM)
  const roofTone = ROOFS[Math.floor(rng() * ROOFS.length)]!
  slab(m, x0 - 0.22, x1 + 0.22, h - 0.15, h + 0.05, z0 - 0.22, z1 + 0.22, shade(trim, 0.8), MAT.lit, SKIP.bottom, roofTone)
  const pt = 0.35
  const ph = h + 0.95
  const pc = shade(body, 0.8)
  slab(m, x0, x1, h, ph, z0, z0 + pt, pc, MAT.lit, SKIP.bottom, ROOF_TRIM)
  slab(m, x0, x1, h, ph, z1 - pt, z1, pc, MAT.lit, SKIP.bottom, ROOF_TRIM)
  slab(m, x0, x0 + pt, h, ph, z0 + pt, z1 - pt, pc, MAT.lit, SKIP.bottom | SKIP.nz | SKIP.pz, ROOF_TRIM)
  slab(m, x1 - pt, x1, h, ph, z0 + pt, z1 - pt, pc, MAT.lit, SKIP.bottom | SKIP.nz | SKIP.pz, ROOF_TRIM)
  // Coping: lighter cap course.
  slab(m, x0 - 0.06, x1 + 0.06, ph, ph + 0.14, z0 - 0.06, z0 + pt + 0.06, ROOF_TRIM, MAT.lit, SKIP.bottom | SKIP.px | SKIP.nx)
  slab(m, x0 - 0.06, x1 + 0.06, ph, ph + 0.14, z1 - pt - 0.06, z1 + 0.06, ROOF_TRIM, MAT.lit, SKIP.bottom | SKIP.px | SKIP.nx)

  if (b.label === "PRECINCT") {
    precinctRoof(ctx, x0 + pt, x1 - pt, z0 + pt, z1 - pt, h + 0.05)
    return
  }
  const w = x1 - x0
  const d = z1 - z0
  if (floors >= 3 && w > 12 && d > 12 && rng() < 0.45) {
    // Penthouse storey set back from the street faces, toward the rear (+x, +z) so it never hides a facade.
    const px0 = x0 + 3 + rng() * 2
    const pz0 = z0 + 3 + rng() * 2
    const px1 = x1 - pt
    const pz1 = z1 - pt
    roof(ctx, x0 + pt, x1 - pt, z0 + pt, pz0 - 0.4, h + 0.05, roofTone)
    roof(ctx, x0 + pt, px0 - 0.4, pz0, z1 - pt, h + 0.05, roofTone)
    const ph2 = h + storey
    slab(m, px0, px1, h, ph2, pz0, pz1, shade(body, 0.9), MAT.lit, SKIP.bottom, roofTone)
    for (const side of [0, 2] as const) {
      const W = Wall.of(px0, px1, pz0, pz1, side)
      const nb = Math.max(1, Math.floor((W.w - 1.6) / bay))
      const bw = (W.w - 1.6) / nb
      for (let k = 0; k < nb; k++) {
        const c = 0.8 + bw * (k + 0.5)
        const lit = rng() < litRatio
        W.rect(m, c - winW / 2, c + winW / 2, h + sill, h + sill + winH, 0.03, lit ? shade(LIT[Math.floor(rng() * LIT.length)]!, 0.8) : GLASS, lit ? MAT.emissive : MAT.glass)
        W.ledge(m, c - winW / 2 - 0.1, c + winW / 2 + 0.1, h + sill - 0.12, h + sill, 0.12, trim)
      }
    }
    slab(m, px0 - 0.25, px1 + 0.1, ph2 - 0.1, ph2 + 0.5, pz0 - 0.25, pz1 + 0.1, trim, MAT.lit, 0, ROOF_TRIM)
    roof(ctx, px0 + 0.3, px1 - 0.3, pz0 + 0.3, pz1 - 0.3, ph2 + 0.5, roofTone)
    return
  }
  roof(ctx, x0 + pt, x1 - pt, z0 + pt, z1 - pt, h + 0.05, roofTone)
}

function isStreet(side: number, x0: number, x1: number, z0: number, z1: number, sidewalk: number) {
  const near = (v: number, edge: number) => Math.abs(v - edge) < sidewalk + 0.8
  if (side === 0) return near(z0, Math.floor(z0 / CELL) * CELL + ROAD_HALF)
  if (side === 1) return near(z1, Math.ceil(z1 / CELL) * CELL - ROAD_HALF)
  if (side === 2) return near(x0, Math.floor(x0 / CELL) * CELL + ROAD_HALF)
  return near(x1, Math.ceil(x1 / CELL) * CELL - ROAD_HALF)
}

/** Recessed window: reveal, pane (lit or dark glass), stone sill and lintel, a mullion cross on lit panes. */
function window(ctx: BuildingCtx, W: Wall, a: number, b: number, y0: number, y1: number, body: Rgb, trim: Rgb, lit: boolean) {
  const { m, rng } = ctx
  const r = 0.24
  W.reveal(m, a, b, y0, y1, r, shade(body, 0.8), trim)
  if (lit) {
    const c = shade(LIT[Math.floor(rng() * LIT.length)]!, 0.66 + rng() * 0.3)
    // Lower pane brighter than the top (a drawn blind or the lamp inside).
    const split = y0 + (y1 - y0) * (0.55 + rng() * 0.2)
    W.rect(m, a, b, y0, split, -r, c, MAT.emissive)
    W.rect(m, a, b, split, y1, -r, shade(c, 0.72), MAT.emissive)
    const mid = (a + b) / 2
    W.rect(m, mid - 0.045, mid + 0.045, y0, y1, -r + 0.02, FRAME)
    W.rect(m, a, b, split - 0.04, split + 0.04, -r + 0.02, FRAME)
  } else {
    // Unlit rooms read as dark navy holes; glass here would catch the moon and turn pale.
    W.rect(m, a, b, y0, y1, -r, DARK_PANE, MAT.lit)
    const mid = (a + b) / 2
    W.rect(m, mid - 0.04, mid + 0.04, y0, y1, -r + 0.02, FRAME)
  }
  W.ledge(m, a - 0.14, b + 0.14, y0 - 0.16, y0, 0.16, trim, MAT.lit, shade(trim, 1.1))
  W.ledge(m, a - 0.1, b + 0.1, y1, y1 + 0.24, 0.07, trim)
}

/** Shopfronts along a street face: lit display glass, a door, fascia band with a sign, sometimes an awning. */
function shopfront(ctx: BuildingCtx, f: Face, g: number, trim: Rgb, body: Rgb) {
  const { m, rng } = ctx
  const W = f.wall
  const w = W.w
  const units = Math.max(1, Math.round((w - 1.2) / (6 + rng() * 3)))
  const uw = (w - 1.2) / units
  const glassTop = g - 1.15
  const r = 0.35
  // Fascia band and the wall above the glass.
  W.rect(m, 0, w, glassTop, g - 0.35, 0, shade(trim, 0.55))
  W.rect(m, 0, 0.6, 0.55, glassTop, 0, trim)
  W.rect(m, w - 0.6, w, 0.55, glassTop, 0, trim)
  for (let k = 0; k < units; k++) {
    const a = 0.6 + k * uw
    const b = a + uw
    const ga = a + (k === 0 ? 0 : 0.3)
    const gb = b - (k === units - 1 ? 0 : 0.3)
    if (k > 0) W.rect(m, a - 0.3, a + 0.3, 0.55, glassTop, 0, trim)
    const lit = rng() < 0.7
    const col = lit ? shade(SHOP_LIT[Math.floor(rng() * SHOP_LIT.length)]!, 0.45 + rng() * 0.15) : [0.06, 0.07, 0.1]
    // Stall riser, display glass and the door.
    W.rect(m, ga, gb, 0.55, 0.95, 0, shade(trim, 0.6))
    if (f.detail) W.reveal(m, ga, gb, 0.95, glassTop, r, shade(trim, 0.7))
    const d = f.detail ? -r : 0.03
    const door = ga + (gb - ga) * (0.15 + rng() * 0.6)
    W.rect(m, ga, door - 0.6, 0.95, glassTop, d, col as Rgb, lit ? MAT.emissive : MAT.glass)
    W.rect(m, door + 0.6, gb, 0.95, glassTop, d, col as Rgb, lit ? MAT.emissive : MAT.glass)
    W.rect(m, door - 0.6, door + 0.6, 0.95, glassTop - 0.45, d, DOOR)
    W.rect(m, door - 0.6, door + 0.6, glassTop - 0.45, glassTop, d, shade(col as Rgb, 0.8), lit ? MAT.emissive : MAT.glass)
    if (f.detail) {
      // Mullions.
      for (let u = ga + 1.6; u < gb - 0.8; u += 1.6) if (Math.abs(u - door) > 0.8) W.rect(m, u - 0.05, u + 0.05, 0.95, glassTop, d + 0.02, FRAME)
      W.rect(m, ga, gb, glassTop - 0.5, glassTop - 0.42, d + 0.02, FRAME)
    }
    // Sign on the fascia or an awning.
    const roll = rng()
    if (roll < 0.55) {
      const region = SHOP_SIGNS[Math.floor(rng() * SHOP_SIGNS.length)]!
      const sw = Math.min(gb - ga - 0.6, 3.6)
      const cu = (ga + gb) / 2
      const tint: Rgb = rng() < 0.5 ? [1, 0.82, 0.55] : rng() < 0.5 ? [1, 0.45, 0.55] : [0.55, 0.9, 1]
      W.decal(m, cu - sw / 2, cu + sw / 2, glassTop + 0.05, g - 0.4, 0.04, region, shade(tint, 0.6), MAT.neon)
    } else if (roll < 0.8) {
      W.awning(m, ga - 0.1, gb + 0.1, glassTop + 0.25, 1.5, 0.55, AWNINGS[Math.floor(rng() * AWNINGS.length)]!)
    }
    if (lit && f.detail && rng() < 0.5) {
      const p = W.p((ga + gb) / 2, 1.6, 2.2)
      ctx.lamps.push({ x: p[0], y: p[1] + 1.2, z: p[2], small: true })
    }
  }
  void body
}

/** Ground floor without shops: rusticated base, smaller windows and a lit entrance on street faces. */
function groundPlain(ctx: BuildingCtx, f: Face, g: number, body: Rgb, trim: Rgb, bw: number, nb: number, margin: number, winW: number, winH: number) {
  const { m, rng } = ctx
  const W = f.wall
  const w = W.w
  const base = shade(trim, 0.62)
  const wy0 = 1.4
  const wy1 = Math.min(g - 0.7, wy0 + winH * 0.9)
  const door = f.street && f.detail ? Math.floor(rng() * nb) : -1
  const holes: [number, number, boolean][] = []
  for (let k = 0; k < nb; k++) {
    const c = margin + bw * (k + 0.5)
    if (k === door) holes.push([c - 0.8, c + 0.8, true])
    else holes.push([c - winW / 2, c + winW / 2, false])
  }
  if (!f.detail) {
    W.rect(m, 0, w, 0.55, g - 0.35, 0, base)
    for (const [a, b] of holes) W.rect(m, a, b, wy0, wy1, 0.03, GLASS, MAT.glass)
    return
  }
  W.rect(m, 0, w, wy1, g - 0.35, 0, base)
  let u = 0
  for (const [a, b, isDoor] of holes) {
    W.rect(m, u, a, 0.55, wy1, 0, base)
    if (!isDoor) W.rect(m, a, b, 0.55, wy0, 0, base)
    u = b
  }
  W.rect(m, u, w, 0.55, wy1, 0, base)
  // Rustication grooves.
  for (let y = 1.1; y < g - 0.6; y += 0.7) W.rect(m, 0, w, y, y + 0.05, 0.01, shade(base, 0.75))
  for (const [a, b, isDoor] of holes) {
    if (isDoor) {
      W.reveal(m, a, b, 0.55, wy1, 0.4, shade(base, 0.8))
      W.rect(m, a, b, 0.55, wy1 - 0.6, -0.4, DOOR)
      W.rect(m, a, b, wy1 - 0.55, wy1, -0.4, [0.95, 0.7, 0.4], MAT.emissive)
      W.ledge(m, a - 0.3, b + 0.3, wy1, wy1 + 0.3, 0.25, trim)
      // Wall lamp beside the entrance.
      const lp = W.p(b + 0.5, wy1 - 0.2, 0.2)
      m.box(lp[0] - 0.12, lp[0] + 0.12, lp[1], lp[1] + 0.3, lp[2] - 0.12, lp[2] + 0.12, [1, 0.78, 0.45], MAT.emissive)
      const lq = W.p(b + 0.5, wy1, 1.2)
      ctx.lamps.push({ x: lq[0], y: lq[1], z: lq[2], small: true })
    } else {
      W.reveal(m, a, b, wy0, wy1, 0.22, shade(base, 0.8), trim)
      const lit = rng() < 0.3
      W.rect(m, a, b, wy0, wy1, -0.22, lit ? shade(LIT[0]!, 0.6) : GLASS, lit ? MAT.emissive : MAT.glass)
      W.ledge(m, a - 0.12, b + 0.12, wy0 - 0.14, wy0, 0.14, trim)
    }
  }
  void body
}

/** Job sites and the precinct: a stone base with tall openings and the name over the door. */
function groundSpecial(ctx: BuildingCtx, f: Face, b: Box, body: Rgb, trim: Rgb) {
  const { m } = ctx
  const W = f.wall
  const w = W.w
  const g = GROUND_FLOOR
  const front = f.side === 2 || (b.label === "PRECINCT" && f.side === 0)
  W.rect(m, 0, w, 0.55, g - 0.35, 0, shade(body, 0.9))
  if (!f.detail) return
  // Columns along the front.
  const cols = Math.max(3, Math.floor(w / 3.2))
  for (let k = 0; k < cols; k++) {
    const u = 0.9 + ((w - 1.8) * k) / (cols - 1)
    W.ledge(m, u - 0.35, u + 0.35, 0.55, g - 0.35, 0.35, shade(trim, 1.1))
    if (k < cols - 1) {
      const a = u + 0.6
      const c = 0.9 + ((w - 1.8) * (k + 1)) / (cols - 1) - 0.6
      if (c - a > 0.6) {
        const lit = front || k % 2 === 0
        W.rect(m, a, c, 0.9, g - 0.9, 0.02, lit ? [0.62, 0.48, 0.32] : GLASS, lit ? MAT.emissive : MAT.glass)
      }
    }
  }
  if (front && b.label) {
    const region: AtlasRegion = b.label === "bank" ? "bank" : b.label === "jewelry" ? "jewelers" : b.label === "gallery" ? "gallery" : "precinct"
    const sw = Math.min(w - 2, 14)
    const tint: Rgb = b.label === "PRECINCT" ? [0.55, 0.75, 1] : b.label === "bank" ? [1, 0.85, 0.6] : b.neon ?? [1, 1, 1]
    W.rect(m, (w - sw) / 2 - 0.3, (w + sw) / 2 + 0.3, g - 0.3, g + 0.75, 0.2, shade(trim, 0.4))
    W.decal(m, (w - sw) / 2, (w + sw) / 2, g - 0.25, g + 0.7, 0.24, region, shade(tint, 0.7), MAT.neon)
    const p = W.p(w / 2, g - 1, 3)
    ctx.lamps.push({ x: p[0], y: p[1], z: p[2], small: true })
  }
}

/** Iron fire escape: a landing with railings at each storey, a stair flight between, a drop ladder at the bottom. */
function fireEscape(ctx: BuildingCtx, W: Wall, u0: number, u1: number, g: number, storey: number, floors: number, sill: number) {
  const { m } = ctx
  const iron: Rgb = [0.1, 0.1, 0.12]
  const d = 1.3
  for (let fl = 0; fl < floors; fl++) {
    const y = g + fl * storey + sill - 0.15
    W.ledge(m, u0, u1, y - 0.06, y, d, [0.14, 0.14, 0.16])
    // Railing: top rail and balusters on the front.
    beam(m, W.p(u0, y + 0.98, d), W.p(u1, y + 0.98, d), 0.06, iron)
    for (let u = u0; u <= u1 + 0.01; u += 0.4) beam(m, W.p(u, y, d - 0.03), W.p(u, y + 0.98, d - 0.03), 0.03, iron)
    for (const u of [u0, u1]) {
      const a = W.p(u, y + 0.98, 0.05)
      const b = W.p(u, y + 0.98, d)
      beam(m, a, b, 0.05, iron)
    }
    // Stair down to the landing below (or the drop ladder).
    const a = W.p(fl % 2 ? u0 + 0.3 : u1 - 0.3, y, d * 0.5)
    const b = W.p(fl % 2 ? u1 - 0.6 : u0 + 0.6, fl === 0 ? y - 1.6 : y - storey, d * 0.5)
    beam(m, a, b, 0.14, iron)
    const a2: [number, number, number] = [a[0], a[1] + 0.8, a[2]]
    const b2: [number, number, number] = [b[0], b[1] + 0.8, b[2]]
    beam(m, a2, b2, 0.04, iron)
  }
}

/** Painted billboard on the facade with a frame and two little floodlights. */
function billboardOn(ctx: BuildingCtx, W: Wall, u0: number, u1: number, y0: number, y1: number, region: AtlasRegion) {
  const { m } = ctx
  W.ledge(m, u0 - 0.3, u1 + 0.3, y0 - 0.3, y1 + 0.3, 0.25, [0.16, 0.17, 0.2])
  W.decal(m, u0, u1, y0, y1, 0.27, region, [0.52, 0.52, 0.52], MAT.neon)
  for (const u of [u0 + (u1 - u0) * 0.25, u0 + (u1 - u0) * 0.75]) {
    const p = W.p(u, y0 - 0.5, 0.9)
    m.box(p[0] - 0.25, p[0] + 0.25, p[1] - 0.15, p[1] + 0.15, p[2] - 0.25, p[2] + 0.25, [1, 0.9, 0.7], MAT.emissive)
  }
}

/** Vertical blade sign hanging off the facade: a lit box with neon letters on both faces and a tube edge. */
function bladeSign(ctx: BuildingCtx, W: Wall, u: number, y0: number, y1: number, region: AtlasRegion, tint: Rgb) {
  const { m } = ctx
  const t = 0.4
  const d0 = 0.35
  const d1 = 1.75
  // Dark backlit panel so the neon letters carry the color.
  const glow = mix(shade(tint, 0.12), [0.03, 0.03, 0.05], 0.4)
  const a = W.p(u - t / 2, 0, d0)
  const b = W.p(u + t / 2, 0, d1)
  const x0 = Math.min(a[0], b[0])
  const x1 = Math.max(a[0], b[0])
  const z0 = Math.min(a[2], b[2])
  const z1 = Math.max(a[2], b[2])
  slab(m, x0, x1, y0, y1, z0, z1, glow, MAT.emissive, 0)
  // Brackets back to the wall.
  for (const y of [y0 + 0.6, y1 - 0.6]) {
    const p = W.p(u, y, 0)
    const q = W.p(u, y, d0)
    slab(m, Math.min(p[0], q[0]) - 0.05, Math.max(p[0], q[0]) + 0.05, y - 0.05, y + 0.05, Math.min(p[2], q[2]) - 0.05, Math.max(p[2], q[2]) + 0.05, [0.12, 0.12, 0.14])
  }
  // Letters on both broad faces (the faces along the wall's normal).
  const n = W.n
  const tt = W.t
  const inset = 0.15
  const letters = mix(tint, [1, 1, 1], 0.35)
  const lo = y0 + 0.25
  const hi = y1 - 0.25
  for (const s of [-1, 1]) {
    const off = s * (t / 2 + 0.02)
    const p = (d: number, y: number) => [W.ox + tt[0] * (u + off) + n[0] * d, y, W.oz + tt[2] * (u + off) + n[2] * d]
    const nn = [tt[0] * s, 0, tt[2] * s]
    // Seen from +t the image reads with d increasing to the left; from -t to the right.
    if (s > 0) m.decal(p(d1 - inset, lo), p(d0 + inset, lo), p(d0 + inset, hi), p(d1 - inset, hi), nn, region, letters, MAT.neon)
    else m.decal(p(d0 + inset, lo), p(d1 - inset, lo), p(d1 - inset, hi), p(d0 + inset, hi), nn, region, letters, MAT.neon)
  }
  const e0 = W.p(u - t / 2 - 0.03, 0, d1)
  const e1 = W.p(u + t / 2 + 0.03, 0, d1 + 0.06)
  slab(m, Math.min(e0[0], e1[0]), Math.max(e0[0], e1[0]), y0, y1, Math.min(e0[2], e1[2]), Math.max(e0[2], e1[2]), shade(tint, 0.6), MAT.emissive, 0)
  const lp = W.p(u, (y0 + y1) / 2, 2.5)
  ctx.lamps.push({ x: lp[0], y: lp[1], z: lp[2], small: true })
}

/** Precinct roof: clutter kept to the edges around the helipad, a radio mast and the rooftop POLICE lettering. */
function precinctRoof(ctx: BuildingCtx, x0: number, x1: number, z0: number, z1: number, y: number) {
  const { m, rng } = ctx
  const cx = (x0 + x1) / 2
  const cz = (z0 + z1) / 2
  for (let x = x0 + 1.5; x < x1 - 2; x += 3.2) {
    if (Math.abs(x - cx) < 10) continue
    for (const z of [z0 + 1.2, z1 - 2.4]) {
      if (rng() < 0.35) continue
      slab(m, x, x + 2.2, y, y + 1.2, z, z + 1.4, METAL, MAT.lit, SKIP.bottom, shade(METAL, 1.15))
      cylinder(m, x + 0.7, z + 0.7, 0.45, y + 1.2, y + 1.25, 8, shade(METAL, 0.4))
    }
  }
  const mx = x1 - 3
  const mz = z1 - 4
  for (const [a, b] of [
    [-0.8, -0.8],
    [0.8, -0.8],
    [0, 0.8],
  ] as const)
    beam(m, [mx + a, y, mz + b], [mx, y + 12, mz], 0.12, [0.55, 0.55, 0.58])
  for (let k = 1; k < 4; k++) beam(m, [mx - 0.6 * (1 - k / 4), y + k * 3, mz - 0.6 * (1 - k / 4)], [mx + 0.6 * (1 - k / 4), y + k * 3, mz - 0.6 * (1 - k / 4)], 0.06, [0.55, 0.55, 0.58])
  m.box(mx - 0.2, mx + 0.2, y + 12, y + 12.4, mz - 0.2, mz + 0.2, [1, 0.1, 0.08], MAT.emissive)
  // Lettering runs along +z with its top toward +x, which reads upright from the fixed camera.
  m.decal([x0 + 3, y + 0.02, cz - 6], [x0 + 3, y + 0.02, cz + 6], [x0 + 6, y + 0.02, cz + 6], [x0 + 6, y + 0.02, cz - 6], [0, 1, 0], "policeBlock", [0.75, 0.75, 0.72], MAT.decal)
}

/** Roof clutter: AC units, vents, a stair hut, sometimes a timber water tank or skylights. */
function roof(ctx: BuildingCtx, x0: number, x1: number, z0: number, z1: number, y: number, tone: Rgb) {
  const { m, rng } = ctx
  const w = x1 - x0
  const d = z1 - z0
  const occupied: [number, number, number, number][] = []
  const place = (sx: number, sz: number) => {
    for (let tries = 0; tries < 8; tries++) {
      const cx = x0 + 0.6 + sx / 2 + rng() * Math.max(0, w - sx - 1.2)
      const cz = z0 + 0.6 + sz / 2 + rng() * Math.max(0, d - sz - 1.2)
      const r: [number, number, number, number] = [cx - sx / 2 - 0.3, cx + sx / 2 + 0.3, cz - sz / 2 - 0.3, cz + sz / 2 + 0.3]
      if (occupied.some((o) => r[0] < o[1] && r[1] > o[0] && r[2] < o[3] && r[3] > o[2])) continue
      occupied.push(r)
      return [cx, cz] as const
    }
    return null
  }
  // Roof membrane seams.
  for (let x = x0 + 3; x < x1 - 1; x += 3) m.quad([x, y + 0.01, z0], [x, y + 0.01, z1], [x + 0.06, y + 0.01, z1], [x + 0.06, y + 0.01, z0], [0, 1, 0], shade(tone, 0.85))
  // Patched membrane.
  for (let k = 0; k < 2; k++) {
    const pw = 2 + rng() * 4
    const pd = 2 + rng() * 4
    const px = x0 + rng() * Math.max(0, w - pw)
    const pz = z0 + rng() * Math.max(0, d - pd)
    m.quad([px, y + 0.012, pz], [px, y + 0.012, pz + pd], [px + pw, y + 0.012, pz + pd], [px + pw, y + 0.012, pz], [0, 1, 0], shade(tone, 0.9 + rng() * 0.25))
  }
  if (w > 7 && d > 7 && rng() < 0.6) {
    const p = place(3.4, 3)
    if (p) {
      const [cx, cz] = p
      slab(m, cx - 1.7, cx + 1.7, y, y + 2.7, cz - 1.5, cz + 1.5, DARK_STONE, MAT.lit, SKIP.bottom, ROOF_TRIM)
      slab(m, cx - 1.85, cx + 1.85, y + 2.7, y + 2.9, cz - 1.65, cz + 1.65, ROOF_TRIM)
      m.quad([cx + 0.5, y, cz - 1.52], [cx - 0.5, y, cz - 1.52], [cx - 0.5, y + 2.1, cz - 1.52], [cx + 0.5, y + 2.1, cz - 1.52], [0, 0, -1], DOOR)
      m.box(cx - 0.15, cx + 0.15, y + 2.2, y + 2.4, cz - 1.62, cz - 1.5, [1, 0.8, 0.5], MAT.emissive)
    }
  }
  // Large rooftop plant: a packaged unit on a curb with two fans on top, the biggest silhouette on most roofs.
  if (w * d > 120) {
    const big = place(4.2, 2.4)
    if (big) {
      const [cx, cz] = big
      slab(m, cx - 2.2, cx + 2.2, y, y + 0.25, cz - 1.3, cz + 1.3, ROOF_TRIM)
      slab(m, cx - 2.1, cx + 2.1, y + 0.25, y + 1.9, cz - 1.2, cz + 1.2, METAL, MAT.lit, SKIP.bottom, shade(METAL, 1.12))
      for (const fx of [-1, 1]) {
        cylinder(m, cx + fx, cz, 0.75, y + 1.9, y + 2.05, 10, shade(METAL, 0.85))
        cylinder(m, cx + fx, cz, 0.6, y + 2.05, y + 2.07, 10, shade(METAL, 0.35))
      }
      for (let u = cx - 1.9; u < cx + 1.9; u += 0.3) m.quad([u + 0.12, y + 0.45, cz - 1.21], [u, y + 0.45, cz - 1.21], [u, y + 1.7, cz - 1.21], [u + 0.12, y + 1.7, cz - 1.21], [0, 0, -1], shade(METAL, 0.6))
    }
  }
  const n = 2 + Math.floor(rng() * 3 + (w * d) / 55)
  for (let i = 0; i < n; i++) {
    const big = rng() < 0.4
    const sx = big ? 2.6 : 1.4
    const sz = big ? 1.8 : 1.1
    const p = place(sx, sz)
    if (!p) continue
    const [cx, cz] = p
    const hh = big ? 1.4 : 1.0
    const col = shade(METAL, 0.9 + rng() * 0.25)
    slab(m, cx - sx / 2, cx + sx / 2, y, y + hh, cz - sz / 2, cz + sz / 2, col, MAT.lit, SKIP.bottom, shade(col, 1.15))
    // Grille on the face toward the camera and a fan on top.
    m.quad([cx - sx / 2 + 0.1, y + 0.15, cz - sz / 2 - 0.01], [cx - sx / 2 + 0.1, y + hh - 0.15, cz - sz / 2 - 0.01], [cx + sx / 2 - 0.1, y + hh - 0.15, cz - sz / 2 - 0.01], [cx + sx / 2 - 0.1, y + 0.15, cz - sz / 2 - 0.01], [0, 0, -1], shade(METAL, 0.5))
    cylinder(m, cx - (big ? 0.5 : 0), cz, big ? 0.5 : 0.35, y + hh, y + hh + 0.05, 8, shade(METAL, 0.4))
    // Refrigerant line running off to the parapet.
    if (rng() < 0.4) slab(m, cx - 0.06, cx + 0.06, y + 0.1, y + 0.22, z0, cz - sz / 2, shade(METAL, 0.7))
  }
  for (let i = 0; i < 2 + Math.floor(rng() * 4); i++) {
    const p = place(0.5, 0.5)
    if (!p) continue
    const vh = 0.7 + rng() * 0.8
    cylinder(m, p[0], p[1], 0.18, y, y + vh, 6, shade(METAL, 0.9))
    if (rng() < 0.5) m.prism(p[0], p[1], 0.32, 0.05, y + vh, y + vh + 0.25, 6, shade(METAL, 0.7))
  }
  // Roof hatch and a duct run.
  if (rng() < 0.6) {
    const p = place(1.2, 1.2)
    if (p) slab(m, p[0] - 0.6, p[0] + 0.6, y, y + 0.45, p[1] - 0.6, p[1] + 0.6, ROOF_TRIM, MAT.lit, SKIP.bottom, shade(METAL, 0.8))
  }
  if (w > 9 && rng() < 0.5) {
    const len = Math.min(w - 3, 4 + rng() * 6)
    const p = place(len, 0.7)
    if (p) {
      slab(m, p[0] - len / 2, p[0] + len / 2, y + 0.25, y + 0.85, p[1] - 0.3, p[1] + 0.3, shade(METAL, 1.1))
      for (let x = p[0] - len / 2 + 0.6; x < p[0] + len / 2; x += 2) slab(m, x - 0.05, x + 0.05, y, y + 0.25, p[1] - 0.25, p[1] + 0.25, shade(METAL, 0.6))
    }
  }
  if (rng() < 0.25) {
    const p = place(1.2, 1.2)
    if (p) {
      cylinder(m, p[0], p[1], 0.06, y, y + 1.1, 4, METAL)
      m.prism(p[0] - 0.25, p[1] - 0.25, 0.6, 0.2, y + 1.0, y + 1.25, 7, [0.6, 0.6, 0.62])
    }
  }
  if (w > 8 && d > 8 && rng() < 0.3) {
    const p = place(3.2, 3.2)
    if (p) {
      const [cx, cz] = p
      for (const [lx, lz] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const)
        slab(m, cx + lx * 1.1 - 0.1, cx + lx * 1.1 + 0.1, y, y + 2.2, cz + lz * 1.1 - 0.1, cz + lz * 1.1 + 0.1, [0.16, 0.16, 0.18])
      cylinder(m, cx, cz, 1.5, y + 2.2, y + 4.6, 9, [0.36, 0.26, 0.18], MAT.lit, [0.3, 0.22, 0.16])
      for (const yy of [y + 2.7, y + 3.6, y + 4.3]) cylinder(m, cx, cz, 1.53, yy, yy + 0.08, 9, [0.15, 0.14, 0.14])
      m.prism(cx, cz, 1.62, 0, y + 4.6, y + 5.5, 9, [0.28, 0.2, 0.15])
    }
  }
  if (rng() < 0.3) {
    const p = place(2.4, 1.4)
    if (p) {
      const [cx, cz] = p
      slab(m, cx - 1.2, cx + 1.2, y, y + 0.35, cz - 0.7, cz + 0.7, ROOF_TRIM)
      m.facet([cx - 1.1, y + 0.35, cz - 0.6], [cx - 1.1, y + 0.75, cz + 0.6], [cx + 1.1, y + 0.75, cz + 0.6], [0.2, 0.26, 0.34], MAT.glass)
      m.facet([cx - 1.1, y + 0.35, cz - 0.6], [cx + 1.1, y + 0.75, cz + 0.6], [cx + 1.1, y + 0.35, cz - 0.6], [0.2, 0.26, 0.34], MAT.glass)
    }
  }
}
