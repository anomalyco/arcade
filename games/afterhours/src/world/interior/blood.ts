import * as THREE from "three/webgpu"
import { Fn, If, abs, atan, attribute, clamp, color, cos, cross, dot, exp, float, floor, fract, hash, length, max, min, mix, mx_noise_float, normalize, pow, sin, smoothstep, step, transformNormalToView, uv, vec2, vec3 } from "three/tsl"
import { decalBias } from "../../render/materials"

// Blood decals: one shader and one draw for every pool, smear, spatter, handprint, footprint and drip run in a set.
// Each quad carries `bk` = (kind, seed, age, alpha); the fragment shader draws the shape procedurally in the quad's UVs
// (irregular outline, thickness). Blood is a thin flat film: near-black where it is deep (no light gets through), deep
// red only at the thin edges and in thin transfers (prints, smears), never orange; wet ones are glossy (a sharp
// specular from the pendant or the flashlight), congealed patches duller, and a pool's edge is a slightly raised lip
// (its normal tilts outward in the last few percent of the radius). Transparent, no depth write, `decalBias`.

/** `spatter` (cast-off arc), `spray` (impact spray) and `trail` (droplets along +u) are expanded into single `drop`s. */
export const BLOOD_KIND = { pool: 0, smear: 1, drop: 2, spatter: 2, spray: 2, trail: 2, hand: 3, foot: 4, drips: 5 } as const
export type BloodKind = keyof typeof BLOOD_KIND

export type BloodSpot = {
  kind: BloodKind
  /** Centre of the quad on the surface (world). */
  at: readonly [number, number, number]
  /** Surface normal (default up). */
  normal?: readonly [number, number, number]
  /** Quad "up" (+v) direction in the surface (default −Z on floors, +Y on walls), turned by `rot` about the normal. */
  up?: readonly [number, number, number]
  rot?: number
  /** Width (along u) × height (along v), metres; a negative width mirrors the shape. Hands are drawn for 0.14 × 0.3,
   *  feet for 0.16 × 0.44. */
  size: readonly [number, number]
  seed?: number
  /** 0 fresh … 1 fully dried. */
  age?: number
  /** Overall opacity (a fading footprint trail). */
  alpha?: number
}

/** Hand and foot shapes are authored in metres for these quad sizes. */
export const HAND_SIZE = [0.14, 0.3] as const
export const FOOT_SIZE = [0.16, 0.44] as const

/** Blood reads red: crimson where wet and thin, deep red as it thickens, dark maroon only where thick or dried. */
const DEEP = color(0x4a0508)
const THIN = color(0x9a0c12)
const DRY = color(0x5c0a0c)

type V2 = THREE.Node<"vec2">
const capsule = (p: V2, a: V2, b: V2, r: number) => {
  const pa = p.sub(a)
  const ba = b.sub(a)
  const h = clamp(dot(pa, ba).div(dot(ba, ba)), 0, 1)
  return length(pa.sub(ba.mul(h))).sub(r)
}
const ellipse = (p: V2, c: V2, rx: number, ry: number) => length(p.sub(c).div(vec2(rx, ry))).sub(1).mul(min(rx, ry))

/** TSL `hash` casts to uint: keep its input a positive integer. */
const H = (x: THREE.Node<"float">) => hash(floor(x).add(65536))

const p2x = () => uv().x.sub(0.5)
const p2y = () => uv().y.sub(0.5)

let material: THREE.Material | null = null

/** The one blood material. */
export function bloodMaterial(): THREE.Material {
  if (material) return material
  const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, metalness: 0 })
  const bk = attribute<"vec4">("bk", "vec4")
  const kind = bk.x
  const seed = bk.y
  const age = bk.z
  const fade = bk.w
  const shape = Fn(() => {
    // Shared inputs as variables declared before the branches: TSL caches a node's value where it is first built, so
    // an expression first used inside one branch would read as unset in the others.
    const q = vec2(uv()).toVar()
    const p = q.sub(0.5).mul(2).toVar()
    const n = (s: V2) => mx_noise_float(vec3(s, seed.mul(7.13)))
    const mask = float(0).toVar()
    const thick = float(0).toVar()
    const rim = float(0).toVar()
    If(kind.lessThan(0.5), () => {
      // Pool: lobed outline, satellites at the edge, thick in the middle.
      const a = atan(p.y, p.x)
      const edge = float(0.72).add(n(vec2(cos(a), sin(a)).mul(1.6)).mul(0.3)).add(n(p.mul(5.5)).mul(0.1))
      const r = length(p).div(edge)
      // Broken up: dry islands inside (the floor shows through), not one solid disc.
      const holes = smoothstep(0.38, 0.5, n(p.mul(3.6).add(7.7))).mul(smoothstep(0.35, 0.7, r))
      mask.assign(float(1).sub(smoothstep(0.95, 1.0, r)).mul(float(1).sub(holes)))
      const sat = step(0.42, n(p.mul(9.5).add(3.1))).mul(float(1).sub(smoothstep(1.0, 1.4, r)))
      mask.assign(max(mask, sat))
      thick.assign(smoothstep(0.0, 0.25, float(1).sub(r)).mul(0.85).add(n(p.mul(3.0)).mul(0.1)))
      rim.assign(smoothstep(0.86, 0.97, r).mul(float(1).sub(smoothstep(0.97, 1.0, r))))
    })
      .ElseIf(kind.lessThan(1.5), () => {
        // Smear / drag: a band along u, wide and wet at the −u end, streaky and thinning towards +u.
        const w = float(0.62).sub(p.x.mul(0.18)).add(n(vec2(p.x.mul(1.4), 0.3)).mul(0.14))
        const across = abs(p.y.sub(n(vec2(p.x.mul(0.9), 2.0)).mul(0.12))).div(w)
        const streak = n(vec2(p.x.mul(0.7), p.y.mul(11.0)))
        const ends = float(1).sub(smoothstep(0.82, 1.0, abs(p.x)))
        mask.assign(float(1).sub(smoothstep(0.8, 1.0, across)).mul(ends).mul(smoothstep(-0.55, -0.05, streak.sub(p.x.mul(0.45)))))
        thick.assign(float(1).sub(across).mul(0.45).add(streak.mul(0.18)).sub(p.x.mul(0.18)))
      })
      .ElseIf(kind.lessThan(2.5), () => {
        // One spatter drop (spatter spots are expanded into drops on the CPU): a round head at the bottom (−v) and a
        // tapering tail along +v, the way a drop lands at an angle.
        // In half-widths: the quad is 2 wide and 2·aspect long (aspect rides in the seed slot).
        const asp = max(seed, 1)
        const y = p.y.mul(asp)
        const hy = asp.negate().add(0.9)
        const head = length(vec2(p.x, y.sub(hy))).div(0.85)
        const along = clamp(y.sub(hy).div(asp.mul(2).sub(1.0)), 0, 1)
        const tail = abs(p.x).div(mix(float(0.62), float(0.04), along)).add(step(y, hy)).add(step(asp.sub(0.08), y))
        const d = min(head, tail)
        mask.assign(float(1).sub(smoothstep(0.85, 1.0, d)))
        thick.assign(float(1).sub(head).mul(0.8))
      })
      .ElseIf(kind.lessThan(3.5), () => {
        // Handprint (0.14 × 0.3 m, fingers up), slid down the surface: palm and finger tracks drag below it.
        const x = q.x.sub(0.5).mul(HAND_SIZE[0])
        const y = q.y.mul(HAND_SIZE[1])
        const P = vec2(x, y)
        const below = clamp(float(0.2).sub(y).div(0.13), 0, 1)
        const palm = ellipse(vec2(x, max(y, min(y.add(0.12), 0.2))), vec2(0, 0.2), 0.043, 0.05)
        let d: THREE.Node<"float"> = palm
        for (const [fx, base, tip] of [[-0.031, 0.24, 0.3], [-0.011, 0.25, 0.32], [0.01, 0.25, 0.318], [0.029, 0.24, 0.295]] as const)
          d = min(d, capsule(P, vec2(fx * 0.8, base - 0.12), vec2(fx * 1.25, tip - 0.035), 0.0085))
        d = min(d, capsule(P, vec2(0.036, 0.185), vec2(0.06, 0.235), 0.0095))
        const breakup = n(P.mul(140.0)).mul(0.35).add(n(P.mul(30.0)).mul(0.3))
        mask.assign(float(1).sub(smoothstep(-0.002, 0.001, d)).mul(smoothstep(-0.45, 0.05, breakup.sub(below.mul(0.6)))))
        thick.assign(float(0.3).sub(below.mul(0.2)))
      })
      .ElseIf(kind.lessThan(4.5), () => {
        // Footprint (0.16 × 0.44 m, toes up), right foot (+x outer edge): an almost-human bare print 40 cm long with a
        // narrow heel, a too-long forefoot and five long toes whose nails dragged forward. Blood picked up from a pool
        // and put down unevenly: heavy at heel and ball, broken in the arch, and a faint second image where it slid.
        const x = q.x.sub(0.5).mul(FOOT_SIZE[0])
        const y = q.y.mul(FOOT_SIZE[1])
        const foot = (P: V2) => {
          // Narrow heel; the outer-edge band of the arch (the inner arch lifts off the floor); a long, broad forefoot.
          let d: THREE.Node<"float"> = ellipse(P, vec2(0.004, 0.065), 0.027, 0.045)
          d = min(d, capsule(P, vec2(0.014, 0.08), vec2(0.024, 0.2), 0.02))
          d = min(d, capsule(P, vec2(0.0, 0.205), vec2(-0.004, 0.29), 0.036))
          d = min(d, capsule(P, vec2(0.024, 0.2), vec2(0.03, 0.28), 0.026))
          for (const [x0, y0, x1, y1, r] of [[-0.026, 0.31, -0.034, 0.395, 0.013], [-0.005, 0.318, -0.002, 0.408, 0.0105], [0.013, 0.315, 0.02, 0.4, 0.0098], [0.029, 0.308, 0.039, 0.385, 0.009], [0.042, 0.295, 0.056, 0.36, 0.0082]] as const) {
            d = min(d, capsule(P, vec2(x0, y0), vec2(x1, y1), r))
            // Nail drag: a hairline forward from each tip.
            d = min(d, capsule(P, vec2(x1, y1 + r * 0.6), vec2(x1 + (x1 - x0) * 0.2, y1 + 0.022), 0.0014))
          }
          return d
        }
        const P = vec2(x, y)
        const main = float(1).sub(smoothstep(-0.002, 0.001, foot(P)))
        const slid = float(1).sub(smoothstep(-0.002, 0.002, foot(P.add(vec2(0.004, 0.016))))).mul(0.45)
        const load = float(1).sub(smoothstep(0.08, 0.2, y)).add(smoothstep(0.17, 0.27, y)).min(1).mul(0.5).add(0.3)
        const breakup = n(P.mul(110.0)).mul(0.35).add(n(P.mul(26.0)).mul(0.35)).add(load)
        mask.assign(max(main, slid).mul(smoothstep(0.15, 0.45, breakup)))
        thick.assign(float(0.18).add(main.mul(load).mul(0.15)))
      })
      .Else(() => {
        // Drip runs down a vertical face from a soaked top edge (v = 1 at the top).
        const yy = float(1).sub(q.y)
        const cells = p.x.mul(6.0).add(seed)
        const c = floor(cells)
        const f = fract(cells).sub(0.5)
        const cs = c.add(floor(seed.mul(13.0)).mul(97))
        const h = H(cs)
        const on = step(0.3, H(cs.add(5.0)))
        const L = float(0.2).add(h.mul(h).mul(0.8))
        const w = float(0.05).add(H(cs.add(9.0)).mul(0.07))
        const bulb = exp(yy.sub(L).div(0.045).mul(yy.sub(L).div(0.045)).negate()).mul(w).mul(0.9)
        const width = w.mul(float(1).sub(yy.div(L).mul(0.45))).add(bulb)
        const run = step(abs(f), width).mul(step(yy, L.add(0.04))).mul(on)
        const top = step(yy, float(0.07).add(n(vec2(p.x.mul(3.0), 0)).mul(0.04)))
        mask.assign(max(run, top))
        thick.assign(float(0.45).add(bulb.mul(4.0)))
      })
    return vec3(mask, clamp(thick, 0, 1), rim)
  })
  const s = shape()
  const thick = s.y
  const wet = float(1).sub(age)
  const congeal = smoothstep(0.1, 0.5, mx_noise_float(vec3(uv().mul(11.0), bk.y))).mul(age.add(0.3).min(1))
  // Thin film: deep red (fresh) or dark maroon (dried); thicker: towards near-black.
  const film = mix(DRY, THIN, wet.mul(0.85))
  m.colorNode = mix(film, DEEP, smoothstep(0.2, 0.75, thick)).mul(float(1).sub(congeal.mul(0.22)))
  // Wet blood is a mirror-smooth film; congealed patches and old thin smears dull it.
  const gloss = smoothstep(0.02, 0.2, thick).mul(wet.mul(0.6).add(0.4))
  m.roughnessNode = clamp(mix(float(0.55), float(0.04), gloss).add(congeal.mul(0.18)), 0.03, 1)
  // The pool's lip: in its outer band the surface normal tilts outward (`s.z` = rim weight on pools).
  const N = attribute<"vec3">("normal", "vec3")
  const R = attribute<"vec3">("bt", "vec3")
  const B = cross(N, R)
  const radial = normalize(R.mul(p2x()).add(B.mul(p2y())).add(N.mul(1e-4)))
  m.normalNode = transformNormalToView(normalize(N.add(radial.mul(s.z.mul(0.3)))))
  m.opacityNode = s.x.mul(fade).mul(float(0.85).add(smoothstep(0.05, 0.3, thick).mul(0.14)))
  if (new URLSearchParams(globalThis.location?.search).has("bloodDebug")) {
    m.colorNode = vec3(s.x, kind.div(5), 0)
    m.emissiveNode = vec3(s.x, kind.div(5), 0.2)
    m.opacityNode = max(s.x, 0.15)
  }
  decalBias(m, 3)
  m.name = "interior_blood"
  material = m
  return m
}

/** One mesh (one draw) for a set of blood spots. Receives shadows, casts none. */
export function bloodMesh(input: readonly BloodSpot[], name = "blood"): THREE.Mesh {
  const spots = input.flatMap((s) => (s.kind === "spatter" || s.kind === "spray" || s.kind === "trail" ? spatter(s) : [s]))
  const pos: number[] = []
  const nor: number[] = []
  const uvs: number[] = []
  const bk: number[] = []
  const bt: number[] = []
  const idx: number[] = []
  const n = new THREE.Vector3()
  const up = new THREE.Vector3()
  const right = new THREE.Vector3()
  spots.forEach((s, i) => {
    n.set(...(s.normal ?? [0, 1, 0])).normalize()
    const flat = Math.abs(n.y) > 0.9
    up.set(...(s.up ?? (flat ? [0, 0, -1] : [0, 1, 0])))
    up.addScaledVector(n, -up.dot(n)).normalize()
    if (s.rot) up.applyAxisAngle(n, s.rot)
    right.crossVectors(up, n).normalize()
    // Lift each spot a hair off the surface (and later ones above earlier ones where they overlap).
    const lift = 0.0015 + (i % 8) * 0.0002
    // A negative width mirrors the shape (left foot): flip u rather than the winding.
    const mirror = s.size[0] < 0
    const w = Math.abs(s.size[0])
    const h = s.size[1]
    const base = pos.length / 3
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
      pos.push(
        s.at[0] + right.x * (u - 0.5) * w + up.x * (v - 0.5) * h + n.x * lift,
        s.at[1] + right.y * (u - 0.5) * w + up.y * (v - 0.5) * h + n.y * lift,
        s.at[2] + right.z * (u - 0.5) * w + up.z * (v - 0.5) * h + n.z * lift,
      )
      nor.push(n.x, n.y, n.z)
      // +u in world (flipped with a mirrored quad), for the pool lip's tilt.
      bt.push(mirror ? -right.x : right.x, mirror ? -right.y : right.y, mirror ? -right.z : right.z)
      uvs.push(mirror ? 1 - u : u, v)
      bk.push(BLOOD_KIND[s.kind], s.seed ?? i * 1.618, s.age ?? 0.5, s.alpha ?? 1)
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
  g.setAttribute("bk", new THREE.Float32BufferAttribute(bk, 4))
  g.setAttribute("bt", new THREE.Float32BufferAttribute(bt, 3))
  g.setIndex(idx)
  g.computeBoundingSphere()
  const mesh = new THREE.Mesh(g, bloodMaterial())
  mesh.name = name
  mesh.receiveShadow = true
  mesh.castShadow = false
  mesh.renderOrder = 1
  return mesh
}

/**
 * Expands a spot into drops (each a teardrop: round head, tail pointing the way it was flying):
 * - `spatter`: cast-off in an arc about a point under the quad (−v), denser along the arc, bigger drops mid-arc;
 * - `spray`: an impact spray radiating from the quad centre: a dense core of large drops, smaller and more elongated
 *   outwards, scattered satellites beyond;
 * - `trail`: droplets dripped along +u while walking or carried (irregular spacing, round, small satellites).
 * On walls the larger drops run: a thin rivulet down from the drop (gravity).
 */
function spatter(s: BloodSpot): BloodSpot[] {
  let seed = Math.floor((s.seed ?? 1) * 7919) % 2147483646 || 1
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const n = new THREE.Vector3(...(s.normal ?? [0, 1, 0])).normalize()
  const up = new THREE.Vector3(...(s.up ?? (Math.abs(n.y) > 0.9 ? [0, 0, -1] : [0, 1, 0])))
  up.addScaledVector(n, -up.dot(n)).normalize()
  if (s.rot) up.applyAxisAngle(n, s.rot)
  const right = new THREE.Vector3().crossVectors(up, n).normalize()
  const [w, h] = [Math.abs(s.size[0]), s.size[1]]
  const wall = Math.abs(n.y) < 0.3
  const down = new THREE.Vector3(0, -1, 0).addScaledVector(n, n.y).normalize()
  const out: BloodSpot[] = []
  const drop = (u: number, v: number, dir: THREE.Vector3, size: number, len: number) => {
    const at = new THREE.Vector3(...s.at).addScaledVector(right, u).addScaledVector(up, v)
    // A drop's seed slot carries its aspect (length / width) for the shader.
    out.push({ kind: "drop", at: [at.x, at.y, at.z], normal: [n.x, n.y, n.z], up: [dir.x, dir.y, dir.z], size: [size, len], seed: len / size, age: s.age, alpha: s.alpha })
    if (wall && size > 0.012 && rnd() < 0.6) {
      // The run: from the drop's head down the wall, thinning out.
      const run = 0.06 + rnd() * rnd() * 0.6 * (size / 0.02)
      const r = at.clone().addScaledVector(down, run / 2 - size * 0.3)
      out.push({ kind: "drop", at: [r.x, r.y, r.z], normal: [n.x, n.y, n.z], up: [down.x, down.y, down.z], size: [size * 0.55, run], seed: run / (size * 0.55), age: s.age, alpha: s.alpha })
    }
  }
  const dirOf = (du: number, dv: number) => right.clone().multiplyScalar(du).addScaledVector(up, dv).normalize()
  if (s.kind === "spray") {
    const count = Math.round(110 + w * h * 260)
    const R = Math.min(w, h) / 2
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2
      const t = rnd() ** 1.1
      const r = t * R * (rnd() < 0.08 ? 1.6 : 1)
      const u = Math.cos(a) * r * (w / (2 * R))
      const v = Math.sin(a) * r * (h / (2 * R))
      if (Math.abs(u) > w / 2 || Math.abs(v) > h / 2) continue
      const size = (0.006 + rnd() * rnd() * 0.032) * (1.6 - t)
      const len = size * (1.05 + t * (1 + rnd() * 3))
      drop(u, v, dirOf(Math.cos(a), Math.sin(a)), size, len)
    }
    // A few heavy blobs at the impact.
    for (let i = 0; i < 4; i++) drop((rnd() - 0.5) * R * 0.3, (rnd() - 0.5) * R * 0.3, dirOf(rnd() - 0.5, rnd() - 0.5), 0.025 + rnd() * 0.02, 0.03 + rnd() * 0.03)
    return out
  }
  if (s.kind === "trail") {
    for (let u = -w / 2; u < w / 2; u += 0.04 + rnd() * rnd() * 0.3) {
      const v = (rnd() - 0.5) * h
      const size = 0.006 + rnd() * rnd() * 0.016
      const dir = dirOf(1, (rnd() - 0.5) * 0.4)
      drop(u, v, dir, size, size * (1.05 + rnd() * 0.6))
      // Satellites thrown off where it landed.
      const k = Math.floor(rnd() * 4)
      for (let j = 0; j < k; j++) {
        const a = rnd() * Math.PI * 2
        const r = size * (1.2 + rnd() * 2.5)
        const ss = size * (0.15 + rnd() * 0.25)
        drop(u + Math.cos(a) * r, v + Math.sin(a) * r, dirOf(Math.cos(a), Math.sin(a)), ss, ss * (1.2 + rnd()))
      }
    }
    return out
  }
  const count = Math.round(110 + w * h * 160)
  for (let i = 0; i < count; i++) {
    // Polar about the arc centre (0, −0.9h); the arc sits at radius ~1.25h, ±55°.
    const a = (rnd() - 0.5) * 1.9
    const band = (rnd() + rnd() + rnd() - 1.5) * 0.28
    const r = h * (1.25 + band)
    const u = Math.sin(a) * r * (w / h) * 0.55
    const v = -0.9 * h + Math.cos(a) * r - h * 0.5
    if (Math.abs(u) > w / 2 || Math.abs(v) > h / 2) continue
    const big = Math.exp(-(band * band) / 0.02) * (1 - Math.abs(a) / 1.1)
    const size = 0.006 + rnd() * rnd() * 0.026 + big * rnd() * 0.018
    const len = size * (1.3 + rnd() * 2.4 + Math.abs(a) * 1.5)
    drop(u, v, dirOf(Math.sin(a), Math.cos(a)), size, len)
  }
  return out
}
