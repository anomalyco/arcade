import * as THREE from "three/webgpu"
import { Fn, attribute, float, fract, mix, select, sin, smoothstep, step, time, uniform, uv, vec2, vec3, abs, max, exp, length } from "three/tsl"
import { decalBias, materialFor } from "../../render/materials"

// Window glass and decals for the facility. Two custom graphs, each built once and shared (shader count is the boot
// cost); plain glass goes through the shared `flat` surface class.
//
// Window panes carry a per-pane `paneA` attribute; `w` packs the kind and a seed: fract(w) = seed, w ≥ 4 = CRT pane,
// (w mod 4) ≥ 2 = a real room is behind the glass (main block).
//   - Lit pane: xyz = tint. Draws a cheap room behind the glass: brighter towards the ceiling fixture, venetian blinds
//     lowered part way, and a dark furniture silhouette along the sill.
//   - CRT pane: xy = monitor position, z = flicker phase. A dark room lit by one flickering blue monitor.
//   - Real-room mode: the pane only draws the lit blinds / monitor glow and is translucent elsewhere, front side only,
//     so it vanishes from inside.

export const windowGlow = uniform(1)

let windowMat: THREE.MeshStandardNodeMaterial | undefined

/** The one window-pane material (lit rooms and CRT rooms). */
export function windowMaterial() {
  if (windowMat) return windowMat
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x070707, roughness: 0.12, metalness: 0, transparent: true })
  const pane = attribute<"vec4">("paneA", "vec4")
  const crt = step(4, pane.w)
  const kind = pane.w.sub(crt.mul(4))
  const real = step(1.5, kind)
  const seed = fract(pane.w)
  const p = uv()

  // Lit room.
  const blindsAmt = mix(fract(seed.mul(17.1)).mul(1.3).sub(0.35).max(0).min(0.85), fract(seed.mul(17.1)).mul(0.45).add(0.4), real)
  const covered = step(float(1).sub(blindsAmt), p.y)
  const room = mix(float(0.35), float(1.0), smoothstep(0.0, 1.0, p.y)).mul(
    mix(float(0.75), float(1.0), smoothstep(0.0, 0.5, float(0.5).sub(abs(p.x.sub(fract(seed.mul(7.3))))))),
  )
  const slats = mix(float(0.55), float(0.85), step(0.5, fract(p.y.mul(26))))
  const blinds = mix(float(1), slats, covered)
  const inX = step(abs(p.x.sub(fract(seed.mul(13.7)))), mix(float(0.15), float(0.45), fract(seed.mul(3.1))))
  const inY = step(p.y, mix(float(0.12), float(0.4), fract(seed.mul(5.9))))
  const furniture = mix(float(1).sub(inX.mul(inY).mul(0.8)), mix(float(0.7), float(1), covered), real)
  const edge = smoothstep(0.0, 0.04, p.x).mul(smoothstep(0.0, 0.04, float(1).sub(p.x))).mul(smoothstep(0.0, 0.05, p.y)).mul(smoothstep(0.0, 0.05, float(1).sub(p.y)))
  // Real rooms: the pane carries the ceiling glow (bright, readable from far off before the interior lights it).
  const litGlow = pane.xyz.mul(room).mul(blinds).mul(furniture).mul(edge).mul(mix(float(0.35), float(0.95), real))
  const litOpacity = mix(float(1), mix(float(0.62), float(0.97), covered), real)

  // CRT room.
  const d = length(vec2(p.x.sub(pane.x), p.y.sub(pane.y)).mul(vec2(1.0, 1.6)))
  const crtOpacity = mix(float(1), exp(d.mul(-4)).mul(0.6).add(0.25), real)
  const crtGlow = Fn(() => {
    const t = time.add(pane.z.mul(10))
    const flick = float(0.72)
      .add(sin(t.mul(53)).mul(0.06))
      .add(sin(t.mul(7.1)).mul(0.08))
      .add(step(0.93, fract(sin(t.mul(2.3).floor().add(seed)).mul(43758.5))).mul(-0.35))
    const glow = exp(d.mul(-6)).mul(0.9).add(0.12)
    const screen = step(abs(p.x.sub(pane.x)), 0.07).mul(step(abs(p.y.sub(pane.y)), 0.055)).mul(1.6)
    return vec3(0.25, 0.5, 1.0).mul(max(glow, screen)).mul(flick).mul(0.9)
  })()

  const isCrt = crt.greaterThan(0.5)
  m.opacityNode = select(isCrt, crtOpacity, litOpacity)
  m.emissiveNode = select(isCrt, crtGlow, litGlow).mul(windowGlow)
  m.name = "facility_window"
  return (windowMat = m)
}

/** Clear glass (storefront, real-room windows, stair slot): a shared flat-class member. */
export function clearGlassMaterial() {
  const m = materialFor("flat", { color: 0x6f8580, roughness: 0.04, metalness: 0, transparent: 0.16, side: THREE.DoubleSide, name: "facility_glass_clear" })
  // Thin flat panes: one double-sided pass, not three's back-then-front pair (sorting within a pane doesn't matter).
  m.forceSinglePass = true
  return m
}

let decalMat: THREE.MeshStandardNodeMaterial | undefined

/**
 * The one decal material: `decal` = [r, g, b, strength]. Strength < 2: weathering streaks fading down from their
 * source (uv.x in metres along the wall, uv.y 0 at the source, 1 at the end), black grime or rust. Strength ≥ 2:
 * a soft contact-shadow blob under a prop (uv −1…1 across it, opacity strength − 2).
 */
export function decalMaterial() {
  if (decalMat) return decalMat
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x000000, roughness: 0.9, metalness: 0, transparent: true })
  const decal = attribute<"vec4">("decal", "vec4")
  const blob = step(2, decal.w)
  m.colorNode = decal.xyz
  m.opacityNode = Fn(() => {
    const p = uv()
    const u = p.x
    const streak = float(0.45)
      .add(sin(u.mul(23.1).add(sin(u.mul(5.3)).mul(2.0))).mul(0.25))
      .add(sin(u.mul(61.7).add(sin(u.mul(13.1)))).mul(0.18))
      .add(fract(sin(u.mul(9.0).floor().mul(91.7)).mul(43758.5)).mul(0.3))
    const reach = mix(float(0.55), float(1.0), fract(sin(u.mul(4.0).floor().mul(17.3)).mul(9134.7)))
    const fade = float(1).sub(smoothstep(0.0, reach, p.y))
    const stain = max(streak, float(0)).mul(fade).mul(fade).mul(decal.w)
    // Superellipse so long props (truck, pallets) get a boxy-but-soft footprint.
    const r = abs(p.x).pow(4).add(abs(p.y).pow(4)).pow(0.25)
    const a = float(1).sub(smoothstep(0.55, 1.0, r))
    const shadow = a.mul(a).mul(decal.w.sub(2))
    return mix(stain, shadow, blob)
  })()
  m.depthWrite = false
  decalBias(m)
  m.name = "facility_decal"
  return (decalMat = m)
}
