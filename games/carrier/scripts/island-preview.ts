/**
 * Island previews and concept comparisons, rendered on the CPU (scripts/raster.ts) with a depth-shaded water plane:
 * pale aqua shallows → turquoise → cobalt by seabed depth, darker coral patches, a thin shore foam line.
 *
 *   bun scripts/island-preview.ts compare          → concept/islands-compare-<kind>.png (concept | render) for the six
 *                                                    kinds, plus jungle-hero, atoll-high, cliffs-low and archipelago
 *   SEED=7 bun scripts/island-preview.ts world     → concept/islands-<seed>.png (top-down map) and -view.png (oblique)
 *   ONLY=jungle bun scripts/island-preview.ts compare   one comparison only
 *   SEED=7 bun scripts/island-preview.ts cams      → `?seed&cam` queries for real-game captures: the jungle hero (the
 *                                                    big jungle island, facing its main bay) and the archipelago view
 */
import { DEEP, coralAt, islandBlobs, islandFootprint, makeArchipelago, terrainHeight, type Archipelago, type Island, type IslandKind } from "../shared/islands"
import { buildIslandMesh, countTriangles, type StaticChunk } from "../src/render/island-mesh"
import { VERT_BYTES } from "../src/render/mesh"
import { DEFAULT_LIGHT, Target, blit, drawMesh, makeImage, orbit, ortho, readPng, resample, text, writePng, type Camera, type Image, type Light, type Vec3 } from "./raster"

const dir = new URL("../concept/", import.meta.url).pathname
const mode = process.argv[2] ?? "compare"

// Sun as in src/render/atmosphere.ts: azimuth 32° (clockwise from north), elevation 38°.
const az = (32 * Math.PI) / 180
const el = (38 * Math.PI) / 180
const LIGHT: Light = {
  ...DEFAULT_LIGHT,
  sun: [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)],
  sunColor: [1.25, 1.17, 1.02],
  sky: [0.62, 0.74, 0.92],
  ground: [0.42, 0.4, 0.34],
  ambient: 0.68,
}

function half(h: number): number {
  const e = (h >> 10) & 31
  const m = h & 1023
  const s = h & 0x8000 ? -1 : 1
  if (e === 0) return s * m * 2 ** -24
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

/** Unpacks chunk vertices back to build-time floats, split into solid and foliage. */
function unpack(chunks: StaticChunk[]): { solid: Float32Array; foliage: Float32Array } {
  const solid: number[] = []
  const foliage: number[] = []
  for (const c of chunks) {
    const f = new Float32Array(c.data)
    const i8 = new Int8Array(c.data)
    const u8 = new Uint8Array(c.data)
    const u16 = new Uint16Array(c.data)
    const n = c.data.byteLength / VERT_BYTES
    for (let v = 0; v < n; v += 3) {
      const mat = half(u16[(v * VERT_BYTES + 20) / 2]!)
      const out = Math.round(mat) === 2 ? foliage : solid
      for (let k = 0; k < 3; k++) {
        const o = (v + k) * VERT_BYTES
        out.push(f[o / 4]!, f[o / 4 + 1]!, f[o / 4 + 2]!, i8[o + 12]! / 127, i8[o + 13]! / 127, i8[o + 14]! / 127, u8[o + 16]! / 255, u8[o + 17]! / 255, u8[o + 18]! / 255, mat, 0)
      }
    }
  }
  return { solid: Float32Array.from(solid), foliage: Float32Array.from(foliage) }
}

// Sampled from the concepts: pale aqua at the waterline, turquoise shelf, cobalt deep sea.
const WATER: [number, Vec3][] = [
  [0, [0.64, 0.95, 0.88]],
  [1, [0.42, 0.91, 0.87]],
  [2.5, [0.2, 0.83, 0.85]],
  [4.5, [0.12, 0.73, 0.83]],
  [8, [0.08, 0.6, 0.81]],
  [15, [0.07, 0.46, 0.78]],
  [30, [0.07, 0.37, 0.74]],
  [60, [0.06, 0.3, 0.68]],
]
const lin = (c: number) => Math.pow(c, 2.2)

function waterColour(depth: number, coral: number): Vec3 {
  let k = 0
  while (k < WATER.length - 2 && depth > WATER[k + 1]![0]) k++
  const [d0, c0] = WATER[k]!
  const [d1, c1] = WATER[k + 1]!
  const t = Math.min(1, Math.max(0, (depth - d0) / (d1 - d0)))
  const c: Vec3 = [0, 0, 0]
  for (let i = 0; i < 3; i++) c[i] = lin(c0[i]! + (c1[i]! - c0[i]!) * t)
  if (coral > 0) {
    const cc: Vec3 = [lin(0.15), lin(0.46), lin(0.42)]
    const a = coral * 0.85 * (1 - Math.min(1, depth / 16))
    for (let i = 0; i < 3; i++) c[i] = c[i]! * (1 - a) + cc[i]! * a
  }
  return c
}

const SKY_H: Vec3 = [lin(0.72), lin(0.84), lin(0.95)]
const SKY_Z: Vec3 = [lin(0.22), lin(0.47), lin(0.86)]

/** Draws water over everything the sea plane hides, and sky where the view ray misses the sea. */
function water(t: Target, cam: Camera, arch: Archipelago): void {
  const W = t.w
  const H = t.h
  const aspect = W / H
  const ortho = cam.fovY === 0
  const f = ortho ? 1 / cam.orthoHalf : 1 / Math.tan(cam.fovY / 2)
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const ix = ((px + 0.5) / W) * 2 - 1
      const iy = 1 - ((py + 0.5) / H) * 2
      const dx = (ix * aspect) / f
      const dy = iy / f
      const eye: Vec3 = ortho ? [cam.eye[0] + cam.right[0] * dx + cam.up[0] * dy, cam.eye[1] + cam.right[1] * dx + cam.up[1] * dy, cam.eye[2] + cam.right[2] * dx + cam.up[2] * dy] : cam.eye
      const d: Vec3 = ortho ? cam.fwd : [cam.fwd[0] + cam.right[0] * dx + cam.up[0] * dy, cam.fwd[1] + cam.right[1] * dx + cam.up[1] * dy, cam.fwd[2] + cam.right[2] * dx + cam.up[2] * dy]
      const i = py * W + px
      const len = Math.hypot(d[0], d[1], d[2])
      if (d[1] >= -1e-4) {
        if (t.depth[i]! < Infinity) continue
        const up = Math.max(0, d[1] / len)
        const k = Math.pow(up, 0.5)
        for (let c = 0; c < 3; c++) t.color[i * 3 + c] = SKY_H[c]! * (1 - k) + SKY_Z[c]! * k
        continue
      }
      const s = -eye[1] / d[1]
      if (s >= t.depth[i]!) continue
      const x = eye[0] + d[0] * s
      const z = eye[2] + d[2] * s
      const h = terrainHeight(arch, x, z)
      const depth = Math.max(0, -h)
      let col = waterColour(depth, depth > 0.3 && h > DEEP ? coralAt(arch, x, z) : 0)
      if (depth < 0.45) {
        const a = 0.75 * (1 - depth / 0.45)
        col = [col[0] * (1 - a) + a, col[1] * (1 - a) + a, col[2] * (1 - a) + a]
      }
      const fres = Math.pow(1 - Math.min(1, -d[1] / len), 5) * 0.35
      const dist = ortho ? 0 : s * len
      const fog = 1 - Math.exp(-dist * 2.5e-5)
      for (let c = 0; c < 3; c++) {
        const v = col[c]! * (1 - fres) + SKY_H[c]! * fres
        t.color[i * 3 + c] = v * (1 - fog) + SKY_H[c]! * fog
      }
    }
  }
}

function fogMesh(t: Target, cam: Camera): void {
  if (cam.fovY === 0) return
  for (let i = 0; i < t.w * t.h; i++) {
    const d = t.depth[i]!
    if (d === Infinity) continue
    const fog = 1 - Math.exp(-d * 2.5e-5)
    for (let c = 0; c < 3; c++) t.color[i * 3 + c] = t.color[i * 3 + c]! * (1 - fog) + SKY_H[c]! * fog
  }
  void cam
}

function render(arch: Archipelago, geo: { solid: Float32Array; foliage: Float32Array }, cam: Camera, w: number, h: number, ss = 2): Image {
  const t = new Target(w * ss, h * ss, [0, 0, 0])
  t.color.fill(0)
  drawMesh(t, cam, geo.solid, LIGHT, undefined, -Infinity, true)
  drawMesh(t, cam, geo.foliage, LIGHT, undefined, -Infinity, false)
  fogMesh(t, cam)
  water(t, cam, arch)
  return t.resolve(ss)
}

function single(kind: IslandKind, radius: number, peak: number, seed: number): Archipelago {
  const island: Island = { x: 0, z: 0, radius, peak, kind, seed }
  return { seed, islands: [island], bounds: [-3200, -3200, 3200, 3200] }
}

function sideBySide(a: Image, b: Image, label: string): Image {
  const out = makeImage(a.w + b.w + 12, Math.max(a.h, b.h) + 28, [24, 24, 28])
  blit(out, a, 0, 28)
  blit(out, b, a.w + 12, 28)
  text(out, `CONCEPT | RENDER  ${label}`, 8, 6, 3, [230, 230, 230])
  return out
}

type Shot = { name: string; concept: [string, number, number, number, number]; arch: () => Archipelago; cam: (arch: Archipelago) => Camera; size: [number, number] }

// Panels of concept/island-1-kinds.png (1536 x 1024).
const P1: Record<string, [number, number, number, number]> = {
  cay: [27, 27, 469, 435],
  jungle: [533, 27, 470, 435],
  atoll: [1040, 27, 469, 435],
  stacks: [27, 513, 469, 444],
  cliff: [533, 513, 470, 444],
  volcanic: [1040, 513, 469, 444],
}

/**
 * Orbit camera framing an island: distance = footprint extent × k. Azimuth is in degrees from +z; `face` turns it so
 * the island's special sector (volcanic lava side, cliff cove) faces the camera.
 */
function framed(arch: Archipelago, az: number, elev: number, k: number, fov: number, lift = 0, back = 0, face = false): Camera {
  const island = arch.islands[0]!
  const e = islandFootprint(island).extent
  if (face) {
    const b = islandBlobs(island)[0]!
    // Sector angle is in the blob's local frame: world direction = (cos(s)·cos - sin(s)·sin, …).
    // Jungle islands face their main (first, deepest) bay; volcanic and cliff islands their special sector.
    const s = b.kind === "jungle" && b.coves.length ? b.coves[0]! : b.sector
    const wx = Math.cos(s) * b.cos * b.sx - Math.sin(s) * b.sin * b.sy
    const wz = Math.cos(s) * b.sin * b.sx + Math.sin(s) * b.cos * b.sy
    az += (Math.atan2(wx, wz) * 180) / Math.PI
  }
  const a = (az * Math.PI) / 180
  return orbit([-Math.sin(a) * back * e, lift, -Math.cos(a) * back * e], az, elev, e * k, fov)
}

const shots: Shot[] = [
  { name: "cay", concept: ["island-1-kinds.png", ...P1.cay!], arch: () => single("cay", 70, 4, 3), cam: (a) => framed(a, -35, 52, 4.6, 38), size: [469, 435] },
  { name: "jungle", concept: ["island-1-kinds.png", ...P1.jungle!], arch: () => single("jungle", 170, 140, 11), cam: (a) => framed(a, -20, 48, 3.2, 38, 30, 0, true), size: [470, 435] },
  { name: "atoll", concept: ["island-1-kinds.png", ...P1.atoll!], arch: () => single("atoll", 420, 3.2, 5), cam: (a) => framed(a, -35, 55, 3.3, 38), size: [469, 435] },
  { name: "stacks", concept: ["island-1-kinds.png", ...P1.stacks!], arch: () => single("stacks", 90, 80, 21), cam: (a) => framed(a, -35, 46, 3.6, 38, 15), size: [469, 444] },
  { name: "cliff", concept: ["island-1-kinds.png", ...P1.cliff!], arch: () => single("cliff", 130, 100, 8), cam: (a) => framed(a, -30, 46, 3.4, 38, 30, 0, true), size: [470, 444] },
  { name: "volcanic", concept: ["island-1-kinds.png", ...P1.volcanic!], arch: () => single("volcanic", 380, 300, 4), cam: (a) => framed(a, 40, 42, 3, 38, 90, 0, true), size: [469, 444] },
  { name: "jungle-hero", concept: ["island-2-jungle-hero.png", 0, 40, 1536, 984], arch: () => single("jungle", 330, 190, 11), cam: (a) => framed(a, 0, 30, 1.85, 50, 20, 0.15, true), size: [768, 492] },
  { name: "atoll-high", concept: ["island-3-atoll.png", 0, 40, 1536, 984], arch: () => single("atoll", 480, 3.4, 5), cam: (a) => framed(a, 0, 58, 1.55, 50), size: [768, 492] },
  { name: "cliffs-low", concept: ["island-4-cliffs-low.png", 0, 40, 1536, 984], arch: () => single("cliff", 170, 115, 8), cam: (a) => framed(a, 25, 6, 1.7, 50, 45, 0, true), size: [768, 492] },
]

async function compare(): Promise<void> {
  const only = process.env.ONLY
  for (const s of shots) {
    if (only && !s.name.startsWith(only)) continue
    const t0 = performance.now()
    const arch = s.arch()
    const chunks = buildIslandMesh(arch)
    const geo = unpack(chunks)
    const [w, h] = s.size
    const img = render(arch, geo, s.cam(arch), w, h)
    const [file, cx, cy, cw, ch] = s.concept
    const src = await readPng(dir + file)
    const crop = resample(src, cx, cy, cw, ch, w, h)
    await writePng(`${dir}islands-compare-${s.name}.png`, sideBySide(crop, img, s.name.toUpperCase()))
    console.log(`${s.name}: ${countTriangles(chunks)} tris, ${(performance.now() - t0).toFixed(0)} ms → concept/islands-compare-${s.name}.png`)
  }
  if (!only || only === "archipelago") await archipelagoShot(Number(process.env.SEED ?? 7))
}

/** World view like concept/island-5: high over the spawn, looking north at the centrepiece. */
async function archipelagoShot(seed: number): Promise<void> {
  const t0 = performance.now()
  const arch = makeArchipelago(seed)
  const chunks = buildIslandMesh(arch)
  const geo = unpack(chunks)
  const c = arch.islands[0]!
  const w = 768
  const h = 492
  // From over the spawn toward the centrepiece, like island-5.
  const cam = orbit([c.x * 0.62, 0, c.z * 0.62], (Math.atan2(-c.x, -c.z) * 180) / Math.PI, 27, 2300, 50)
  const img = render(arch, geo, cam, w, h)
  const src = await readPng(dir + "island-5-archipelago.png")
  await writePng(`${dir}islands-compare-archipelago.png`, sideBySide(resample(src, 0, 40, 1536, 984, w, h), img, `ARCHIPELAGO SEED ${seed}`))
  console.log(`archipelago seed ${seed}: ${arch.islands.length} islands, ${countTriangles(chunks)} tris, ${(performance.now() - t0).toFixed(0)} ms`)
}

/** Top-down map of a whole world plus an oblique view from the spawn. */
async function world(seed: number): Promise<void> {
  const arch = makeArchipelago(seed)
  const t0 = performance.now()
  const chunks = buildIslandMesh(arch)
  const built = performance.now() - t0
  const geo = unpack(chunks)
  const size = Number(process.env.SIZE ?? 1600)
  const [x0, z0, x1, z1] = arch.bounds
  const span = Math.max(x1 - x0, z1 - z0)
  // Orthographic top-down, north (-z) up.
  const top = ortho([0, -1, 0], [(x0 + x1) / 2, 0, (z0 + z1) / 2], span / 2, [0, 0, -1])
  const map = render(arch, geo, top, size, size, 1)
  await writePng(`${dir}islands-${seed}.png`, map)
  const c = arch.islands[0]!
  const view = render(arch, geo, orbit([c.x * 0.7, 0, c.z * 0.7], (Math.atan2(-c.x, -c.z) * 180) / Math.PI, 18, 2400, 50), 1280, 820)
  await writePng(`${dir}islands-${seed}-view.png`, view)
  const kinds = arch.islands.map((i) => i.kind).join(", ")
  console.log(`seed ${seed}: ${arch.islands.length} islands (${kinds}); ${countTriangles(chunks)} tris in ${chunks.length} chunks, built in ${built.toFixed(0)} ms`)
}

/** Real-game camera queries (`?cam=x,z,yaw,pitch,dist`, yaw 0 looks north, 90 east) matching the concept views. */
function cams(seed: number): void {
  const arch = makeArchipelago(seed)
  const c = arch.islands[0]!
  // Archipelago: over the spawn side of the centrepiece, looking at it (island-5).
  const yawC = (Math.atan2(c.x, -c.z) * 180) / Math.PI
  console.log(`archipelago seed=${seed}&t=120&cam=${Math.round(c.x * 0.55)},${Math.round(c.z * 0.55)},${yawC.toFixed(1)},22,2900`)
  // Far top-down over the centrepiece's group: reef outlines and surf from ~4 km up.
  console.log(`topdown seed=${seed}&t=120&cam=${Math.round(c.x * 0.7)},${Math.round(c.z * 0.7)},0,85,4000`)
  // Jungle hero: the biggest jungle island, camera on the side of its main bay (island-2).
  const j = [...arch.islands].filter((i) => i.kind === "jungle").sort((a, b) => b.radius - a.radius)[0]
  if (!j) return
  const b = islandBlobs(j)[0]!
  const s = b.coves[0] ?? 0
  const wx = Math.cos(s) * b.cos * b.sx - Math.sin(s) * b.sin * b.sy
  const wz = Math.cos(s) * b.sin * b.sx + Math.sin(s) * b.cos * b.sy
  // The camera sits on the bay side, so it looks along -(wx, wz): yaw = atan2(-wx, wz).
  const yaw = (Math.atan2(-wx, wz) * 180) / Math.PI
  const dist = islandFootprint(j).extent * 2.6
  console.log(`jungle-hero seed=${seed}&t=120&cam=${j.x},${j.z},${yaw.toFixed(1)},30,${Math.round(dist)}`)
}

if (mode === "world") await world(Number(process.env.SEED ?? 7))
else if (mode === "cams") cams(Number(process.env.SEED ?? 7))
else await compare()
