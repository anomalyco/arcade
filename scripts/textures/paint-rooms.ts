/**
 * Paints the interior-mapping room atlas (`packages/kit/gpu/materials/rooms.webp` + `rooms-atlas.ts`): a small CPU
 * ray tracer renders each room in one-point perspective through its window, exactly the projection
 * `kitRoomBoxUV` re-projects (back wall at ROOM_BACK_SCALE of the frame), so the parallax lines up.
 *
 * Rooms are a 1980s research facility at 3 a.m.: desk-lamp office, fluorescent office, lab benches, fume hood,
 * CRT terminal pool, construction site under a clamp work light, red beacon equipment room, conference room. Two
 * seeded variants each. Every pixel is generated here, so the atlas is ours (no third-party images).
 *
 * Usage: bun scripts/textures/paint-rooms.ts [--preview <png>]   (needs ImageMagick `magick` for the WebP)
 */
import { resolve } from "node:path"

const CELL = 256
const SS = 3
const COLS = 4
const ROWS = 4
const VARIANTS = 2
const BACK = 0.55
export const KINDS = ["desk", "office", "lab", "hood", "crt", "work", "beacon", "conference"] as const
const W = 3.6, H = 2.9, D = 5.2

type V3 = [number, number, number]
type Box = { min: V3; max: V3; albedo: V3; emit?: V3 }
type Light = { p: V3; c: V3; spot?: { axis: V3; cos: number } }
type Room = { boxes: Box[]; lights: Light[]; wall: V3; floor: V3; ceiling: V3; ambient: V3; tiles: boolean; troffers: [number, number][] }

function rng(seed: number) {
  let s = seed >>> 0
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const srgb = (hex: number): V3 => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map(v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }) as V3
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]

function room(kind: (typeof KINDS)[number], seed: number): Room {
  const r = rng(seed * 7919 + kind.length * 104729)
  const boxes: Box[] = [], lights: Light[] = []
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, albedo: V3, emit?: V3) => boxes.push({ min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], max: [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)], albedo, ...(emit ? { emit } : {}) })
  const cream = srgb(0xb9b39c), green = srgb(0x7f8f7a), lino = srgb(0x5e6457), grey = srgb(0x6d6f6c), dark = srgb(0x2b2c2a), wood = srgb(0x6b4f33), beige = srgb(0xa89c80)
  const desk = (x: number, z: number, w = 1.4, d = 0.75) => { box(x - w / 2, 0.71, z - d / 2, x + w / 2, 0.75, z + d / 2, r() < 0.5 ? wood : grey); box(x - w / 2 + 0.03, 0, z - d / 2 + 0.05, x - w / 2 + 0.45, 0.71, z + d / 2 - 0.05, grey) }
  const crt = (x: number, z: number, screen: V3) => { box(x - 0.2, 0.75, z - 0.2, x + 0.2, 1.1, z + 0.2, beige); box(x - 0.16, 0.79, z + 0.201, x + 0.16, 1.06, z + 0.205, dark, screen) }
  const cabinet = (x: number, z: number, h = 1.3) => box(x - 0.24, 0, z - 0.32, x + 0.24, h, z + 0.32, grey)
  const chair = (x: number, z: number) => { box(x - 0.24, 0.42, z - 0.24, x + 0.24, 0.48, z + 0.24, dark); box(x - 0.22, 0.48, z + 0.2, x + 0.22, 0.95, z + 0.26, dark); box(x - 0.03, 0, z - 0.03, x + 0.03, 0.42, z + 0.03, dark) }
  const troffer = (x: number, z: number): [number, number] => { lights.push({ p: [x, H - 0.05, z], c: [9, 9.6, 9.2], spot: { axis: [0, -1, 0], cos: -0.05 } }); return [x, z] }
  const base = { wall: r() < 0.5 ? cream : green, floor: lino, ceiling: srgb(0xc9c6bb), tiles: true, troffers: [] as [number, number][] }
  const back = -D
  switch (kind) {
    case "desk": {
      const x = (r() - 0.5) * 1.6, z = back + 0.6 + r() * 1.2
      desk(x, z); crt(x + 0.35, z - 0.05, [0.02, 0.05, 0.04]); chair(x, z + 0.7)
      box(x - 0.62, 0.75, z - 0.12, x - 0.48, 0.79, z + 0.02, dark); box(x - 0.57, 0.79, z - 0.06, x - 0.54, 1.12, z - 0.03, dark)
      box(x - 0.66, 1.08, z - 0.16, x - 0.44, 1.2, z + 0.06, srgb(0x3a3022), [2.4, 1.5, 0.6])
      lights.push({ p: [x - 0.55, 1.05, z - 0.05], c: [7, 4.2, 1.8], spot: { axis: [0, -1, 0], cos: 0.25 } })
      cabinet(W / 2 - 0.3, back + 0.5 + r() * 2); cabinet(W / 2 - 0.3, back + 1.2 + r() * 2, 1.0)
      box(-W / 2, 1.0, back + 1 + r() * 2, -W / 2 + 0.02, 1.7, back + 2.2 + r() * 2, srgb(0x8a7a5a))
      return { ...base, boxes, lights, ambient: [0.004, 0.0035, 0.003] }
    }
    case "office": case "conference": {
      const t = [troffer(-0.7, -1.4), troffer(0.7, -3.4 + r() * 0.5), troffer(-0.6 + r(), -4.5)]
      if (kind === "office") {
        for (let i = 0; i < 3; i++) { const x = (i - 1) * 1.15 + (r() - 0.5) * 0.2, z = back + 1.1 + r() * 2.4; desk(x, z, 1.0); if (r() < 0.7) crt(x + 0.2, z - 0.1, r() < 0.3 ? [0.05, 0.25, 0.12] : [0.02, 0.03, 0.03]); chair(x, z + 0.6) }
        for (let i = 0; i < 3; i++) cabinet(-W / 2 + 0.3, back + 0.5 + i * 0.52)
      } else {
        box(-0.6, 0.72, back + 1.0, 0.6, 0.76, back + 3.8, wood)
        for (let i = 0; i < 4; i++) { chair(-0.85, back + 1.4 + i * 0.7); chair(0.85, back + 1.4 + i * 0.7) }
        box(-1.0, 0.9, back + 0.01, 1.0, 2.0, back + 0.03, srgb(0xe8e6de))
      }
      box(-W / 2, 1.1, back + 2 + r(), -W / 2 + 0.02, 1.8, back + 3.3 + r(), srgb(0x9d8a5c))
      box(W / 2 - 0.9, 0, back, W / 2 - 0.05, 2.1, back + 0.04, srgb(0x6a5236))
      return { ...base, troffers: t, boxes, lights, ambient: [0.05, 0.052, 0.05] }
    }
    case "lab": case "hood": {
      const white = srgb(0xd8d6cc)
      for (const s of [-1, 1]) { box(s * (W / 2 - 0.35), 0, back + 0.2, s * (W / 2), 0.92, -0.6, white); box(s * (W / 2 - 0.25), 1.45, back + 0.4, s * (W / 2), 1.48, -1.2, grey); box(s * (W / 2 - 0.25), 1.95, back + 0.4, s * (W / 2), 1.98, -1.2, grey)
        for (let i = 0; i < 14; i++) { const z = back + 0.6 + r() * (D - 2), h = 0.1 + r() * 0.18, c: V3 = [[0.5, 0.42, 0.25], [0.25, 0.4, 0.5], [0.7, 0.7, 0.68], [0.3, 0.5, 0.3]][Math.floor(r() * 4)] as V3; const y = r() < 0.5 ? 1.48 : 1.98; box(s * (W / 2 - 0.15), y, z, s * (W / 2 - 0.08), y + h, z + 0.07, c) } }
      box(-0.55, 0, back + 1.4, 0.55, 0.92, back + 3.2, white)
      if (kind === "hood") {
        const x = (r() - 0.5) * 1.2
        box(x - 0.8, 0, back, x + 0.8, 0.9, back + 0.8, white); box(x - 0.8, 0.9, back, x - 0.75, 2.3, back + 0.8, white); box(x + 0.75, 0.9, back, x + 0.8, 2.3, back + 0.8, white)
        box(x - 0.8, 1.9, back, x + 0.8, 2.4, back + 0.8, white); box(x - 0.75, 0.92, back, x + 0.75, 1.9, back + 0.02, srgb(0xb8c8c0), [3.2, 4.2, 3.8])
        lights.push({ p: [x, 1.85, back + 0.5], c: [5, 6.5, 6], spot: { axis: [0, -0.55, 0.83], cos: 0.0 } })
        return { ...base, wall: white, boxes, lights, ambient: [0.006, 0.008, 0.008] }
      }
      return { ...base, wall: white, troffers: [troffer(0, -1.3), troffer(0, -3.3), troffer(0, -4.8)], boxes, lights, ambient: [0.05, 0.055, 0.055] }
    }
    case "crt": {
      for (let row = 0; row < 2; row++) for (let i = 0; i < 3; i++) {
        const x = (i - 1) * 1.15, z = back + 0.8 + row * 1.9 + r() * 0.2
        desk(x, z, 1.0); crt(x, z - 0.1, [0.25, 1.6, 0.6]); chair(x, z + 0.6)
        lights.push({ p: [x, 0.93, z + 0.35], c: [0.25, 1.4, 0.55], spot: { axis: [0, -0.2, 1], cos: -0.2 } })
      }
      return { ...base, wall: srgb(0x6e7468), boxes, lights, ambient: [0.003, 0.006, 0.004] }
    }
    case "work": {
      const stud = srgb(0x9a7e58), poly = srgb(0xb8bcb4)
      for (let i = 0; i < 7; i++) box(-W / 2 + 0.4 + i * 0.45, 0, back + 1.6, -W / 2 + 0.45 + i * 0.45, H, back + 1.69, stud)
      box(-W / 2, 0, back + 0.6 + r() * 0.4, -0.2, H, back + 0.62 + r() * 0.4, poly)
      box(0.6, 0, back + 2.8, 1.2, 1.8, back + 2.86, srgb(0x8c6e3a)); box(1.0, 0, back + 3.2, 1.6, 0.5, back + 3.9, srgb(0x7a7a72))
      const lx = 0.9 + r() * 0.4
      box(lx - 0.03, 0, -3.6, lx + 0.03, 1.4, -3.5, dark); box(lx - 0.16, 1.4, -3.66, lx + 0.16, 1.62, -3.44, srgb(0x2a2420), [9, 6.5, 3.4])
      lights.push({ p: [lx - 0.05, 1.5, -3.7], c: [30, 21, 10], spot: { axis: [-0.45, -0.25, -0.86], cos: -0.4 } })
      return { ...base, wall: srgb(0x8d8c86), floor: srgb(0x77756e), ceiling: srgb(0x5c5a55), tiles: false, boxes, lights, ambient: [0.012, 0.011, 0.009] }
    }
    case "beacon": {
      for (let i = 0; i < 4; i++) { const x = -1.3 + i * 0.85; box(x - 0.3, 0, back + 0.3, x + 0.3, 2.0, back + 0.95, dark)
        for (let k = 0; k < 9; k++) { const lx = x - 0.22 + r() * 0.4, ly = 0.3 + r() * 1.55; box(lx, ly, back + 0.951, lx + 0.025, ly + 0.018, back + 0.955, dark, r() < 0.6 ? [3, 0.2, 0.1] : [0.2, 2.5, 0.4]) } }
      box(-0.12, H - 0.25, -2.6, 0.12, H, -2.36, srgb(0x501010), [12, 0.6, 0.3])
      lights.push({ p: [0, H - 0.3, -2.48], c: [14, 0.7, 0.35] })
      return { ...base, wall: srgb(0x5a5c58), boxes, lights, ambient: [0.006, 0.0008, 0.0006] }
    }
  }
}

// ---------------------------------------------------------------- tracing

function hitBox(o: V3, d: V3, b: Box, tMax: number): { t: number; n: V3 } | null {
  let t0 = 1e-4, t1 = tMax, axis = -1, sign = 0
  for (let k = 0; k < 3; k++) {
    const inv = 1 / (Math.abs(d[k]!) < 1e-9 ? 1e-9 : d[k]!)
    let a = (b.min[k]! - o[k]!) * inv, c = (b.max[k]! - o[k]!) * inv
    let s = -1
    if (a > c) { const tmp = a; a = c; c = tmp; s = 1 }
    if (a > t0) { t0 = a; axis = k; sign = s }
    t1 = Math.min(t1, c)
    if (t0 > t1) return null
  }
  if (axis < 0) return null
  const n: V3 = [0, 0, 0]; n[axis] = sign
  return { t: t0, n }
}

function shade(rm: Room, p: V3, n: V3, albedo: V3, emit: V3 | undefined): V3 {
  const out: V3 = emit ? [...emit] : [0, 0, 0]
  for (const l of rm.lights) {
    const L: V3 = [l.p[0] - p[0], l.p[1] - p[1], l.p[2] - p[2]]
    const d2 = Math.max(L[0] ** 2 + L[1] ** 2 + L[2] ** 2, 0.04), d = Math.sqrt(d2)
    const ld: V3 = [L[0] / d, L[1] / d, L[2] / d]
    const ndl = n[0] * ld[0] + n[1] * ld[1] + n[2] * ld[2]
    if (ndl <= 0) continue
    let cone = 1
    if (l.spot) { const c = -(ld[0] * l.spot.axis[0] + ld[1] * l.spot.axis[1] + ld[2] * l.spot.axis[2]); cone = Math.max(0, Math.min(1, (c - l.spot.cos) / (1 - l.spot.cos))) ** 1.5 }
    if (cone <= 0) continue
    const o: V3 = [p[0] + n[0] * 0.002, p[1] + n[1] * 0.002, p[2] + n[2] * 0.002]
    let blocked = false
    for (const b of rm.boxes) { if (b.emit) continue; if (hitBox(o, ld, b, d - 0.02)) { blocked = true; break } }
    if (blocked) continue
    const k = (ndl * cone) / (Math.PI * d2)
    for (let c = 0; c < 3; c++) out[c]! += albedo[c]! * l.c[c]! * k
  }
  // Bounce: the room's ambient, darker near the floor and in the corners.
  const corner = Math.min(p[0] + W / 2, W / 2 - p[0], p[1], H - p[1], p[2] + D)
  const ao = 1 - 0.55 * Math.exp(-corner / 0.35)
  for (let c = 0; c < 3; c++) out[c]! += albedo[c]! * rm.ambient[c]! * ao * 6
  return out
}

function trace(rm: Room, u: number, v: number): V3 {
  // Box space: x, y in -0.5..0.5 across the window, z in -1..0; camera on the axis so the back wall spans BACK.
  const camDist = BACK / (1 - BACK)
  const d0: V3 = [u - 0.5, 0.5 - v, -camDist]
  // Metric ray (the room is W × H × D behind a unit window).
  const o: V3 = [0, H / 2, camDist * D]
  const d: V3 = [d0[0] * W, d0[1] * H, d0[2] * D]
  const len = Math.hypot(...d); d[0] /= len; d[1] /= len; d[2] /= len
  let best = Infinity, n: V3 = [0, 0, 1], albedo: V3 = rm.wall, emit: V3 | undefined
  const planes: [number, number, number, V3][] = [[0, -W / 2, 1, rm.wall], [0, W / 2, -1, rm.wall], [1, 0, 1, rm.floor], [1, H, -1, rm.ceiling], [2, -D, 1, rm.wall]]
  for (const [axis, at, s, alb] of planes) {
    const t = (at - o[axis]!) / d[axis]!
    if (t > 0 && t < best) { best = t; n = [0, 0, 0]; n[axis] = s; albedo = alb; emit = undefined }
  }
  for (const b of rm.boxes) { const h = hitBox(o, d, b, best); if (h && h.t < best) { best = h.t; n = h.n; albedo = b.albedo; emit = b.emit } }
  const p: V3 = [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best]
  if (!emit && n[1] < -0.5 && p[1] > H - 0.01) {
    // Ceiling tiles and the lit troffers in them.
    for (const [tx, tz] of rm.troffers) if (Math.abs(p[0] - tx) < 0.3 && Math.abs(p[2] - tz) < 0.6) emit = [6, 6.4, 6.1]
    if (rm.tiles && !emit && (Math.abs(((p[0] + 10) % 0.6) - 0.3) > 0.285 || Math.abs(((p[2] + 10) % 0.6) - 0.3) > 0.285)) albedo = scale(albedo, 0.6)
  }
  if (!emit && n[1] > 0.5 && p[1] < 0.01 && rm.tiles && (Math.abs(((p[0] + 10) % 0.3) - 0.15) > 0.146 || Math.abs(((p[2] + 10) % 0.3) - 0.15) > 0.146)) albedo = scale(albedo, 0.8)
  return shade(rm, p, n, albedo, emit)
}

// ---------------------------------------------------------------- atlas

const width = COLS * CELL, height = ROWS * CELL
const rgba = new Uint8Array(width * height * 4)
const gains: number[] = []
const enc = (c: number) => { const v = Math.max(0, Math.min(1, c)); return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255) }
for (let k = 0; k < KINDS.length; k++) for (let variant = 0; variant < VARIANTS; variant++) {
  const idx = k * VARIANTS + variant
  const rm = room(KINDS[k]!, variant + 1)
  const cell = new Float32Array(CELL * CELL * 3)
  let mean = 0
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    const acc: V3 = [0, 0, 0]
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = trace(rm, (x + (sx + 0.5) / SS) / CELL, (y + (sy + 0.5) / SS) / CELL)
      acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
    }
    const i = (y * CELL + x) * 3
    for (let c = 0; c < 3; c++) cell[i + c] = acc[c]! / (SS * SS)
    mean += (0.2126 * cell[i]! + 0.7152 * cell[i + 1]! + 0.0722 * cell[i + 2]!) / (CELL * CELL)
  }
  // Store radiance / peak (peak = 99.7th percentile max channel after normalising the mean luminance to 1), so the
  // shader's room × gain has mean 1: a far window matches a flat pane of the same brightness.
  const maxes = Array.from({ length: CELL * CELL }, (_, i) => Math.max(cell[i * 3]!, cell[i * 3 + 1]!, cell[i * 3 + 2]!) / mean).sort((a, b) => a - b)
  const peak = Math.max(1, maxes[Math.floor(maxes.length * 0.997)]!)
  gains.push(+peak.toFixed(4))
  const ox = (idx % COLS) * CELL, oy = Math.floor(idx / COLS) * CELL
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    const i = (y * CELL + x) * 3, o = ((oy + y) * width + ox + x) * 4
    for (let c = 0; c < 3; c++) rgba[o + c] = enc(cell[i + c]! / mean / peak)
    rgba[o + 3] = 255
  }
  console.log(`${KINDS[k]} v${variant}: mean ${mean.toFixed(4)}, gain ${peak.toFixed(2)}`)
}

const dir = resolve(import.meta.dir, "../../packages/kit/gpu/materials")
const raw = resolve(dir, "rooms.rgba")
await Bun.write(raw, rgba)
const webp = resolve(dir, "rooms.webp")
const run = Bun.spawnSync(["magick", "-size", `${width}x${height}`, "-depth", "8", `rgba:${raw}`, "-alpha", "off", "-quality", "92", "-define", "webp:method=6", webp])
if (run.exitCode !== 0) throw new Error(run.stderr.toString())
const previewAt = process.argv.indexOf("--preview")
if (previewAt > 0) Bun.spawnSync(["magick", "-size", `${width}x${height}`, "-depth", "8", `rgba:${raw}`, "-alpha", "off", process.argv[previewAt + 1]!])
await Bun.file(raw).delete()
await Bun.write(resolve(dir, "rooms-atlas.ts"), `// Generated by scripts/textures/paint-rooms.ts. Do not edit.
export const ROOM_ATLAS = { cols: ${COLS}, rows: ${ROWS}, variants: ${VARIANTS}, backScale: ${BACK}, kinds: ${JSON.stringify(KINDS)}, gains: ${JSON.stringify(gains)} } as const
`)
console.log("Wrote", webp)
