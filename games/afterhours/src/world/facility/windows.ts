import * as THREE from "three/webgpu"
import { Fn, attribute, float, fract, mix, sin, smoothstep, step, time, uniform, uv, vec2, vec3, abs, max, exp, length } from "three/tsl"

// Window glass for the facility shell. Lit panes carry a per-pane `pane` attribute (rgb tint, then seed) and draw a
// cheap room behind the glass: brighter towards the ceiling fixture, venetian blinds lowered part way, and a dark
// furniture silhouette along the sill. CRT panes are a dark room lit by one flickering blue monitor.

export const windowGlow = uniform(1)

/** `paneA` = [r, g, b, seed]; uv is 0…1 across the pane. */
export function litWindowMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x080807, roughness: 0.12, metalness: 0 })
  const pane = attribute<"vec4">("paneA", "vec4")
  m.emissiveNode = Fn(() => {
    const p = uv()
    const seed = pane.w
    const blindsAmt = fract(seed.mul(17.1)).mul(1.3).sub(0.35).max(0).min(0.85)
    // Ceiling fixture: brighter at the top, soft falloff towards the sill.
    const room = mix(float(0.35), float(1.0), smoothstep(0.0, 1.0, p.y)).mul(
      mix(float(0.75), float(1.0), smoothstep(0.0, 0.5, float(0.5).sub(abs(p.x.sub(fract(seed.mul(7.3)))))))
    )
    // Venetian blinds lowered from the top down to `1 - blinds`.
    const covered = step(float(1).sub(blindsAmt), p.y)
    const slats = mix(float(0.55), float(0.85), step(0.5, fract(p.y.mul(26))))
    const blinds = mix(float(1), slats, covered)
    // Furniture silhouette: a desk/cabinet block of seeded width and height near the sill.
    const cx = fract(seed.mul(13.7))
    const w = mix(float(0.15), float(0.45), fract(seed.mul(3.1)))
    const h = mix(float(0.12), float(0.4), fract(seed.mul(5.9)))
    const inX = step(abs(p.x.sub(cx)), w)
    const inY = step(p.y, h)
    const furniture = float(1).sub(inX.mul(inY).mul(0.8))
    // Mullion-ish frame darkening at the edges.
    const edge = smoothstep(0.0, 0.04, p.x).mul(smoothstep(0.0, 0.04, float(1).sub(p.x))).mul(smoothstep(0.0, 0.05, p.y)).mul(smoothstep(0.0, 0.05, float(1).sub(p.y)))
    return pane.xyz.mul(room).mul(blinds).mul(furniture).mul(edge).mul(windowGlow).mul(0.55)
  })()
  m.name = "facility_window_lit"
  return m
}

/** Dark room with a CRT monitor glowing blue; `paneA` = [monitor x, monitor y, phase, seed]. */
export function crtWindowMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x050607, roughness: 0.1, metalness: 0 })
  const pane = attribute<"vec4">("paneA", "vec4")
  m.emissiveNode = Fn(() => {
    const p = uv()
    const t = time.add(pane.z.mul(10))
    const flick = float(0.72)
      .add(sin(t.mul(53)).mul(0.06))
      .add(sin(t.mul(7.1)).mul(0.08))
      .add(step(0.93, fract(sin(t.mul(2.3).floor().add(pane.w)).mul(43758.5))).mul(-0.35))
    const d = length(vec2(p.x.sub(pane.x), p.y.sub(pane.y)).mul(vec2(1.0, 1.6)))
    const glow = exp(d.mul(-6)).mul(0.9).add(0.12)
    const screen = step(abs(p.x.sub(pane.x)), 0.07).mul(step(abs(p.y.sub(pane.y)), 0.055)).mul(1.6)
    return vec3(0.25, 0.5, 1.0).mul(max(glow, screen)).mul(flick).mul(windowGlow).mul(0.9)
  })()
  m.name = "facility_window_crt"
  return m
}

/** Clear storefront glass so the lobby reads from outside. */
export function clearGlassMaterial() {
  const m = new THREE.MeshPhysicalNodeMaterial({ color: 0x6f8580, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16 })
  m.depthWrite = false
  m.side = THREE.DoubleSide
  m.name = "facility_glass_clear"
  return m
}

/** Weathering: dark vertical streaks fading away from their source (sills, coping, downpipe heads, splash-back). */
export function stainMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ color: 0x000000, transparent: true })
  const strength = attribute<"float">("stain", "float")
  m.opacityNode = Fn(() => {
    const p = uv()
    const u = p.x
    const streak = float(0.45)
      .add(sin(u.mul(23.1).add(sin(u.mul(5.3)).mul(2.0))).mul(0.25))
      .add(sin(u.mul(61.7).add(sin(u.mul(13.1)))).mul(0.18))
      .add(fract(sin(u.mul(9.0).floor().mul(91.7)).mul(43758.5)).mul(0.3))
    // v: 0 at the source, 1 where it fades out; streaks reach further down in some columns.
    const reach = mix(float(0.55), float(1.0), fract(sin(u.mul(4.0).floor().mul(17.3)).mul(9134.7)))
    const fade = float(1).sub(smoothstep(0.0, reach, p.y))
    return max(streak, float(0)).mul(fade).mul(fade).mul(strength)
  })()
  m.depthWrite = false
  m.polygonOffset = true
  m.polygonOffsetFactor = -2
  m.polygonOffsetUnits = -2
  m.name = "facility_stain"
  return m
}
