import * as THREE from "three/webgpu"
import { abs, clamp, color, float, fract, fwidth, max, mix, mx_noise_float, sin, smoothstep, step, uv, vec2 } from "three/tsl"
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

/** Clear-coated period car paint. */
export const paint = (hex: number, roughness = 0.42, clearcoat = 0.8) =>
  once(`paint_${hex.toString(16)}_${roughness}`, () => {
    const m = new THREE.MeshPhysicalNodeMaterial({ color: hex, roughness, metalness: 0.15, clearcoat, clearcoatRoughness: 0.18 })
    return m
  })

/** Flat painted steel or plastic. */
export const flat = (hex: number, roughness = 0.6, metalness = 0) =>
  once(`flat_${hex.toString(16)}_${roughness}_${metalness}`, () => new THREE.MeshStandardNodeMaterial({ color: hex, roughness, metalness }))

/** Simulated wood-grain vinyl (station wagon panels) or weathered wood (bench slats); grain runs along U. */
export const wood = (dark: number, light: number, roughness = 0.55) =>
  once(`wood_${dark.toString(16)}_${light.toString(16)}`, () => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0 })
    const p = uv()
    const warp = mx_noise_float(p.mul(vec2(0.6, 9))).mul(3.5)
    const grain = sin(p.y.mul(90).add(warp)).mul(0.5).add(0.5)
    const streak = mx_noise_float(p.mul(vec2(1.5, 40))).mul(0.5).add(0.5)
    m.colorNode = mix(color(dark), color(light), grain.mul(0.6).add(streak.mul(0.4)))
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

/** A dim warm emitter for the booth's bulb and anything that must read as lit. */
export const glow = (r: number, g: number, b: number, intensity: number) =>
  once(`glow_${r}_${g}_${b}_${intensity}`, () => {
    const m = new THREE.MeshStandardNodeMaterial({ color: 0x000000, roughness: 1 })
    m.emissive = new THREE.Color(r, g, b)
    m.emissiveIntensity = intensity
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

/** Car window glass: near-black with a sharp clear-coat so sodium lamps streak across it. */
export const carGlass = () =>
  once("car_glass", () => new THREE.MeshPhysicalNodeMaterial({ color: 0x0c1012, roughness: 0.04, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.03 }))
