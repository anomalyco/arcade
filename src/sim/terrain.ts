import { rng, type Rand } from "./rng"

export const WORLD_W = 1200
export const WORLD_H = 640

export type Mask = Uint8Array
export type Biome = "hills" | "canyon" | "mesas" | "caverns" | "ridge"
export const BIOMES: Biome[] = ["hills", "canyon", "mesas", "caverns", "ridge"]

// Unit body geometry shared by the volley, movement and spawn code.
// A resting unit has y = groundRow - UNIT_BODY; its feet are the 3 columns x-FOOT, x, x+FOOT.
export const UNIT_R = 9
export const UNIT_BODY = 7
export const FOOT = 3

export function isSolid(mask: Mask, x: number, y: number): boolean {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  if (ix < 0 || ix >= WORLD_W) return false
  if (iy < 0) return false
  if (iy >= WORLD_H) return true
  return mask[iy * WORLD_W + ix] === 1
}

function cell(mask: Mask, x: number, y: number): boolean {
  if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return false
  return mask[y * WORLD_W + x] === 1
}

export function surfaceY(mask: Mask, x: number): number {
  const ix = Math.min(WORLD_W - 1, Math.max(0, Math.floor(x)))
  for (let y = 0; y < WORLD_H; y++) if (mask[y * WORLD_W + ix] === 1) return y
  return WORLD_H
}

// first solid row >= y0 in a single column; WORLD_H when the column is open to the bottom
export function columnGround(mask: Mask, x: number, y0: number): number {
  const ix = Math.floor(x)
  if (ix < 0 || ix >= WORLD_W) return WORLD_H
  for (let y = Math.max(0, Math.floor(y0)); y < WORLD_H; y++) if (mask[y * WORLD_W + ix] === 1) return y
  return WORLD_H
}

// first row >= y0 where any foot column is solid; WORLD_H when there is no ground below
export function footGround(mask: Mask, x: number, y0: number): number {
  const ix = Math.floor(x)
  for (let y = Math.max(0, Math.floor(y0)); y < WORLD_H; y++) {
    if (cell(mask, ix - FOOT, y) || cell(mask, ix, y) || cell(mask, ix + FOOT, y)) return y
  }
  return WORLD_H
}

export function supported(mask: Mask, x: number, y: number): boolean {
  const ix = Math.floor(x)
  const row = Math.floor(y + UNIT_BODY)
  if (row >= WORLD_H) return false
  return cell(mask, ix - FOOT, row) || cell(mask, ix, row) || cell(mask, ix + FOOT, row)
}

export function embedded(mask: Mask, x: number, y: number): boolean {
  const ix = Math.floor(x)
  const top = Math.floor(y - 4)
  const bottom = Math.floor(y + UNIT_BODY - 1)
  for (let row = top; row <= bottom; row += 2) {
    if (cell(mask, ix - FOOT, row) || cell(mask, ix, row) || cell(mask, ix + FOOT, row)) return true
  }
  return cell(mask, ix - FOOT, bottom) || cell(mask, ix, bottom) || cell(mask, ix + FOOT, bottom)
}

// nearest y at or above the given one where the unit body is clear
export function liftOut(mask: Mask, x: number, y: number): number {
  let ny = Math.floor(y)
  while (ny > -UNIT_BODY && embedded(mask, x, ny)) ny--
  return ny
}

export function carveCircle(mask: Mask, cx: number, cy: number, r: number): boolean {
  let changed = false
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(WORLD_W - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(WORLD_H - 1, Math.ceil(cy + r))
  const r2 = r * r
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      if (dx * dx + dy * dy <= r2 && mask[y * WORLD_W + x] === 1) {
        mask[y * WORLD_W + x] = 0
        changed = true
      }
    }
  }
  return changed
}

export function fillRect(mask: Mask, x0: number, y0: number, x1: number, y1: number): boolean {
  let changed = false
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(WORLD_H, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(WORLD_W, Math.ceil(x1)); x++) {
      if (mask[y * WORLD_W + x] === 0) {
        mask[y * WORLD_W + x] = 1
        changed = true
      }
    }
  }
  return changed
}

// ---------------------------------------------------------------------------
// Islands: solid pixels not 4-connected to the bottom row.

export interface Island {
  x: number
  y: number
  w: number
  h: number
  count: number
  // world pixel indices
  pixels: Int32Array
}

export interface IslandScratch {
  visited: Uint8Array
  stack: Int32Array
}

export function islandScratch(): IslandScratch {
  return { visited: new Uint8Array(WORLD_W * WORLD_H), stack: new Int32Array(WORLD_W * WORLD_H) }
}

export function findIslands(mask: Mask, scratch: IslandScratch = islandScratch()): Island[] {
  const { visited, stack } = scratch
  const n = WORLD_W * WORLD_H
  visited.fill(0)
  let sp = 0
  const base = (WORLD_H - 1) * WORLD_W
  for (let x = 0; x < WORLD_W; x++) {
    if (mask[base + x] === 1) {
      visited[base + x] = 1
      stack[sp++] = base + x
    }
  }
  while (sp > 0) {
    const i = stack[--sp]!
    const x = i % WORLD_W
    if (i >= WORLD_W && mask[i - WORLD_W] === 1 && visited[i - WORLD_W] === 0) {
      visited[i - WORLD_W] = 1
      stack[sp++] = i - WORLD_W
    }
    if (i + WORLD_W < n && mask[i + WORLD_W] === 1 && visited[i + WORLD_W] === 0) {
      visited[i + WORLD_W] = 1
      stack[sp++] = i + WORLD_W
    }
    if (x > 0 && mask[i - 1] === 1 && visited[i - 1] === 0) {
      visited[i - 1] = 1
      stack[sp++] = i - 1
    }
    if (x < WORLD_W - 1 && mask[i + 1] === 1 && visited[i + 1] === 0) {
      visited[i + 1] = 1
      stack[sp++] = i + 1
    }
  }
  const out: Island[] = []
  for (let s = 0; s < n; s++) {
    if (mask[s] !== 1 || visited[s] !== 0) continue
    visited[s] = 2
    sp = 0
    stack[sp++] = s
    const pixels: number[] = []
    let minX = WORLD_W
    let maxX = -1
    let minY = WORLD_H
    let maxY = -1
    while (sp > 0) {
      const i = stack[--sp]!
      pixels.push(i)
      const x = i % WORLD_W
      const y = (i - x) / WORLD_W
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (i >= WORLD_W && mask[i - WORLD_W] === 1 && visited[i - WORLD_W] === 0) {
        visited[i - WORLD_W] = 2
        stack[sp++] = i - WORLD_W
      }
      if (i + WORLD_W < n && mask[i + WORLD_W] === 1 && visited[i + WORLD_W] === 0) {
        visited[i + WORLD_W] = 2
        stack[sp++] = i + WORLD_W
      }
      if (x > 0 && mask[i - 1] === 1 && visited[i - 1] === 0) {
        visited[i - 1] = 2
        stack[sp++] = i - 1
      }
      if (x < WORLD_W - 1 && mask[i + 1] === 1 && visited[i + 1] === 0) {
        visited[i + 1] = 2
        stack[sp++] = i + 1
      }
    }
    const sorted = Int32Array.from(pixels).sort()
    out.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, count: sorted.length, pixels: sorted })
  }
  return out
}

// ---------------------------------------------------------------------------
// Noise

function hash2(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

export function noise2(x: number, y: number, s: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = smooth(x - ix)
  const fy = smooth(y - iy)
  const a = hash2(ix, iy, s)
  const b = hash2(ix + 1, iy, s)
  const c = hash2(ix, iy + 1, s)
  const d = hash2(ix + 1, iy + 1, s)
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

export function fbm2(x: number, y: number, s: number, octaves: number): number {
  let sum = 0
  let amp = 0.5
  let norm = 0
  let f = 1
  for (let o = 0; o < octaves; o++) {
    sum += noise2(x * f, y * f, s + o * 1013) * amp
    norm += amp
    amp *= 0.5
    f *= 2
  }
  return sum / norm
}

function fbm1(x: number, s: number, octaves: number): number {
  return fbm2(x, 0.5, s, octaves)
}

// ---------------------------------------------------------------------------
// Procedural battlefield generation

interface Profile {
  biome: Biome
  heights: Float64Array
  // columns of the central canyon (no spawns), if any
  gap: { x0: number; x1: number; floor: number; bridge: { top: number; thick: number } | null } | null
  rough: number
  caves: number
  worms: number
  mesas: Array<{ cx: number; hw: number; top: number; slope: number }>
  overhangs: Array<{ x: number; y: number; rx: number; ry: number }>
}

const OPEN = WORLD_H + 40

function hillsProfile(r: Rand, s: number): Profile {
  const heights = new Float64Array(WORLD_W)
  const base = 360 + r() * 50
  const amp = 90 + r() * 60
  const sl = 0.6 + r() * 0.8
  for (let x = 0; x < WORLD_W; x++) {
    heights[x] = base + (fbm1((x / 300) * sl, s, 4) - 0.5) * amp * 2 + (fbm1(x / 70, s + 7, 2) - 0.5) * 18
  }
  return { biome: "hills", heights, gap: null, rough: 12, caves: 1 + Math.floor(r() * 2), worms: 1 + Math.floor(r() * 2), mesas: [], overhangs: [] }
}

function canyonProfile(r: Rand, s: number): Profile {
  const heights = new Float64Array(WORLD_W)
  const c = WORLD_W / 2 + (r() - 0.5) * 60
  const half = 60 + r() * 50
  const rim = 330 + r() * 70
  const terrace = 34 + r() * 20
  const rise = 90 + r() * 70
  for (let x = 0; x < WORLD_W; x++) {
    // mirrored noise keeps both sides of the split fair but not identical
    const m = Math.abs(x - c)
    const sym = fbm1(m / 120, s, 3)
    const asym = fbm1(x / 120, s + 31, 3)
    const n = sym * 0.75 + asym * 0.25
    const out = Math.min(1, m / (WORLD_W / 2))
    let h = rim - out * rise + (n - 0.5) * 70
    const q = Math.round(h / terrace) * terrace
    h = h + (q - h) * 0.75
    // stepped lip dropping toward the canyon edge
    const lip = m - half
    if (lip > 0 && lip < 70) h += smooth(1 - lip / 70) * (24 + sym * 20)
    heights[x] = h
  }
  const bottomless = r() < 0.5
  const floor = bottomless ? OPEN : WORLD_H - 22 - r() * 20
  const bridge = r() < 0.75 ? { top: rim + 10 + r() * 50, thick: 16 + r() * 12 } : null
  return {
    biome: "canyon",
    heights,
    gap: { x0: Math.round(c - half), x1: Math.round(c + half), floor, bridge },
    rough: 10,
    caves: Math.floor(r() * 2),
    worms: 1 + Math.floor(r() * 2),
    mesas: [],
    overhangs: [],
  }
}

function mesasProfile(r: Rand, s: number): Profile {
  const heights = new Float64Array(WORLD_W)
  const base = 470 + r() * 40
  for (let x = 0; x < WORLD_W; x++) heights[x] = base + (fbm1(x / 160, s, 3) - 0.5) * 60
  const count = 2 + Math.floor(r() * 3)
  const mesas: Profile["mesas"] = []
  const overhangs: Profile["overhangs"] = []
  const slot = WORLD_W / count
  for (let i = 0; i < count; i++) {
    const hw = 50 + r() * Math.min(110, slot * 0.3)
    const cx = slot * (i + 0.5) + (r() - 0.5) * (slot - hw * 2) * 0.5
    const top = 250 + r() * 110
    const slope = 8 + r() * 24
    mesas.push({ cx, hw, top, slope })
    for (const side of [-1, 1]) {
      if (r() < 0.6) overhangs.push({ x: cx + side * (hw + slope * 0.6), y: top + 18 + 14 + r() * 10, rx: 22 + r() * 16, ry: 12 + r() * 8 })
    }
  }
  for (let x = 0; x < WORLD_W; x++) {
    let h = heights[x]!
    for (const m of mesas) {
      const d = Math.abs(x - m.cx) - m.hw
      const ledge = m.top + (fbm1(x / 40, s + 11, 2) - 0.5) * 10
      if (d <= 0) h = Math.min(h, ledge)
      else if (d < m.slope) h = Math.min(h, ledge + (h - ledge) * smooth(d / m.slope))
    }
    heights[x] = h
  }
  return { biome: "mesas", heights, gap: null, rough: 8, caves: Math.floor(r() * 2), worms: Math.floor(r() * 2), mesas, overhangs }
}

function cavernsProfile(r: Rand, s: number): Profile {
  const p = hillsProfile(r, s)
  for (let x = 0; x < WORLD_W; x++) p.heights[x] = p.heights[x]! - 50
  return { ...p, biome: "caverns", rough: 26, caves: 3 + Math.floor(r() * 3), worms: 3 + Math.floor(r() * 3) }
}

function ridgeProfile(r: Rand, s: number): Profile {
  const heights = new Float64Array(WORLD_W)
  const peaks = 1 + Math.floor(r() * 2)
  const centers: Array<{ x: number; h: number; w: number }> = []
  for (let i = 0; i < peaks; i++) centers.push({ x: WORLD_W * (peaks === 1 ? 0.5 + (r() - 0.5) * 0.15 : 0.32 + i * 0.36 + (r() - 0.5) * 0.08), h: 200 + r() * 90, w: 110 + r() * 80 })
  const base = 450 + r() * 40
  for (let x = 0; x < WORLD_W; x++) {
    let h = base + (fbm1(x / 150, s, 3) - 0.5) * 70
    for (const c of centers) {
      const d = Math.abs(x - c.x) / c.w
      const peak = c.h + d * d * (base - c.h) + (fbm1(x / 30, s + 5, 2) - 0.5) * 30
      if (d < 1) h = Math.min(h, peak)
    }
    heights[x] = h
  }
  const overhangs: Profile["overhangs"] = []
  for (const c of centers) {
    const side = r() < 0.5 ? -1 : 1
    const ox = c.x + side * c.w * (0.45 + r() * 0.2)
    const ix = Math.min(WORLD_W - 1, Math.max(0, Math.round(ox)))
    overhangs.push({ x: ox + side * 18, y: heights[ix]! + 34 + r() * 16, rx: 34 + r() * 18, ry: 14 + r() * 8 })
  }
  return { biome: "ridge", heights, gap: null, rough: 18, caves: 1 + Math.floor(r() * 2), worms: 2, mesas: [], overhangs }
}

function profileFor(biome: Biome, r: Rand, s: number): Profile {
  if (biome === "canyon") return canyonProfile(r, s)
  if (biome === "mesas") return mesasProfile(r, s)
  if (biome === "caverns") return cavernsProfile(r, s)
  if (biome === "ridge") return ridgeProfile(r, s)
  return hillsProfile(r, s)
}

export function pickBiome(seed: number): Biome {
  const r = rng(seed ^ 0x2545f491)
  return BIOMES[Math.floor(r() * BIOMES.length)]!
}

function inGap(p: Profile, x: number, margin: number): boolean {
  return p.gap !== null && x >= p.gap.x0 - margin && x <= p.gap.x1 + margin
}

function chooseSpawns(p: Profile, r: Rand, count: number): number[] {
  const allowed: number[] = []
  for (let x = 70; x < WORLD_W - 70; x++) {
    if (inGap(p, x, 46)) continue
    if (p.heights[x]! > WORLD_H - 90) continue
    allowed.push(x)
  }
  if (allowed.length === 0) for (let x = 70; x < WORLD_W - 70; x++) allowed.push(x)
  const xs: number[] = []
  for (let i = 0; i < count; i++) {
    const q = (i + 0.5 + (r() - 0.5) * 0.45) / count
    xs.push(allowed[Math.min(allowed.length - 1, Math.max(0, Math.floor(q * allowed.length)))]!)
  }
  return xs
}

function clampH(h: number): number {
  return Math.min(WORLD_H - 70, Math.max(150, h))
}

function buildMask(p: Profile, r: Rand, s: number, spawnXs: number[]): Mask {
  const heights = p.heights
  // flatten landing pads around spawns
  const pads: Array<{ x: number; y: number }> = []
  for (const sx of spawnXs) {
    const cx = Math.min(WORLD_W - 1, Math.max(0, Math.round(sx)))
    const h = clampH(heights[cx]!)
    pads.push({ x: cx, y: Math.round(h) })
    for (let dx = -70; dx <= 70; dx++) {
      const x = cx + dx
      if (x < 0 || x >= WORLD_W || inGap(p, x, 0)) continue
      const w = Math.min(1, Math.max(0, 1 - (Math.abs(dx) - 16) / 54))
      heights[x] = heights[x]! + (h - heights[x]!) * smooth(w)
    }
  }
  const padNear = (x: number, d: number) => pads.some((pad) => Math.abs(pad.x - x) < d)
  const mask: Mask = new Uint8Array(WORLD_W * WORLD_H)
  for (let x = 0; x < WORLD_W; x++) {
    const top = clampH(heights[x]!)
    const rough = padNear(x, 44) ? 0 : p.rough
    const y0 = Math.max(0, Math.floor(top - rough))
    for (let y = WORLD_H - 1; y >= y0; y--) {
      const d = rough === 0 ? 0 : (fbm2(x / 34, y / 30, s + 17, 3) - 0.5) * 2 * rough
      if (y >= top + d) mask[y * WORLD_W + x] = 1
    }
  }
  // strata-aligned caves via ridged noise
  if (p.caves > 0) {
    const thresh = 0.014 + p.caves * 0.008
    for (let y = 0; y < WORLD_H - 26; y++) {
      for (let x = 0; x < WORLD_W; x++) {
        const i = y * WORLD_W + x
        if (mask[i] !== 1) continue
        if (y < heights[x]! + 34) continue
        if (padNear(x, 46) && y < heights[x]! + 80) continue
        const t = Math.abs(fbm2(x / 130, y / 60, s + 41, 2) - 0.5)
        if (t < thresh) mask[i] = 0
      }
    }
  }
  // worm tunnels: seeded random walks
  for (let w = 0; w < p.worms; w++) {
    let x = 80 + r() * (WORLD_W - 160)
    let y = heights[Math.floor(x)]! + 60 + r() * 120
    let dir = r() * Math.PI * 2
    const len = 50 + Math.floor(r() * 90)
    const rad = 7 + r() * 6
    for (let k = 0; k < len; k++) {
      dir += (r() - 0.5) * 0.7
      x += Math.cos(dir) * 4
      y += Math.sin(dir) * 2.5
      if (x < 10 || x > WORLD_W - 10) break
      const ix = Math.floor(x)
      if (y < heights[ix]! + 26) {
        y = heights[ix]! + 26
        dir = -dir
      }
      if (y > WORLD_H - 30) {
        y = WORLD_H - 30
        dir = -dir
      }
      if (padNear(ix, 40) && y < heights[ix]! + 70) continue
      carveCircle(mask, x, y, rad)
    }
  }
  // chambers
  const chambers = p.biome === "caverns" ? 2 + Math.floor(r() * 2) : Math.floor(r() * 2)
  for (let i = 0; i < chambers; i++) {
    const cx = WORLD_W * (0.15 + r() * 0.7)
    const ix = Math.floor(cx)
    const cy = Math.min(WORLD_H - 70, heights[ix]! + 70 + r() * 90)
    const rx = 40 + r() * 60
    const ry = 18 + r() * 14
    if (padNear(ix, rx + 30) && cy - ry < heights[ix]! + 50) continue
    ellipse(mask, cx, cy, rx, ry, s)
  }
  for (const o of p.overhangs) ellipse(mask, o.x, o.y, o.rx, o.ry, s)
  // canyon split and rock bridge
  if (p.gap) {
    const g = p.gap
    for (let y = 0; y < WORLD_H; y++) {
      const flare = Math.max(0, 1 - y / 520) * 26
      const wl = (fbm1(y / 26, s + 3, 2) - 0.5) * 22 - flare
      const wr = (fbm1(y / 26, s + 9, 2) - 0.5) * 22 + flare
      for (let x = Math.max(0, Math.floor(g.x0 + wl)); x <= Math.min(WORLD_W - 1, Math.ceil(g.x1 + wr)); x++) {
        const floorY = g.floor + (fbm1(x / 30, s + 21, 2) - 0.5) * 24
        mask[y * WORLD_W + x] = y >= floorY ? 1 : 0
      }
    }
    if (g.bridge) {
      const c = (g.x0 + g.x1) / 2
      const half = (g.x1 - g.x0) / 2 + 26
      for (let x = Math.floor(c - half); x <= Math.ceil(c + half); x++) {
        if (x < 0 || x >= WORLD_W) continue
        const u = (x - c) / half
        const top = g.bridge.top + (1 - u * u) * 6 + (fbm1(x / 14, s + 23, 2) - 0.5) * 4
        const bottom = top + g.bridge.thick + u * u * Math.sqrt(Math.abs(u)) * 80
        for (let y = Math.floor(top); y < Math.min(WORLD_H, Math.ceil(bottom)); y++) mask[y * WORLD_W + x] = 1
      }
    }
  }
  // guarantee clear, solid landing pads
  for (const pad of pads) {
    for (let x = pad.x - 12; x <= pad.x + 12; x++) {
      if (x < 0 || x >= WORLD_W) continue
      for (let y = 0; y < pad.y; y++) mask[y * WORLD_W + x] = 0
      for (let y = pad.y; y < Math.min(WORLD_H, pad.y + 30); y++) mask[y * WORLD_W + x] = 1
    }
  }
  supportIslands(mask)
  removeIslands(mask)
  return mask
}

// Large disconnected masses (a cave that cut across a whole hillside) get natural rock
// pillars down to the ground instead of being deleted; small debris is removed afterwards.
function supportIslands(mask: Mask): void {
  for (const island of findIslands(mask)) {
    if (island.count < 1500) continue
    const bottom = new Int32Array(island.w).fill(-1)
    for (const i of island.pixels) {
      const x = i % WORLD_W
      const y = (i - x) / WORLD_W
      if (y > bottom[x - island.x]!) bottom[x - island.x] = y
    }
    const cols: number[] = []
    for (let lx = 12; lx < island.w - 6; lx += 80) cols.push(lx)
    if (cols.length === 0) cols.push(Math.floor(island.w / 2))
    for (const lx of cols) {
      let best = -1
      for (let d = 0; d < 20 && best < 0; d++) {
        if (lx + d < island.w && bottom[lx + d]! >= 0) best = lx + d
        else if (lx - d >= 0 && bottom[lx - d]! >= 0) best = lx - d
      }
      if (best < 0) continue
      const x = island.x + best
      const g = columnGround(mask, x, bottom[best]! + 1)
      if (g >= WORLD_H) continue
      for (let y = bottom[best]! - 2; y < g + 2; y++) {
        const w = 5 + Math.round(((y - bottom[best]!) / Math.max(1, g - bottom[best]!)) * 4)
        for (let xx = x - w; xx <= x + w; xx++) if (xx >= 0 && xx < WORLD_W && y >= 0 && y < WORLD_H) mask[y * WORLD_W + xx] = 1
      }
    }
  }
}

function ellipse(mask: Mask, cx: number, cy: number, rx: number, ry: number, s: number): void {
  for (let y = Math.floor(cy - ry - 4); y <= Math.ceil(cy + ry + 4); y++) {
    for (let x = Math.floor(cx - rx - 4); x <= Math.ceil(cx + rx + 4); x++) {
      if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) continue
      const dx = (x - cx) / rx
      const dy = (y - cy) / ry
      const wobble = (noise2(x / 9, y / 9, s + 77) - 0.5) * 0.35
      if (dx * dx + dy * dy < 1 + wobble) mask[y * WORLD_W + x] = 0
    }
  }
}

export function removeIslands(mask: Mask): number {
  let removed = 0
  for (const island of findIslands(mask)) {
    for (const i of island.pixels) mask[i] = 0
    removed += island.count
  }
  return removed
}

export interface Battlefield {
  biome: Biome
  mask: Mask
  // spawn x positions, left to right
  spawns: number[]
}

export function generateBattle(seed: number, count: number, biome: Biome = pickBiome(seed)): Battlefield {
  const r = rng(seed)
  const s = (seed ^ 0x5bd1e995) | 0
  const p = profileFor(biome, r, s)
  const spawns = chooseSpawns(p, rng(seed ^ 0x9e3779b9), count).sort((a, b) => a - b)
  return { biome, mask: buildMask(p, r, s, spawns), spawns }
}

export function spawnPoints(seed: number, count: number): number[] {
  return generateBattle(seed, count).spawns
}

// legacy entry point: terrain for the seed's biome with pads at the given xs
export function generateTerrain(seed: number, spawnXs: number[]): Mask {
  const r = rng(seed)
  const s = (seed ^ 0x5bd1e995) | 0
  return buildMask(profileFor(pickBiome(seed), r, s), r, s, spawnXs)
}

export function spawnY(mask: Mask, x: number): number {
  return footGround(mask, x, 0) - UNIT_BODY
}

export function roundWind(seed: number): number {
  const r = rng(seed ^ 0x51ed270b)
  return Math.round((r() * 2 - 1) * 40)
}

// seeded random walk; a fresh gust direction can kick in occasionally
export function nextWind(prev: number, seed: number): number {
  const r = rng(seed ^ 0x51ed270b)
  const gust = r() < 0.15 ? (r() * 2 - 1) * 30 : 0
  const step = (r() + r() + r() - 1.5) * 14
  return Math.round(Math.max(-45, Math.min(45, prev * 0.9 + step + gust)))
}

export function packMask(mask: Mask): string {
  return packBits(mask)
}

export function unpackMask(data: string): Mask {
  return unpackBits(data, WORLD_W * WORLD_H)
}

export function packBits(bits: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8))
  for (let i = 0; i < bits.length; i++) if (bits[i] === 1) bytes[i >> 3] |= 1 << (i & 7)
  let s = ""
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(s)
}

export function unpackBits(data: string, length: number): Uint8Array {
  const s = atob(data)
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (s.charCodeAt(i >> 3) >> (i & 7)) & 1
  return out
}
