// Renders the carrier model on the CPU from the same views as the concept sheets and writes side-by-side comparisons.
//   bun scripts/carrier-preview.ts [hero|yaw|turn|pitch|zoom|all]   (default all)
// Outputs concept/model-*.png. Cameras are fitted to landmarks measured on the references (see FIT_* below).
import { APRON_LINE_X, BOW_NOTCH, BOW_Z, DECK_X0, DECK_X1, DECK_Y, STERN_Z } from "../shared/carrier-spec"
import { buildCarrier, RADAR_PIVOT } from "../src/render/carrier-mesh"
import { hex } from "../src/render/deck-vehicles"
import { Mesh } from "../src/render/mesh"
import {
  blit,
  type Camera,
  drawMesh,
  type Image,
  type Light,
  lookAt,
  makeImage,
  minimize,
  ortho,
  project,
  readPng,
  resample,
  Target,
  text,
  type Vec3,
  writePng,
} from "./raster"

const ROOT = new URL("..", import.meta.url).pathname
const C = (f: string) => `${ROOT}concept/${f}`
const what = process.argv[2] ?? "all"
const SS = 2

// ---------------------------------------------------------------------------------------------------------------------
// Model in ship space: hull + radar (at a fixed spin) + vehicles at their parking spots.

const RADAR_SPIN = 0.5
const carrier = buildCarrier()

function transformed(src: number[], yaw: number, tx: number, ty: number, tz: number): number[] {
  const out = src.slice()
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  for (let i = 0; i < out.length; i += 11) {
    const x = out[i]!
    const z = out[i + 2]!
    out[i] = x * c + z * s + tx
    out[i + 1]! += ty
    out[i + 2] = -x * s + z * c + tz
    const nx = out[i + 3]!
    const nz = out[i + 5]!
    out[i + 3] = nx * c + nz * s
    out[i + 5] = -nx * s + nz * c
  }
  return out
}

const ship: number[] = carrier.hull.v.slice()
ship.push(...transformed(carrier.radar.v, RADAR_SPIN, ...carrier.radarPivot))
for (const v of carrier.vehicles) ship.push(...transformed(v.mesh.v, v.yaw, v.x, DECK_Y, v.z))
console.log(`triangles: ${carrier.triangles} (hull ${carrier.hull.count / 3}, radar ${carrier.radar.count / 3})`)

function waterTile(size: number, depth: number, col: number, seed = 1): number[] {
  const m = new Mesh()
  const base = hex(col)
  const n = 10
  const h = size / 2
  let r = seed
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++) {
      const x0 = -h + (i * size) / n
      const x1 = x0 + size / n
      const z0 = -h + (k * size) / n
      const z1 = z0 + size / n
      const t1 = 0.9 + rnd() * 0.2
      const t2 = 0.9 + rnd() * 0.2
      m.facet([x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [base[0] * t1, base[1] * t1, base[2] * t1])
      m.facet([x0, 0, z1], [x1, 0, z0], [x0, 0, z0], [base[0] * t2, base[1] * t2, base[2] * t2])
    }
  const side = hex(0x0f8fb0)
  m.box(-h, -depth, -h, h, -0.01, h, side)
  return m.v
}

function render(w: number, h: number, cam: Camera, bg: Vec3, light: Light, draws: { v: number[]; yaw?: number }[]): Image {
  const t = new Target(w * SS, h * SS, bg)
  for (const d of draws) drawMesh(t, cam, d.v, light, d.yaw ? { x: 0, y: 0, z: 0, yaw: d.yaw } : undefined)
  return t.resolve(SS)
}

function sideBySide(a: Image, b: Image, w: number, labels: [string, string]): Image {
  const h = Math.round((a.h / a.w) * w)
  const out = makeImage(w * 2 + 12, h + 40, [30, 30, 34])
  blit(out, resample(a, 0, 0, a.w, a.h, w, h), 0, 40)
  blit(out, resample(b, 0, 0, b.w, b.h, w, h), w + 12, 40)
  text(out, labels[0], 10, 10, 4, [240, 240, 240])
  text(out, labels[1], w + 22, 10, 4, [240, 240, 240])
  return out
}

type Landmark = { p: Vec3; px: [number, number]; w?: number }

/** Fits a perspective camera (eye, heading, pitch, fov) to reference landmarks. */
function fitCamera(lm: Landmark[], w: number, h: number, guess: { eye: Vec3; target: Vec3; fov: number }, horizonY?: number): Camera {
  const make = (x: number[]) => {
    const [ex, ey, ez, hd, pt, fov, roll] = x as [number, number, number, number, number, number, number]
    const dir: Vec3 = [Math.sin(hd) * Math.cos(pt), -Math.sin(pt), Math.cos(hd) * Math.cos(pt)]
    const cam = lookAt([ex, ey, ez], [ex + dir[0], ey + dir[1], ez + dir[2]], fov)
    const c = Math.cos(roll)
    const s = Math.sin(roll)
    const r = cam.right
    const u = cam.up
    cam.right = [r[0] * c + u[0] * s, r[1] * c + u[1] * s, r[2] * c + u[2] * s]
    cam.up = [u[0] * c - r[0] * s, u[1] * c - r[1] * s, u[2] * c - r[2] * s]
    return cam
  }
  const d: Vec3 = [guess.target[0] - guess.eye[0], guess.target[1] - guess.eye[1], guess.target[2] - guess.eye[2]]
  const l = Math.hypot(...d)
  const x0 = [...guess.eye, Math.atan2(d[0], d[2]), Math.asin(-d[1] / l), guess.fov, 0]
  const err = (x: number[]) => {
    if (x[5]! < 5 || x[5]! > 90) return 1e12
    const cam = make(x)
    let e = 0
    for (const m of lm) {
      const p = project(cam, w, h, m.p)
      if (!p) return 1e12
      e += (m.w ?? 1) * ((p[0] - m.px[0]) ** 2 + (p[1] - m.px[1]) ** 2)
    }
    if (horizonY !== undefined) {
      const far = project(cam, w, h, [x[0]! + Math.sin(x[3]!) * 1e6, 0, x[2]! + Math.cos(x[3]!) * 1e6])
      if (!far) return 1e12
      e += 2 * (far[1] - horizonY) ** 2
    }
    return e
  }
  let best = x0
  for (let round = 0; round < 4; round++) best = minimize(err, best, [40, 40, 40, 0.2, 0.2, 5, 0.05], 3000)
  const cam = make(best)
  const rms = Math.sqrt(err(best) / lm.reduce((s, m) => s + (m.w ?? 1), 0))
  console.log(`  fit rms ${rms.toFixed(1)} px  eye ${best.slice(0, 3).map((v) => v.toFixed(0))} heading ${((best[3]! * 180) / Math.PI).toFixed(1)} pitch ${((best[4]! * 180) / Math.PI).toFixed(1)} fov ${best[5]!.toFixed(1)} roll ${((best[6]! * 180) / Math.PI).toFixed(1)}`)
  for (const m of lm) {
    const p = project(cam, w, h, m.p)!
    console.log(`    ${m.p.map((v) => v.toFixed(0)).join(",")} -> ${p.map((v) => v.toFixed(0)).join(",")} (ref ${m.px.join(",")})`)
  }
  return cam
}

// ---------------------------------------------------------------------------------------------------------------------
// Hero (carrier-1-hero.png): three-quarter from ahead of the bow, port side, over a blue sea.

// The concept sheets are drawn mirror-handed (island on the ship's port side in a true view; see carrier-spec.ts). The
// model is built true-handed, so every comparison flips the reference horizontally (per cell or per view on the
// sheets) and renders the model from the mirror image of the camera fitted to the reference. Pixel landmarks below
// were measured on the original images and are flipped with `flipX`.
const flipX = (w: number, x: number, y: number): [number, number] => [w - x, y]

/** Horizontally mirrors the rectangle [x0, x0 + w) x [y0, y0 + h) of `img` in place. */
function flipRegion(img: Image, x0: number, y0: number, w: number, h: number): void {
  const xs = Math.max(0, Math.round(x0))
  const xe = Math.min(img.w, Math.round(x0 + w))
  for (let y = Math.max(0, y0); y < Math.min(img.h, y0 + h); y++)
    for (let i = 0; i < (xe - xs) >> 1; i++) {
      const a = (y * img.w + xs + i) * 4
      const b = (y * img.w + xe - 1 - i) * 4
      for (let k = 0; k < 4; k++) {
        const t = img.data[a + k]!
        img.data[a + k] = img.data[b + k]!
        img.data[b + k] = t
      }
    }
}

async function mirroredRef(file: string, regions?: [number, number, number, number][]): Promise<Image> {
  const img = await readPng(C(file))
  for (const r of regions ?? [[0, 0, img.w, img.h]]) flipRegion(img, ...r)
  return img
}

const zTop = BOW_Z - BOW_NOTCH
/** Hero landmarks: true ship points (+X port) against the flipped reference. The reference's runway-side (left) deck
 *  edge is the true port edge (+X). */
const HERO_LM: Landmark[] = [
  { p: [DECK_X1, DECK_Y, zTop], px: flipX(1536, 548, 688) },
  { p: [DECK_X0, DECK_Y, zTop], px: flipX(1536, 1222, 652) },
  { p: [DECK_X1, DECK_Y, STERN_Z], px: flipX(1536, 452, 245) },
  { p: [DECK_X0, DECK_Y, STERN_Z], px: flipX(1536, 820, 245), w: 0.3 },
  { p: [DECK_X1 - 2, DECK_Y, zTop - 1.5], px: flipX(1536, 553, 684) },
  { p: [APRON_LINE_X, DECK_Y, zTop - 1.5], px: flipX(1536, 978, 666) },
]

const SEA_LIGHT: Light = { sun: norm([-0.25, 0.85, -0.45]), sunColor: [1.05, 1.0, 0.92], sky: [0.55, 0.68, 0.9], ground: [0.25, 0.32, 0.42], ambient: 0.75 }

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(...v)
  return [v[0] / l, v[1] / l, v[2] / l]
}

async function hero() {
  console.log("hero")
  const W = 1536
  const H = 1024
  const cam = fitCamera(HERO_LM, W, H, { eye: [60, 160, 420], target: [0, 0, -20], fov: 40 })
  const sea = waterTile(4000, 1, 0x1f6fc0)
  const img = render(W, H, cam, [120, 180, 235], SEA_LIGHT, [{ v: sea }, { v: ship }])
  await writePng(C("model-hero.png"), img)
  const ref = await mirroredRef("carrier-1-hero.png")
  await writePng(C("model-compare-hero.png"), sideBySide(ref, img, 1000, ["REFERENCE MIRRORED", "MODEL"]))
  return { cam, img, ref }
}

// ---------------------------------------------------------------------------------------------------------------------
// Yaw strip (carrier-3-yaw-strip.png): 8 rotations on a turquoise water tile, fixed camera ~35° down.

const YAW_TILE = 345
const YAW_CELLS = [0, 45, 90, 135, 180, 225, 270, 315].map((a, i) => ({ a, row: i < 4 ? 0 : 1 }))
const CELL_W = 384
const CELL_H = 512
const YAW_ROW_Y = [0, 445]
/** Deck corners measured in the reference's 90° cell (cell-local pixels: the cell starts at x = 768), flipped within the
 *  cell; the cell's far (runway) edge is the true port edge (+X). */
const YAW_LM: Landmark[] = [
  { p: [DECK_X1, DECK_Y, zTop], px: flipX(CELL_W, 783 - 768, 193) },
  { p: [DECK_X1, DECK_Y, STERN_Z], px: flipX(CELL_W, 1115 - 768, 192) },
  { p: [DECK_X0, DECK_Y, STERN_Z], px: flipX(CELL_W, 1122 - 768, 248) },
  { p: [DECK_X0, DECK_Y, zTop], px: flipX(CELL_W, 772 - 768, 244) },
]

const YAW_DIST = 900
const YAW_SHIFT_Y = -0.02

/** Orbit camera for one yaw cell: azimuth from the bow toward starboard (−X; the reference's rotation angle, whose
 *  "starboard" is the island side). */
function yawCamera(x: number[], az: number): Camera {
  const [elev, dist, fov, ty, sx, sy] = x as [number, number, number, number, number, number]
  const a = (az * Math.PI) / 180
  const e = (elev * Math.PI) / 180
  const t: Vec3 = [0, ty, 0]
  const cam = lookAt([-Math.sin(a) * Math.cos(e) * dist, ty + Math.sin(e) * dist, Math.cos(a) * Math.cos(e) * dist], t, fov)
  cam.shift = [sx, sy]
  return cam
}

function fitYaw(): number[] {
  const err = (x: number[]) => {
    if (x[2]! < 5 || x[2]! > 80 || x[0]! < 5 || x[0]! > 80) return 1e12
    const cam = yawCamera(x, 90)
    let e = 0
    for (const m of YAW_LM) {
      const p = project(cam, CELL_W, CELL_H, m.p)
      if (!p) return 1e12
      e += (p[0] - m.px[0]) ** 2 + (p[1] - m.px[1]) ** 2
    }
    return e
  }
  let best = [30, 900, 25, 10, 0, 0]
  for (let r = 0; r < 4; r++) best = minimize(err, best, [5, 100, 5, 5, 0.05, 0.05], 3000)
  console.log(`  fit rms ${Math.sqrt(err(best) / YAW_LM.length).toFixed(1)} px  elev ${best[0]!.toFixed(1)} dist ${best[1]!.toFixed(0)} fov ${best[2]!.toFixed(1)} ty ${best[3]!.toFixed(1)}`)
  return best
}

async function yawStrip() {
  console.log("yaw strip")
  const best = fitYaw()
  const tile = waterTile(YAW_TILE, 8, 0x1aa6c4)
  const light: Light = { sun: norm([-0.55, 0.75, 0.45]), sunColor: [1, 0.98, 0.94], sky: [0.7, 0.74, 0.8], ground: [0.35, 0.36, 0.38], ambient: 0.7 }
  const out = makeImage(1536, 1024, [208, 209, 211])
  const ref = await mirroredRef(
    "carrier-3-yaw-strip.png",
    YAW_CELLS.map((cell, i): [number, number, number, number] => [(i % 4) * CELL_W, YAW_ROW_Y[cell.row]!, CELL_W, cell.row ? 1024 - YAW_ROW_Y[1]! : YAW_ROW_Y[1]!]),
  )
  // The sheet is not one consistent camera: its deck outlines imply ~44° down (the fit above), its freeboard and island
  // heights ~25-30°, and every cell is framed a little differently. So all cells use one orbit camera 34° down, at a
  // distance where the broadside deck spans the reference's 90° cell, centred like the reference ships.
  const x = [34, YAW_DIST, best[2]!, 0, 0, YAW_SHIFT_Y]
  YAW_CELLS.forEach((cell, i) => {
    const ox = (i % 4) * CELL_W
    const oy = YAW_ROW_Y[cell.row]!
    // The water tile turns with the camera, so it reads as the fixed diorama base of the reference with the ship rotating on it.
    const img = render(CELL_W, CELL_H, yawCamera(x, cell.a), [208, 209, 211], light, [{ v: tile, yaw: (-cell.a * Math.PI) / 180 }, { v: ship }])
    blit(out, resample(img, 0, 0, CELL_W, Math.min(CELL_H, 1024 - oy), CELL_W, Math.min(CELL_H, 1024 - oy)), ox, oy)
    text(out, `${cell.a}°`, ox + 170, oy + 420, 3, [60, 60, 64])
  })
  await writePng(C("model-yaw-strip.png"), out)
  await writePng(C("model-compare-yaw.png"), sideBySide(ref, out, 1000, ["REFERENCE CELLS MIRRORED", "MODEL"]))
  // Cell-by-cell pairs, enlarged.
  for (const row of [0, 1]) {
    const pair = makeImage(4 * 2 * 300 + 30, 2 * 330 + 10, [30, 30, 34])
    for (let c = 0; c < 4; c++) {
      const sx = c * CELL_W + 20
      const sy = YAW_ROW_Y[row]! + 60
      const k = 300 / 344
      blit(pair, resample(ref, sx, sy, 344, 380, 300, Math.round(380 * k)), c * 610, 0)
      blit(pair, resample(out, sx, sy, 344, 380, 300, Math.round(380 * k)), c * 610 + 302, 0)
    }
    await writePng(C(`model-compare-yaw-row${row}.png`), pair)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Turnaround (carrier-2-turnaround.png): orthographic TOP, PORT, STARBOARD, BOW, STERN, laid out like the reference.

/** True-handed views of the mirrored reference views: TOP with starboard (the island) up and the bow left, PORT seen
 *  from +X (bow left), STARBOARD from −X (bow right). Reference anchors per view (each elevation has its own scale): pixels per metre, and the image point
 *  where the deck surface at the view's centre lands (x = deck mid-length or centreline). */
const TURN_VIEWS = [
  { label: "TOP", dir: [0, -1, 0], up: [-1, 0, 0], ppm: 1413 / 330, cx: 775, cy: 205, w: 1536, h: 410, ly: 32, lx: 45 },
  { label: "PORT", dir: [-1, 0, 0], up: [0, 1, 0], ppm: (1202 - 45) / 330, cx: (1202 + 45) / 2, cy: 548, w: 1300, h: 300, ly: 436, lx: 45 },
  { label: "STARBOARD", dir: [1, 0, 0], up: [0, 1, 0], ppm: (1001 - 28) / 330, cx: (1001 + 28) / 2, cy: 828, w: 1020, h: 300, ly: 702, lx: 45 },
  { label: "BOW", dir: [0, 0, -1], up: [0, 1, 0], ppm: (1250 - 1027) / 76, cx: (1250 + 1027) / 2, cy: 837, w: 250, h: 330, ly: 706, lx: 1057 },
  { label: "STERN", dir: [0, 0, 1], up: [0, 1, 0], ppm: (1514 - 1280) / 76, cx: (1514 + 1280) / 2, cy: 837, w: 250, h: 330, ly: 706, lx: 1328 },
] as const

async function turnaround() {
  console.log("turnaround")
  const bg: Vec3 = [204, 202, 200]
  const light: Light = { sun: norm([0.3, 0.8, 0.5]), sunColor: [0.9, 0.88, 0.85], sky: [0.75, 0.77, 0.8], ground: [0.45, 0.46, 0.48], ambient: 0.85 }
  const out = makeImage(1536, 1024, bg)
  for (const v of TURN_VIEWS) {
    // Ortho camera centred on the anchor: the deck point maps to the middle of a w x h tile placed at (cx, cy).
    const target: Vec3 = v.label === "TOP" ? [0, DECK_Y, 0] : [0, DECK_Y, 0]
    const tileY = v.label === "TOP" ? v.h / 2 : v.h * 0.55
    const cam = ortho([...v.dir] as Vec3, target, v.h / v.ppm / 2, [...v.up] as Vec3)
    cam.shift = [0, v.label === "TOP" ? 0 : -0.1]
    const img = render(v.w, v.h, cam, bg, light, [{ v: ship }])
    blit(out, img, Math.round(v.cx - v.w / 2), Math.round(v.cy - tileY))
    text(out, v.label, v.lx, v.ly, 3, [250, 250, 250])
  }
  await writePng(C("model-turnaround.png"), out)
  // Each reference view is mirrored in place (the sheet's labels with it).
  const ref = await mirroredRef("carrier-2-turnaround.png", [
    [14, 0, 1522, 400],
    [0, 400, 1247, 290],
    [4, 690, 1021, 334],
    [1026, 690, 225, 334],
    [1277, 690, 240, 334],
  ])
  await writePng(C("model-compare-turnaround.png"), sideBySide(ref, out, 1000, ["REFERENCE VIEWS MIRRORED", "MODEL"]))
  // Overlay: reference and model elevations interleaved, for proportion checks.
  const pair = makeImage(1536, 620, [30, 30, 34])
  blit(pair, resample(ref, 0, 420, 1536, 300, 1536, 300), 0, 0)
  blit(pair, resample(out, 0, 420, 1536, 300, 1536, 300), 0, 310)
  await writePng(C("model-compare-turnaround-port.png"), pair)
  const pair2 = makeImage(1536, 620, [30, 30, 34])
  blit(pair2, resample(ref, 0, 690, 1536, 300, 1536, 300), 0, 0)
  blit(pair2, resample(out, 0, 690, 1536, 300, 1536, 300), 0, 310)
  await writePng(C("model-compare-turnaround-low.png"), pair2)
}

// ---------------------------------------------------------------------------------------------------------------------
// Detail crops: reference and model regions side by side, enlarged.

async function zoom(h: { img: Image; ref: Image }) {
  // Regions measured on the original hero, flipped to the mirrored reference and the true-handed render.
  const crops: [string, number, number, number, number][] = [
    ["island", 780, 60, 300, 400],
    ["bow", 420, 560, 860, 360],
    ["apron", 680, 280, 600, 420],
    ["port", 340, 230, 320, 500],
  ]
  for (const [name, x0, y, w, hh] of crops) {
    const x = 1536 - x0 - w
    const k = Math.min(760 / w, 900 / hh)
    const a = resample(h.ref, x, y, w, hh, Math.round(w * k), Math.round(hh * k))
    const b = resample(h.img, x, y, w, hh, Math.round(w * k), Math.round(hh * k))
    const out = makeImage(a.w * 2 + 10, a.h, [30, 30, 34])
    blit(out, a, 0, 0)
    blit(out, b, a.w + 10, 0)
    await writePng(C(`model-compare-hero-${name}.png`), out)
  }
}

// `pick x,y[,height] ...`: ship-space coordinates on the plane y = height (default the deck) under MIRRORED hero reference
// pixels; `pickyaw <cell 0-7> x,y ...` does the same in a yaw-strip cell (image pixels). For measuring the concepts.
if (what === "pick" || what === "pickyaw") {
  const yawCell = what === "pickyaw" ? Number(process.argv[3]) : -1
  const W = yawCell >= 0 ? CELL_W : 1536
  const H = yawCell >= 0 ? CELL_H : 1024
  const ox = yawCell >= 0 ? (yawCell % 4) * CELL_W : 0
  const oy = yawCell >= 0 ? YAW_ROW_Y[yawCell < 4 ? 0 : 1]! : 0
  const cam = yawCell >= 0 ? yawCamera(fitYaw(), yawCell * 45) : fitCamera(HERO_LM, 1536, 1024, { eye: [60, 160, 420], target: [0, 0, -20], fov: 40 })
  const f = 1 / Math.tan(cam.fovY / 2)
  for (const arg of process.argv.slice(yawCell >= 0 ? 4 : 3)) {
    const [px, py, yy = DECK_Y] = arg.split(",").map(Number) as [number, number, number?]
    const ix = ((px - ox) / W - 0.5) * 2 - cam.shift[0]
    const iy = (0.5 - (py - oy) / H) * 2 - cam.shift[1]
    const d: Vec3 = [0, 1, 2].map((k) => cam.fwd[k]! + cam.right[k]! * ((ix * W) / H / f) + cam.up[k]! * (iy / f)) as Vec3
    const t = (yy! - cam.eye[1]) / d[1]
    console.log(`${arg} -> x ${(cam.eye[0] + d[0] * t).toFixed(1)} z ${(cam.eye[2] + d[2] * t).toFixed(1)}`)
  }
}

if (what === "all" || what === "hero" || what === "zoom") {
  const h = await hero()
  if (what !== "hero") await zoom(h)
}
if (what === "all" || what === "yaw") await yawStrip()
if (what === "all" || what === "turn") await turnaround()
