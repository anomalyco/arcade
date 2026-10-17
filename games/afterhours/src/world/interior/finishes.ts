import * as THREE from "three/webgpu"
import { atan, float, fract, mix, positionWorld, sin, smoothstep, step, uv, vec3 } from "three/tsl"
import { materialFor } from "../../render/materials"
import { aaFade, aaStep } from "./kit"

// Shared surface materials for interior pieces: venetian blinds, polythene sheeting (clear and the dusty contractor's
// milky kind), plate glazing, and soft-edged stain/puddle decals. One material each, shared by every storey.

/** Venetian blinds: horizontal slats from the world height, closed (opaque) or tilted open (light between slats). */
export const blindMats = (() => {
  const make = (open: boolean) => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, side: THREE.DoubleSide })
    const f = fract(positionWorld.y.mul(40))
    const shade = mix(float(0.94), mix(float(0.55), float(1), aaStep(0.12, f)), aaFade(positionWorld.y.mul(40)))
    m.colorNode = vec3(0.62, 0.6, 0.53).mul(shade)
    if (open) {
      m.opacityNode = step(f, 0.62)
      m.alphaTest = 0.5
    }
    m.name = open ? "interior_blind_open" : "interior_blind"
    return m
  }
  return { closed: make(false), open: make(true) }
})()

/** Clear plastic sheeting, hung from the ceiling on storey 4. */
/** Polythene sheeting: nearly clear, glossy (the tubes streak across its folds), never a dark veil. */
export const plasticMat = materialFor("flat", { color: 0xe8ece6, roughness: 0.12, transparent: 0.12, side: THREE.DoubleSide, name: "interior_plastic" })

/** Machine-room glazing: clear, faintly green-edged plate glass. */
export const glazing = materialFor("flat", { color: 0xd4e4dc, roughness: 0.03, transparent: 0.08, name: "interior_glazing" })

/** Soft-edged floor and ceiling decals (water stains, puddles) with an irregular outline, in the quad's 0..1 UVs. */
export const decal = (color: number, roughness: number, alpha: number, name: string) => {
  const m = new THREE.MeshStandardNodeMaterial({ color, roughness, transparent: true, depthWrite: false })
  const p = uv().sub(0.5).mul(2)
  const a = atan(p.y, p.x)
  const edge = sin(a.mul(3).add(1.3)).mul(0.12).add(sin(a.mul(7).add(0.4)).mul(0.06)).add(0.82)
  const d = p.length().div(edge)
  m.opacityNode = float(1).sub(smoothstep(0.55, 1, d)).mul(alpha)
  m.polygonOffset = true
  m.polygonOffsetFactor = -3
  m.polygonOffsetUnits = -3
  m.name = `interior_${name}`
  return m
}

export const STAIN = decal(0x2e2518, 0.95, 0.7, "stain_decal")

export const PUDDLE = decal(0x080908, 0.03, 0.85, "puddle_decal")

/** Dusty contractor's polythene: milkier than the clear sheet, so a work light reads on it (promoted from storey 4). */
export const POLY = materialFor("flat", { color: 0xdde2da, roughness: 0.32, transparent: 0.38, side: THREE.DoubleSide, name: "interior_s4_poly" })
