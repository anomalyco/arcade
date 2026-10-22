import { loadGltf } from "@arcade/kit/gpu/gltf"
import { TexturedMeshPass, type TexturedPrimitive } from "@arcade/kit/gpu/textured-mesh"
import { Mesh, hex, MAT, type Rgb } from "@arcade/kit/gpu/mesh"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { SceneHooks } from "@arcade/kit/gpu/shaders"
import type { SpotShadowCaster } from "@arcade/kit/gpu/shadows/spot-shadows"
import { hash01 } from "@arcade/kit/gpu/lights/flicker"
import { COLLEAGUES, box, tube, partitions } from "../world"
import { LOOK_PROP_FILES, type LookPropFile } from "./props-list"

export type Placement = { file: LookPropFile; x: number; y: number; z: number; yaw?: number; pitch?: number; scale?: number }

const DESK = .795
/**
 * Every desk dressed as if its owner left in a hurry: mug, papers, phone, trays, lamps, dead plants, bins and boxes.
 * Colleague CRTs face −z; their free desk space runs away from the aisle (`side`).
 */
export function dressingPlacements(): Placement[] {
  const out: Placement[] = []
  const r = (i: number, k: number) => hash01(i * 13 + 87, k)
  COLLEAGUES.forEach((c, i) => {
    // The free desktop runs from the CRT away from the aisle; binders stand at offsets .26–.65, z −.31…−.09.
    const side = c.x < 0 ? -1 : 1, x = c.x, z = c.z, into = side
    const front = z - .4
    out.push({ file: "mug", x: x + into * (.38 + r(i, 1) * .1), y: DESK, z: front + r(i, 2) * .04, yaw: r(i, 3) * 6 })
    for (let k = 0; k < 2 + Math.floor(r(i, 4) * 3); k++)
      out.push({ file: "paper-sheet", x: x + into * (.75 + r(i, 10 + k) * .3), y: DESK + .0012 * k, z: front + .06 + r(i, 20 + k) * .12, yaw: (r(i, 30 + k) - .5) * 1.4 })
    out.push({ file: "paper-stack", x: x + into * (1.1 + r(i, 5) * .15), y: DESK, z: z + .14, yaw: (r(i, 6) - .5) * .5 })
    out.push({ file: "phone-alt", x: x + into * .82, y: DESK, z: z + .15, yaw: Math.PI + (r(i, 7) - .5) * .5 })
    if (r(i, 8) > .45) out.push({ file: "letter-tray", x: x + into * 1.3, y: DESK, z: z - .12, yaw: Math.PI + (r(i, 9) - .5) * .2 })
    else out.push({ file: "yellow-pad", x: x + into * 1.15, y: DESK + .004, z: front + .1, yaw: (r(i, 9) - .5) * .8 })
    if (i === 1 || i === 4) out.push({ file: "desk-lamp", x: x + into * 1.5, y: DESK, z: z + .2, yaw: Math.PI + side * .5 })
    if (i === 2 || i === 5) out.push({ file: "dead-plant", x: x + into * 1.45, y: DESK, z: z + .2, yaw: r(i, 11) * 6 })
    if (i === 0 || i === 3) out.push({ file: "clipboard", x: x + into * 1.0, y: DESK + .003, z: front + .1, yaw: (r(i, 12) - .5) * .9 })
    if (i % 2 === 0) out.push({ file: "stapler", x: x + into * .6, y: DESK, z: front + .02, yaw: 1.2 + r(i, 13) })
    out.push({ file: "pen-cup-ph", x: x + into * .36, y: DESK, z: z + .07, yaw: 0 })
    out.push({ file: "waste-bin", x: x + into * 1.3, y: 0, z: z - .15, yaw: r(i, 14) * 6 })
    if (r(i, 15) > .4) out.push({ file: "file-box", x: x + into * 1.4, y: 0, z: front - .3, yaw: Math.PI + (r(i, 16) - .5) * .6 })
    // Sticky notes on the bezel, facing the chair.
    out.push({ file: "sticky-note", x: x + side * .2, y: 1.235, z: z - .142, yaw: Math.PI, pitch: -Math.PI / 2 })
    if (r(i, 17) > .5) out.push({ file: "sticky-note", x: x - side * .215, y: 1.05, z: z - .142, yaw: Math.PI + .12, pitch: -Math.PI / 2 })
  })
  // Your own desk: stickies on the bezel, a tray of work, a stapler; the clock on the pillar behind the CRT.
  out.push({ file: "sticky-note", x: -.535, y: 1.2, z: -5.352, yaw: .08, pitch: Math.PI / 2 })
  out.push({ file: "sticky-note", x: -.545, y: 1.11, z: -5.35, yaw: -.12, pitch: Math.PI / 2 })
  out.push({ file: "letter-tray", x: -1.38, y: DESK, z: -5.78, yaw: .1 })
  out.push({ file: "stapler", x: 1.05, y: DESK, z: -5.78, yaw: 2.6 })
  out.push({ file: "waste-bin", x: -1.3, y: 0, z: -5.3, yaw: 1 })
  out.push({ file: "wall-clock", x: -3.2, y: 1.89, z: -5.59, yaw: 0 })
  // Boxes left in the aisles and by Jay's door.
  out.push({ file: "cardboard-box", x: -1.45, y: 0, z: 2.25, yaw: .4 })
  out.push({ file: "file-box", x: 1.55, y: 0, z: -.95, yaw: -.3 })
  out.push({ file: "cardboard-box", x: 2.6, y: 0, z: -6.95, yaw: 1.2 })
  return out
}

type Vertices = { pos: Float32Array; buffer: ArrayBuffer }
/** One placed copy of a primitive: yaw about +y after pitch about +x, then translate. */
function place(source: ArrayBuffer, p: Placement): ArrayBuffer {
  const out = source.slice(0), f = new Float32Array(out), n = new Int8Array(out)
  const cy = Math.cos(p.yaw ?? 0), sy = Math.sin(p.yaw ?? 0), cp = Math.cos(p.pitch ?? 0), sp = Math.sin(p.pitch ?? 0), s = p.scale ?? 1
  for (let i = 0; i < f.length; i += 8) {
    const rot = (x: number, y: number, z: number) => { const y1 = y * cp - z * sp, z1 = y * sp + z * cp; return [cy * x + sy * z1, y1, -sy * x + cy * z1] }
    const q = rot(f[i]! * s, f[i + 1]! * s, f[i + 2]! * s)
    f[i] = p.x + q[0]!; f[i + 1] = p.y + q[1]!; f[i + 2] = p.z + q[2]!
    const j = i * 4 + 12, m = rot(n[j]!, n[j + 1]!, n[j + 2]!), len = Math.hypot(m[0]!, m[1]!, m[2]!) || 1
    n[j] = Math.round(m[0]! / len * 127); n[j + 1] = Math.round(m[1]! / len * 127); n[j + 2] = Math.round(m[2]! / len * 127)
  }
  return out
}
function concat(parts: ArrayBuffer[]): ArrayBuffer {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) { out.set(new Uint8Array(p), at); at += p.byteLength }
  return out.buffer
}

/** Faded 1987 stock: the library's notes are a modern neon yellow. */
const TINT: Partial<Record<LookPropFile, [number, number, number, number]>> = { "sticky-note": [.82, .78, .6, 1] }

export const LOOK_PROP_PATHS = LOOK_PROP_FILES.map(p => `look/props/${p.file}.glb`)

/** Loads the dressing models and merges every placement of a primitive into one draw. */
export async function loadDressing(renderer: Renderer, hooks: SceneHooks, bytes: (path: string) => Promise<Uint8Array>) {
  const device = renderer.passContext.device, placements = dressingPlacements()
  const primitives: TexturedPrimitive[] = []
  await Promise.all(LOOK_PROP_FILES.map(async ({ file }) => {
    const mine = placements.filter(p => p.file === file)
    if (!mine.length) return
    const asset = await loadGltf(device, await bytes(`look/props/${file}.glb`))
    for (const p of asset.primitives) primitives.push({ ...p, color: TINT[file] ?? p.color, vertices: concat(mine.map(m => place(p.vertices, m))) })
  }))
  const pass = new TexturedMeshPass(renderer.passContext, primitives, hooks)
  return { pass, casters: pass.shadowCasters() as SpotShadowCaster[], count: placements.length }
}

const COATS: Rgb[] = [hex(0x2c3442), hex(0x6e5a43), hex(0x3b3a36)]
/** A jacket thrown over a chair back, in the chair's own frame (seat centre at the origin, back toward +z). */
export function coatMesh(variant: number): Mesh {
  const m = new Mesh(), c = COATS[variant % COATS.length]!
  const fold = (x: number, y: number) => .006 * Math.sin(x * 38 + variant) + .004 * Math.sin(y * 27 + x * 9)
  const panel = (z0: number, sign: number, top: number, bottom: number, width: number) => {
    const nx = 10, ny = 6
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const p = (u: number, v: number) => {
        const x = (u / nx - .5) * width * (1 + .12 * (v / ny)), y = top - (top - bottom) * (v / ny)
        return [x, y, z0 + sign * (fold(x, y) + .015 * (v / ny) ** 2)]
      }
      const a = p(i, j), b = p(i + 1, j), cc = p(i + 1, j + 1), d = p(i, j + 1)
      m.quadAuto(...(sign > 0 ? [a, d, cc, b] : [a, b, cc, d]) as [number[], number[], number[], number[]], c, MAT.lit, 1)
    }
  }
  panel(.153, -1, .965, .66, .47)
  panel(.247, 1, .965, .3, .5)
  // Rolled collar over the top of the backrest.
  tube(m, [-.24, .962, .2], [.24, .962, .2], .05, c, 1, 10)
  // Sleeves hang down behind.
  for (const s of [-1, 1]) tube(m, [s * .2, .93, .262], [s * .23, .42, .29], .045, c, 1, 8)
  return m
}

/** Rounded top rails and post caps on every partition, proud of the fabric and its cap. */
export function partitionTrim(): Mesh {
  const m = new Mesh(), trim = hex(0x7a7868)
  for (const p of partitions.filter(p => p.h < 2)) {
    const long = p.w >= p.d, half = (long ? p.w : p.d) / 2 + .012, y = p.h + .03
    const a = long ? [p.x - half, y, p.z] : [p.x, y, p.z - half], b = long ? [p.x + half, y, p.z] : [p.x, y, p.z + half]
    tube(m, a, b, .024, trim, 5, 10)
    for (const end of [a, b]) box(m, end[0]!, p.h - .02, end[2]!, .062, .07, .062, trim, 5, .025)
  }
  return m
}
