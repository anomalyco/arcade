import * as THREE from "three/webgpu"
import { abs, attribute, clamp, color, float, fract, fwidth, length, max, mix, mx_noise_float, sin, smoothstep, step, uv, vec2 } from "three/tsl"
import { material } from "../../render/materials"

// One-off materials only the compound needs (period paint colours, wood grain, booth glass, sign plates, the boom's
// stripes). Everything that exists in the shared library comes from `material(name)`.

const cache = new Map<string, THREE.Material>()
const once = <T extends THREE.Material>(key: string, make: () => T): T => {
  const hit = cache.get(key)
  if (hit) return hit as T
  const m = make()
  m.name = `compound_${key}`
  cache.set(key, m)
  return m
}

/**
 * A surface finish that does not need its own material: colour, roughness, metalness and emission are written into
 * the geometry's vertex attributes by `Batch.add`, and every finish of a kind shares one material (one shader).
 */
export type Finish = {
  readonly isFinish: true
  readonly kind: "flat" | "wood"
  readonly color: THREE.Color
  readonly roughness: number
  readonly metalness: number
  /** Emission strength (emissive = colour × this). */
  readonly emissive: number
}

const finish = (kind: Finish["kind"], color: THREE.Color, roughness: number, metalness: number, emissive = 0): Finish => ({
  isFinish: true,
  kind,
  color,
  roughness,
  metalness,
  emissive,
})

/** Flat painted steel or plastic. */
export const flat = (hex: number, roughness = 0.6, metalness = 0) => finish("flat", new THREE.Color(hex), roughness, metalness)

/** Weathered wood or wood-grain vinyl; grain runs along U and modulates the base colour around `dark`..`light`. */
export const wood = (dark: number, light: number, roughness = 0.55) =>
  finish("wood", new THREE.Color(dark).lerp(new THREE.Color(light), 0.5), roughness, 0)

/** A self-lit emitter (a bulb, glowing heater coils). */
export const glow = (r: number, g: number, b: number, intensity: number) => finish("flat", new THREE.Color(r, g, b), 1, 0, intensity)

/** The single shared material for every finish of a kind; reads `fcolor` (vec3) and `fpbr` (roughness, metalness,
 *  emission) from the vertices. */
export const finishMaterial = (kind: Finish["kind"]) =>
  once(`finish_${kind}`, () => {
    const m = new THREE.MeshStandardNodeMaterial()
    const c = attribute<"vec3">("fcolor", "vec3")
    const pbr = attribute<"vec3">("fpbr", "vec3")
    if (kind === "wood") {
      const p = uv()
      const warp = mx_noise_float(p.mul(vec2(0.6, 9))).mul(3.5)
      const grain = sin(p.y.mul(90).add(warp)).mul(0.5).add(0.5)
      const streak = mx_noise_float(p.mul(vec2(1.5, 40))).mul(0.5).add(0.5)
      m.colorNode = c.mul(mix(float(0.62), float(1.3), grain.mul(0.6).add(streak.mul(0.4))))
    } else {
      m.colorNode = c
      m.emissiveNode = c.mul(pbr.z)
    }
    m.roughnessNode = pbr.x
    m.metalnessNode = pbr.y
    return m
  })

/** Galvanised chain-link diamond mesh, procedural and alpha-blended; fades to its average coverage at distance. */
export const chainlink = () =>
  once("chainlink", () => {
    const m = new THREE.MeshStandardNodeMaterial({ color: 0x80847f, roughness: 0.5, metalness: 0.55, side: THREE.DoubleSide })
    m.transparent = true
    m.depthWrite = false
    const p = uv().div(0.05)
    const a = p.x.add(p.y)
    const b = p.x.sub(p.y)
    const da = abs(fract(a.add(0.5)).sub(0.5))
    const db = abs(fract(b.add(0.5)).sub(0.5))
    const fw = max(fwidth(a), fwidth(b))
    const hw = float(0.06)
    const la = float(1).sub(smoothstep(hw.sub(fw.mul(0.5)), hw.add(fw.mul(0.5)), da))
    const lb = float(1).sub(smoothstep(hw.sub(fw.mul(0.5)), hw.add(fw.mul(0.5)), db))
    const sharp = max(la, lb)
    const coverage = float(0.24)
    m.opacityNode = mix(sharp, coverage, smoothstep(0.25, 0.9, fw)).mul(0.95)
    return m
  })

/** Fence mesh material: the shared "chainlink" once it is alpha-tested, otherwise the procedural stand-in. */
export const fenceMesh = () => {
  const lib = material("chainlink") as THREE.MeshStandardNodeMaterial
  const hasAlpha = lib.alphaTest > 0 || lib.transparent || !!lib.alphaMap || !!lib.opacityNode
  if (!hasAlpha) return chainlink()
  lib.side = THREE.DoubleSide
  return lib
}

/** Booth window glass: thin, slightly dirty, with a faint warm glow from the lit interior behind it. */
export const boothGlass = () =>
  once("booth_glass", () => {
    const m = new THREE.MeshPhysicalNodeMaterial({ color: 0x6a6252, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.16 })
    m.emissive = new THREE.Color(1, 0.6, 0.28)
    m.emissiveIntensity = 0.25
    m.depthWrite = false
    m.side = THREE.DoubleSide
    return m
  })

/** Red and white striped boom arm; stripes every 0.5 m along U. */
export const boomStripes = () =>
  once("boom", () => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0 })
    const s = step(0.5, fract(uv().x.div(1.0)))
    const dirt = mx_noise_float(uv().mul(vec2(3, 12))).mul(0.12)
    m.colorNode = mix(color(0x7a120c), color(0xb8b4a8), s).mul(clamp(float(0.9).add(dirt), 0.7, 1))
    return m
  })

/** Weathered warning plates with abstract pictograms (no text): 4 variants side by side in one canvas texture. */
export const signs = () =>
  once("signs", () => {
    const W = 1024
    const H = 192
    const c = document.createElement("canvas")
    c.width = W
    c.height = H
    const g = c.getContext("2d")!
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let v = 0; v < 4; v++) {
      const x0 = v * 256
      g.fillStyle = v === 3 ? "#8a8a80" : "#c9c4b4"
      g.fillRect(x0, 0, 256, H)
      if (v === 0) {
        g.fillStyle = "#8c1d14"
        g.fillRect(x0, 0, 256, 52)
        g.fillStyle = "#1b1b18"
        g.beginPath()
        g.moveTo(x0 + 128, 66)
        g.lineTo(x0 + 186, 172)
        g.lineTo(x0 + 70, 172)
        g.closePath()
        g.fill()
        g.fillStyle = "#c9c4b4"
        g.fillRect(x0 + 122, 100, 12, 40)
        g.fillRect(x0 + 122, 148, 12, 12)
      } else if (v === 1) {
        g.fillStyle = "#b9921e"
        g.save()
        g.translate(x0 + 128, 96)
        g.rotate(Math.PI / 4)
        g.fillRect(-56, -56, 112, 112)
        g.restore()
        g.fillStyle = "#1b1b18"
        g.beginPath()
        g.moveTo(x0 + 136, 46)
        g.lineTo(x0 + 108, 102)
        g.lineTo(x0 + 130, 102)
        g.lineTo(x0 + 116, 150)
        g.lineTo(x0 + 152, 88)
        g.lineTo(x0 + 130, 88)
        g.closePath()
        g.fill()
      } else if (v === 2) {
        g.strokeStyle = "#8c1d14"
        g.lineWidth = 14
        g.beginPath()
        g.arc(x0 + 128, 96, 62, 0, Math.PI * 2)
        g.stroke()
        g.fillStyle = "#1b1b18"
        g.beginPath()
        g.arc(x0 + 128, 66, 12, 0, Math.PI * 2)
        g.fill()
        g.fillRect(x0 + 118, 80, 20, 52)
        g.save()
        g.translate(x0 + 128, 96)
        g.rotate(-Math.PI / 4)
        g.fillStyle = "#8c1d14"
        g.fillRect(-68, -7, 136, 14)
        g.restore()
      }
      // Rust bloom, streaks from the bolts and grime.
      for (let i = 0; i < 260; i++) {
        const r = rnd()
        g.fillStyle = `rgba(${90 + r * 50},${45 + r * 20},${20},${0.05 + rnd() * 0.2})`
        const px = x0 + rnd() * 256
        const py = rnd() < 0.5 ? rnd() * 30 + (rnd() < 0.5 ? 0 : H - 30) : rnd() * H
        g.beginPath()
        g.arc(px, py, 1 + rnd() * 6, 0, Math.PI * 2)
        g.fill()
      }
      for (const bx of [x0 + 18, x0 + 238]) {
        const grad = g.createLinearGradient(0, 16, 0, H)
        grad.addColorStop(0, "rgba(110,52,20,0.75)")
        grad.addColorStop(1, "rgba(110,52,20,0)")
        g.fillStyle = grad
        g.fillRect(bx - 4, 16, 8 + rnd() * 6, H * (0.4 + rnd() * 0.5))
        g.fillStyle = "#3a2a20"
        g.beginPath()
        g.arc(bx, 16, 5, 0, Math.PI * 2)
        g.fill()
      }
      const fade = g.createLinearGradient(x0, 0, x0 + 256, H)
      fade.addColorStop(0, "rgba(40,40,30,0.25)")
      fade.addColorStop(1, "rgba(40,40,30,0.05)")
      g.fillStyle = fade
      g.fillRect(x0, 0, 256, H)
    }
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    return new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.75, metalness: 0.1 })
  })

/**
 * Contact-shadow decal: black with a soft falloff in UV space. "blob" is a rounded rectangle filling the quad
 * (under a car body), "tyre" a tighter, darker ellipse (under a tyre's footprint).
 */
export const contactShadow = (kind: "blob" | "tyre") =>
  once(`contact_${kind}`, () => {
    const m = new THREE.MeshBasicNodeMaterial({ color: 0x000000 })
    m.transparent = true
    m.depthWrite = false
    m.polygonOffset = true
    m.polygonOffsetFactor = -2
    m.polygonOffsetUnits = -2
    const p = uv().sub(0.5).mul(2)
    if (kind === "blob") {
      const q = max(abs(p).sub(vec2(0.62, 0.45)), 0)
      const d = length(q.div(vec2(0.38, 0.55)))
      m.opacityNode = float(1).sub(smoothstep(0, 1, d)).pow(1.6).mul(0.78)
    } else {
      const d = length(p)
      m.opacityNode = float(1).sub(smoothstep(0.15, 1, d)).pow(2).mul(0.9)
    }
    return m
  })
