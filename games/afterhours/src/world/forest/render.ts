import * as THREE from "three/webgpu"
import {
  Fn,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  float,
  floor,
  fract,
  interleavedGradientNoise,
  length,
  cross,
  dFdx,
  dFdy,
  dot,
  positionView,
  lights,
  max,
  mod,
  normalLocal,
  normalGeometry,
  normalize,
  positionGeometry,
  screenCoordinate,
  select,
  sin,
  step,
  texture,
  time,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl"
import { IMPOSTOR } from "./species"

// Instanced rendering for the forest. Every instanced mesh reads two per-instance vec4s:
//   iA = (x, y, z, scale)   iB = (cos yaw, sin yaw, tint, wind phase)       (impostors: iB = (cell, tint, w, h))
// and fades between detail levels with a screen-door dither keyed to the distance from the player, so neighbouring
// levels are exact complements and never show holes or double density.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

export const forestUniforms = {
  /** Player eye position (not the shadow camera's), for LOD distances. */
  view: uniform(new THREE.Vector3()) as N,
  /** Wind strength 0..1. */
  wind: uniform(0.35) as N,
  /** Width of the LOD cross-fade band (m). */
  fade: uniform(5) as N,
  /** Full/mid detail boundary and mid/far boundary (m), for the roadside distance remap. */
  nearHi: uniform(29) as N,
  midHi: uniform(105) as N,
  /** Roadside trees keep full detail this many times further (headlights reach them). */
  roadK: uniform(2.2) as N,
}

/** Instances flagged roadside carry `phase + ROADSIDE` in iB.w (the offset only shifts their sway phase). */
export const ROADSIDE = 1000

/**
 * Distance used for LOD bands. Roadside trees (lit by headlights from the road) compress [0, nearHi * k] onto
 * [0, nearHi] and stretch the rest back to identity at midHi, so they stay full-detail k times further, cross-fade to
 * mid at the same place in both materials, and still hand over to impostors exactly where every other tree does.
 * `lodDistanceCpu` must match.
 */
function lodDistance(d: N, phase: N) {
  const U = forestUniforms
  const road = step(ROADSIDE - 1, phase)
  const k = float(1).add(road.mul(U.roadK.sub(1)))
  const b = U.nearHi.mul(k)
  const near = d.div(k)
  const mid = U.nearHi.add(d.sub(b).mul(U.midHi.sub(U.nearHi)).div(max(U.midHi.sub(b), 1)))
  return select(d.lessThan(b), near, select(d.lessThan(U.midHi), mid, d))
}

export function lodDistanceCpu(d: number, roadside: boolean, nearHi: number, midHi: number, k: number) {
  if (!roadside) return d
  const b = nearHi * k
  if (d < b) return d / k
  if (d < midHi) return nearHi + ((d - b) * (midHi - nearHi)) / Math.max(midHi - b, 1)
  return d
}
const windDir = vec2(0.83, 0.56)

export type Band = { lo: N; hi: N }
export const band = (lo: number, hi: number): Band => ({ lo: uniform(lo), hi: uniform(hi) })

const iA = () => attribute("iA", "vec4") as N
const iB = () => attribute("iB", "vec4") as N

/** Instance transform with wind sway; collapses instances outside [lo, hi + fade] so they cost no fragments. */
function instancePosition(b: Band, foliage: boolean, hardSwitch: boolean) {
  return Fn(() => {
    const a = iA()
    const bb = iB()
    const local = (positionGeometry as N).mul(a.w)
    const c = bb.x
    const s = bb.y
    const ph = bb.w
    const t = time as N
    const h = max(local.y, 0).div(26)
    const sway = sin(t.mul(0.53).add(ph)).mul(0.7).add(sin(t.mul(1.37).add(ph.mul(1.9))).mul(0.3))
    const k = forestUniforms.wind.mul(sway).mul(h.mul(h)).mul(0.6)
    let x = local.x.mul(c).sub(local.z.mul(s))
    let y = local.y
    let z = local.x.mul(s).add(local.z.mul(c))
    x = x.add(windDir.x.mul(k))
    z = z.add(windDir.y.mul(k))
    if (foliage) {
      const flex = attribute("flex", "float") as N
      const flutter = sin(t.mul(2.3).add(ph).add(local.y.mul(0.8)).add(flex.mul(1.7))).mul(flex).mul(0.035).mul(forestUniforms.wind)
      y = y.add(flutter)
      x = x.add(flutter.mul(windDir.x))
    }
    const n = normalGeometry as N
    normalLocal.assign(vec3(n.x.mul(c).sub(n.z.mul(s)), n.y, n.x.mul(s).add(n.z.mul(c))))
    const d = lodDistance(length(forestUniforms.view.xz.sub(a.xz)), ph)
    const F = forestUniforms.fade
    const lo = hardSwitch ? b.lo.add(F.mul(0.5)) : b.lo.sub(1)
    const hi = hardSwitch ? b.hi.add(F.mul(0.5)) : b.hi.add(F).add(1)
    const inside = step(lo, d).mul(step(d, hi))
    return select(inside.greaterThan(0.5), vec3(x, y, z).add(a.xyz), vec3(0, -1e4, 0))
  })()
}

function ditherMask(b: Band) {
  const d = varying(lodDistance(length(forestUniforms.view.xz.sub(iA().xz)), iB().w), "vForestDist") as N
  const F = forestUniforms.fade
  // Shift the pattern every frame so TAA resolves the cross-fade into a blend instead of a visible screen door.
  const n = interleavedGradientNoise((screenCoordinate as N).xy.add(fract((time as N).mul(60)).mul(vec2(37.1, 17.3)).floor())) as N
  const fi = clamp(d.sub(b.lo).div(F), 0, 1)
  const fo = clamp(d.sub(b.hi).div(F), 0, 1)
  return step(float(1).sub(fi), n).mul(float(1).sub(step(float(1).sub(fo), n)))
}

// One position graph for every solid instanced forest part (trunks at both LODs, logs, stumps, end grain): the band
// is read per object from `mesh.userData.forestBand` (works in the shadow pass too, where the material is swapped),
// so all of them share shaders with their library material class instead of compiling one per band.
const objectBand = (key: "lo" | "hi") =>
  (uniform(0) as N).onObjectUpdate((frame: { object?: THREE.Object3D }, self: { value: number }) => {
    const b = frame.object?.userData.forestBand as Band | undefined
    if (b) self.value = b[key].value
  })
let sharedSolidPosition: N = null
const solidPosition = () => (sharedSolidPosition ??= instancePosition({ lo: objectBand("lo"), hi: objectBand("hi") }, false, true))

/** A library material placed per instance (hard switch between levels, no cutout). Set `mesh.userData.forestBand`. */
export function solidMaterial(base: THREE.Material) {
  const m = (base as THREE.MeshStandardNodeMaterial).clone()
  m.positionNode = solidPosition()
  return m
}

/** Branch cards: alpha-cutout needle sprays with crown-shaped normals, tint per instance, dithered LOD fades. */
export function foliageMaterial(atlas: THREE.Texture, color: THREE.Color, b: Band) {
  const m = new THREE.MeshStandardNodeMaterial()
  m.side = THREE.DoubleSide
  m.alphaTest = 0.5
  m.roughness = 0.88
  m.metalness = 0
  m.positionNode = instancePosition(b, true, false)
  const tex = texture(atlas) as N
  const tint = varying(iB().z, "vTint") as N
  // Inner foliage near the trunk is self-shadowed: darken toward each limb's base.
  const inner = varying(clamp((attribute("flex", "float") as N).div(1.6), 0, 1), "vInner") as N
  const occl = inner.mul(0.55).add(0.45)
  m.colorNode = vec4(tex.rgb.mul(uniform(color)).mul(tint).mul(occl), tex.a.mul(ditherMask(b)))
  // Crown normals (out from the trunk and up) make the tree shade like one volume; blending in each card's own face
  // normal (turned toward the viewer) keeps sprays at different angles from lighting identically, so a headlight or
  // flashlight close by shows layered branches instead of one flat lit sheet.
  const nWorld = varying(normalLocal, "vCrownNormal") as N
  const crown = normalize((cameraViewMatrix as N).mul(vec4(nWorld, 0)).xyz)
  const pv = positionView as N
  const face0 = normalize(cross(dFdx(pv) as N, dFdy(pv) as N) as N) as N
  const face = select(dot(face0, pv).greaterThan(0), face0.negate(), face0)
  m.normalNode = normalize(crown.mul(0.55).add(face.mul(0.45)))
  return m
}

/** Far trees: one camera-facing quad per tree, painted from the tree's own cards. */
export function impostorMaterial(atlas: THREE.Texture, color: THREE.Color, b: Band) {
  const m = new THREE.MeshStandardNodeMaterial()
  // Past the mid-tree range no lamp reaches through the fog: light only by the fog skylight (environment), which
  // skips the per-pixel clustered-light loop and the shadowed spot lights on the most overdrawn surface in the frame.
  m.lightsNode = lights([])
  m.side = THREE.DoubleSide
  m.alphaTest = 0.5
  m.roughness = 0.9
  m.metalness = 0
  const toCam = Fn(() => normalize((cameraPosition as N).xz.sub(iA().xz)))
  m.positionNode = Fn(() => {
    const a = iA()
    const bb = iB()
    const tc = toCam()
    const right = vec3(tc.y, 0, tc.x.negate())
    const p = positionGeometry as N
    const world = a.xyz.add(right.mul(p.x.mul(bb.z))).add(vec3(0, p.y.mul(bb.w).sub(a.w.mul(0.7)), 0))
    const d = length(forestUniforms.view.xz.sub(a.xz))
    const inside = step(b.lo.sub(1), d).mul(step(d, b.hi.add(forestUniforms.fade).add(1)))
    return select(inside.greaterThan(0.5), world, vec3(0, -1e4, 0))
  })()
  const cell = varying(iB().x, "vCell") as N
  const p = positionGeometry as N
  const uvx = varying(p.x.add(0.5), "vImpU") as N
  const uvy = varying(p.y, "vImpV") as N
  const u = mod(cell, IMPOSTOR.cols).add(uvx).div(IMPOSTOR.cols)
  const v = floor(cell.div(IMPOSTOR.cols)).add(float(1).sub(uvy)).div(IMPOSTOR.rows)
  const tex = texture(atlas, vec2(u, v)) as N
  const tint = varying(iB().y, "vTint") as N
  m.colorNode = vec4(tex.rgb.mul(uniform(color)).mul(tint), tex.a.mul(ditherMask(b)))
  const n = varying(Fn(() => {
    const tc = toCam()
    return normalize(vec3(tc.x, 0.55, tc.y))
  })(), "vImpN") as N
  m.normalNode = normalize((cameraViewMatrix as N).mul(vec4(n, 0)).xyz)
  return m
}

/** A set of instanced meshes sharing one pair of per-instance attributes. */
export class InstLayer {
  readonly a: THREE.InstancedBufferAttribute
  readonly b: THREE.InstancedBufferAttribute
  readonly meshes: THREE.Mesh[] = []
  count = 0

  constructor(
    readonly capacity: number,
    parts: { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; castShadow?: boolean; name: string; band?: Band }[],
  ) {
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    this.a.setUsage(THREE.DynamicDrawUsage)
    this.b.setUsage(THREE.DynamicDrawUsage)
    for (const part of parts) {
      const g = new THREE.InstancedBufferGeometry()
      for (const [k, v] of Object.entries(part.geometry.attributes)) g.setAttribute(k, v)
      g.setIndex(part.geometry.index)
      for (const grp of part.geometry.groups) g.addGroup(grp.start, grp.count, grp.materialIndex)
      g.setAttribute("iA", this.a)
      g.setAttribute("iB", this.b)
      g.instanceCount = 0
      const mesh = new THREE.Mesh(g, part.material)
      mesh.name = part.name
      if (part.band) mesh.userData.forestBand = part.band
      mesh.frustumCulled = false
      mesh.castShadow = part.castShadow ?? false
      mesh.receiveShadow = true
      // Before the ground, so its costly shader is depth-rejected wherever trees and plants cover it.
      mesh.renderOrder = -1
      this.meshes.push(mesh)
    }
  }

  set(i: number, x: number, y: number, z: number, s: number, b0: number, b1: number, b2: number, b3: number) {
    const A = this.a.array as Float32Array
    const B = this.b.array as Float32Array
    const o = i * 4
    A[o] = x
    A[o + 1] = y
    A[o + 2] = z
    A[o + 3] = s
    B[o] = b0
    B[o + 1] = b1
    B[o + 2] = b2
    B[o + 3] = b3
  }

  commit(count: number) {
    this.count = count
    for (const m of this.meshes) (m.geometry as THREE.InstancedBufferGeometry).instanceCount = count
    if (count > 0) {
      this.a.clearUpdateRanges()
      this.b.clearUpdateRanges()
      this.a.addUpdateRange(0, count * 4)
      this.b.addUpdateRange(0, count * 4)
      this.a.needsUpdate = true
      this.b.needsUpdate = true
    }
  }
}
