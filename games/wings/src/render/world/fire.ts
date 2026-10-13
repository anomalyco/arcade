// Pooled fire + smoke columns (TSL, GPU-procedural). The CPU only writes a small emitter table
// (position + kind/size) each frame; every puff's position, size, colour and fade is a function of
// time and a per-puff seed, so there is no particle simulation on the CPU.
import { AdditiveBlending, BufferAttribute, BufferGeometry, Mesh, NormalBlending, Vector4 } from "three"
import { MeshBasicNodeMaterial } from "three/webgpu"
import {
  attribute, cameraPosition, clamp, cross, float, fract, length, max, mix, normalize, smoothstep, time, uniformArray, vec3,
} from "three/tsl"
import { STORM, type N } from "./atmosphere"

export const MAX_EMITTERS = 96

export const enum EmitterKind {
  None = 0,
  /** Burning damage: fire at the base + dark smoke column. */
  Fire = 1,
  /** Heavy smoke only (sinking / smouldering). */
  Smoke = 2,
  /** Churned white water / bubbles at the surface (sinking). */
  Foam = 3,
}

function puffGeometry(perEmitter: number): BufferGeometry {
  const count = MAX_EMITTERS * perEmitter
  const seed = new Float32Array(count * 4 * 4)
  const corner = new Float32Array(count * 4 * 2)
  const emitter = new Float32Array(count * 4)
  const idx = new Uint32Array(count * 6)
  for (let e = 0; e < MAX_EMITTERS; e++) for (let k = 0; k < perEmitter; k++) {
    const i = e * perEmitter + k
    const s = [(k + Math.random() * 0.6) / perEmitter, Math.random(), Math.random(), Math.random()]
    for (let c = 0; c < 4; c++) {
      seed.set(s, (i * 4 + c) * 4)
      corner[(i * 4 + c) * 2] = c & 1 ? 1 : -1
      corner[(i * 4 + c) * 2 + 1] = c & 2 ? 1 : -1
      emitter[i * 4 + c] = e
    }
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6)
  }
  const g = new BufferGeometry()
  g.setAttribute("position", new BufferAttribute(new Float32Array(count * 4 * 3), 3))
  g.setAttribute("seed", new BufferAttribute(seed, 4))
  g.setAttribute("corner", new BufferAttribute(corner, 2))
  g.setAttribute("emitter", new BufferAttribute(emitter, 1))
  g.setIndex(new BufferAttribute(idx, 1))
  return g
}

export function createFireSystem() {
  const emitPos = uniformArray(Array.from({ length: MAX_EMITTERS }, () => new Vector4(0, -1e5, 0, 0)), "vec4")
  /** (kind, size, rise, 0) */
  const emitInfo = uniformArray(Array.from({ length: MAX_EMITTERS }, () => new Vector4(0, 0, 0, 0)), "vec4")

  function billboard(center: N, size: N, corner: N): N {
    const toCam: N = normalize(cameraPosition.sub(center))
    const right: N = normalize(cross(vec3(0, 1, 0), toCam))
    const up: N = cross(toCam, right)
    return center.add(right.mul(corner.x.mul(size))).add(up.mul(corner.y.mul(size)))
  }

  // ---- smoke (also renders foam) ----
  const smokeMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: NormalBlending, fog: true })
  smokeMat.name = "World · smoke"
  {
    const seed: N = attribute("seed", "vec4"), corner: N = attribute("corner", "vec2"), ei: N = attribute("emitter", "float")
    const P: N = emitPos.element(ei.toInt()), I: N = emitInfo.element(ei.toInt())
    const kind: N = I.x, size0: N = I.y, rise: N = I.z
    const foam: N = smoothstep(2.5, 3.0, kind)
    const life = 18
    const age: N = fract(time.div(life).mul(seed.w.mul(0.3).add(0.85)).add(seed.x))
    const wind: N = vec3(STORM.wind.x, 0, STORM.wind.y)
    // Column: rises and is sheared downwind; foam stays flat on the water and spreads.
    const jitter: N = vec3(seed.y.sub(0.5), 0, seed.z.sub(0.5)).mul(size0.mul(0.8))
    // Fast at the base, slowing as the column spreads (buoyant plume).
    const up: N = mix(rise.mul(age.sqrt()).mul(1.15), float(0.4), foam)
    const drift: N = wind.mul(age.mul(life).mul(mix(float(0.9), float(0.12), foam)))
    const center: N = P.xyz.add(jitter.mul(age.mul(3).add(1))).add(vec3(0, up, 0)).add(drift)
    const size: N = size0.mul(mix(age.mul(6).add(1.0), age.mul(1.5).add(0.8), foam))
    const live: N = smoothstep(0.5, 1.5, kind)
    smokeMat.positionNode = billboard(center, size.mul(live), corner)
    const r: N = length(corner)
    const soft: N = smoothstep(1.0, 0.25, r)
    const fade: N = smoothstep(0.0, 0.08, age).mul(smoothstep(1.0, 0.55, age))
    // Dark heavy smoke (lit a little by lightning) or churned white foam.
    // Dense near-black at the base, lifting to a warm-gray billow; lit from below by its own fire.
    const glow: N = smoothstep(0.25, 0.0, age).mul(smoothstep(1.5, 0.5, kind)).mul(P.w)
    const smokeCol: N = mix(vec3(0.03, 0.028, 0.026), vec3(0.075, 0.074, 0.07), age).add(vec3(0.35, 0.14, 0.03).mul(glow)).add(STORM.lightning.mul(STORM.flash).mul(0.05))
    // Churned water: broken, grey-green foam, not a solid white sheet.
    const foamCol: N = vec3(0.16, 0.19, 0.18).mul(seed.y.mul(0.5).add(0.6))
    smokeMat.colorNode = mix(smokeCol, foamCol, foam)
    const foamBreak: N = smoothstep(0.35, 0.75, fract(seed.z.mul(7.3).add(length(corner).mul(2.1))))
    smokeMat.opacityNode = clamp(soft.mul(fade).mul(mix(float(0.55), foamBreak.mul(0.35), foam)).mul(P.w.min(1)), 0, 1)
  }
  const smoke = new Mesh(puffGeometry(36), smokeMat)
  smoke.frustumCulled = false
  smoke.renderOrder = 7
  smoke.name = "World · smoke"

  // ---- fire (additive, HDR for bloom) ----
  const fireMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, fog: true })
  fireMat.name = "World · fire"
  {
    const seed: N = attribute("seed", "vec4"), corner: N = attribute("corner", "vec2"), ei: N = attribute("emitter", "float")
    const P: N = emitPos.element(ei.toInt()), I: N = emitInfo.element(ei.toInt())
    const kind: N = I.x, size0: N = I.y
    const isFire: N = smoothstep(0.5, 1.0, kind).mul(smoothstep(1.5, 1.0, kind))
    const life = 1.1
    const age: N = fract(time.div(life).mul(seed.w.mul(0.5).add(0.75)).add(seed.x))
    const jitter: N = vec3(seed.y.sub(0.5), 0, seed.z.sub(0.5)).mul(size0.mul(0.6))
    const center: N = P.xyz.add(jitter).add(vec3(0, age.mul(size0).mul(1.8), 0))
    const size: N = size0.mul(float(1).sub(age.mul(0.6))).mul(0.55)
    fireMat.positionNode = billboard(center, size.mul(isFire), corner)
    const soft: N = smoothstep(1.0, 0.1, length(corner))
    const hot: N = mix(vec3(14, 7.5, 2.2), vec3(4, 0.9, 0.15), age)
    fireMat.colorNode = hot.mul(soft).mul(smoothstep(1.0, 0.4, age)).mul(P.w).mul(max(float(0.6), seed.w))
    fireMat.opacityNode = float(1)
  }
  const fire = new Mesh(puffGeometry(6), fireMat)
  fire.frustumCulled = false
  fire.renderOrder = 7
  fire.name = "World · fire"

  let used = 0
  return {
    meshes: [smoke, fire] as const,
    /** Start writing a new frame's emitters. */
    begin() { used = 0 },
    /** Add an emitter; returns false when the pool is full. */
    emit(x: number, y: number, z: number, kind: EmitterKind, size: number, intensity = 1, rise = 220): boolean {
      if (used >= MAX_EMITTERS) return false
      ;(emitPos.array[used] as Vector4).set(x, y, z, intensity)
      ;(emitInfo.array[used] as Vector4).set(kind, size, rise, 0)
      used++
      return true
    },
    /** Clear unused slots. */
    end() {
      for (let i = used; i < MAX_EMITTERS; i++) {
        ;(emitPos.array[i] as Vector4).set(0, -1e5, 0, 0)
        ;(emitInfo.array[i] as Vector4).set(0, 0, 0, 0)
      }
    },
    get count() { return used },
    dispose() { smoke.geometry.dispose(); fire.geometry.dispose(); smokeMat.dispose(); fireMat.dispose() },
  }
}
