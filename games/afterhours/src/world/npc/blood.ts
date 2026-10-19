import * as THREE from "three/webgpu"
import { clamp, color, dot, float, length, materialRoughness, max, mix, mx_noise_float, normalize, positionWorld, select, smoothstep, step, texture, uniform, vec3, vec4 } from "three/tsl"

// Blood on a corpse: wounds given in bone space become world points (the pose is frozen, so they never move), and the
// corpse's materials are swapped for copies whose albedo darkens and reddens and whose gloss rises inside a mask
// around each wound. The mask is a noisy ellipsoid stretched downwards (blood runs with gravity and soaks the cloth
// below the wound). Two looks, by surface:
// - cloth (torso, neck, head wounds): a blotchy soak, densest and darkest at the wound, spreading unevenly through the
//   weave with broken edges, lighter dried patches inside and a darker tide-line where the soak front stopped;
// - skin (hands, forearms; `skin: true`): streaks and smears along the limb, a few drips, dried flakes, with skin
//   showing between them; never full coverage.

export type CorpseWound = {
  /** Bone name (e.g. "Head", "Neck", "Spine2", "LeftHand"). */
  bone: string
  /** Offset from the bone in its own axes, metres (bone scale ignored). */
  offset?: readonly [number, number, number]
  /** Radius of the soaked area, metres. */
  radius: number
  /** How far it runs downwards, as a multiple of the radius (default 1.8). */
  run?: number
  /** 0..1 (default 1). */
  strength?: number
  /** Skin look (streaks, smears, flakes) instead of a cloth soak. Default: hands and forearms. */
  skin?: boolean
}
export type CorpseBlood = { wounds: readonly CorpseWound[] }

const MAX_WOUNDS = 6
/** Multiplier for stained cloth (linear: saturated deep maroon on white) and the soaked-through colour. */
const STAIN = vec3(0.3, 0.035, 0.035)
const SOAK = color(0x2a0405)
/** Dried soak: a browner, lighter maroon (multiplier). */
const DRIED = vec3(0.42, 0.13, 0.11)
/** Blood film on skin: wet deep red, dried flaking maroon-brown. */
const SKIN_WET = color(0x4a0608)
const SKIN_DRY = color(0x3a120e)

const p = new THREE.Vector3()
const q = new THREE.Quaternion()
const sc = new THREE.Vector3()

/** Applies `blood` to a posed, frozen corpse (call after its matrices are final). */
export function applyCorpseBlood(root: THREE.Object3D, blood: CorpseBlood) {
  const bones = new Map<string, THREE.Object3D>()
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.set(o.name.replace(/^mixamorig\d*:/, ""), o)
  })
  const W = Array.from({ length: MAX_WOUNDS }, () => ({
    at: uniform(new THREE.Vector4(0, -1000, 0, 0.001)),
    run: uniform(new THREE.Vector2(1.8, 0)),
    // Limb axis (world) and skin flag (w).
    axis: uniform(new THREE.Vector4(0, 1, 0, 0)),
  }))
  blood.wounds.slice(0, MAX_WOUNDS).forEach((w, i) => {
    const b = bones.get(w.bone)
    if (!b) return
    b.updateWorldMatrix(true, false)
    b.matrixWorld.decompose(p, q, sc)
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    if (w.offset) p.add(new THREE.Vector3(...w.offset).applyQuaternion(q))
    const skin = w.skin ?? /Hand|ForeArm/.test(w.bone)
    W[i]!.at.value.set(p.x, p.y, p.z, w.radius)
    W[i]!.run.value.set(w.run ?? 1.8, w.strength ?? 1)
    W[i]!.axis.value.set(axis.x, axis.y, axis.z, skin ? 1 : 0)
  })
  const P = positionWorld
  // Cloth: a warped, multi-octave field so the soak spreads in blotches (folds and seams wick more), not a disc.
  const warp = vec3(mx_noise_float(P.mul(9).add(3.1)), mx_noise_float(P.mul(9).add(7.3)), mx_noise_float(P.mul(9).add(1.7))).mul(0.035)
  const Q = P.add(warp)
  const blotch = mx_noise_float(Q.mul(vec3(16, 9, 16))).mul(0.32).add(mx_noise_float(Q.mul(38)).mul(0.14)).add(mx_noise_float(Q.mul(95)).mul(0.06))
  const dryPatch = smoothstep(0.1, 0.45, mx_noise_float(Q.mul(22).add(11.0)))
  let cloth: THREE.Node<"float"> = float(0)
  let core: THREE.Node<"float"> = float(0)
  let tide: THREE.Node<"float"> = float(0)
  let skinM: THREE.Node<"float"> = float(0)
  let skinWet: THREE.Node<"float"> = float(0)
  for (const w of W) {
    const d = P.sub(w.at.xyz)
    const isSkin = w.axis.w
    // Cloth soak.
    const dy = select(d.y.lessThan(0), d.y.div(w.run.x), d.y.mul(1.3))
    const r = length(vec3(d.x, dy, d.z)).div(w.at.w).add(blotch)
    const c = float(1).sub(smoothstep(0.78, 0.86, r)).mul(w.run.y).mul(float(1).sub(isSkin))
    cloth = max(cloth, c)
    core = max(core, clamp(float(1).sub(r.mul(1.45)), 0, 1).mul(w.run.y).mul(float(1).sub(isSkin)))
    // Tide-line: a thin darker band just inside the soak front.
    tide = max(tide, smoothstep(0.62, 0.76, r).mul(float(1).sub(smoothstep(0.76, 0.84, r))).mul(w.run.y).mul(float(1).sub(isSkin)))
    // Skin: streaks along the limb axis (fine across it, long along it), smears, drips, dried flakes.
    const ax = normalize(w.axis.xyz)
    const along = dot(d, ax)
    const across = length(d.sub(ax.mul(along)))
    const inside = float(1).sub(smoothstep(0.6, 1.0, length(d).div(w.at.w)))
    const streak = mx_noise_float(vec3(along.mul(9), P.x.add(P.z).mul(70), across.mul(70)))
    const smear = mx_noise_float(P.mul(24).add(5.0))
    const flake = step(0.55, mx_noise_float(P.mul(160)))
    const sm = max(smoothstep(0.18, 0.32, streak), smoothstep(0.3, 0.45, smear)).mul(float(1).sub(flake.mul(0.85)))
    skinM = max(skinM, sm.mul(inside).mul(w.run.y).mul(isSkin))
    skinWet = max(skinWet, smoothstep(0.45, 0.7, smear).mul(inside).mul(w.run.y).mul(isSkin))
  }
  const cache = new Map<THREE.Material, THREE.Material>()
  const convert = (src: THREE.Material) => {
    const hit = cache.get(src)
    if (hit) return hit
    const s = src as THREE.MeshStandardMaterial
    const m = new THREE.MeshStandardNodeMaterial()
    for (const k of ["map", "normalMap", "normalScale", "roughnessMap", "metalnessMap", "aoMap", "roughness", "metalness", "color", "side", "alphaTest", "transparent", "opacity", "name"] as const)
      if (s[k] !== undefined) (m as unknown as Record<string, unknown>)[k] = (s[k] as { clone?: () => unknown })?.clone && k !== "map" && !k.endsWith("Map") ? (s[k] as { clone: () => unknown }).clone() : s[k]
    const base = s.map ? texture(s.map) : vec4(1)
    const albedo = base.rgb.mul(color(s.color ?? new THREE.Color(1, 1, 1)))
    // Cloth: dyed by the soak (deep red to maroon, not pure red), browner and lighter where it has dried, darker
    // through to the core, a darker tide-line at the front.
    const tint = mix(STAIN, DRIED, dryPatch.mul(float(1).sub(core)).mul(0.7))
    let c = albedo.mul(mix(vec3(1, 1, 1), tint, cloth))
    c = mix(c, SOAK, smoothstep(0.15, 0.75, core).mul(0.85))
    c = c.mul(float(1).sub(tide.mul(0.35)))
    // Skin: a film of blood in streaks and smears, skin between them.
    c = mix(c, mix(SKIN_DRY, SKIN_WET, skinWet), skinM.mul(0.92))
    m.colorNode = vec4(c, base.a)
    // A wet sheen only where it is fresh: the soaked core and the wet smears; dried areas stay matte.
    m.roughnessNode = mix(materialRoughness, float(0.16), max(smoothstep(0.3, 0.8, core).mul(float(1).sub(dryPatch.mul(0.6))), skinWet.mul(0.8)))
    if (new URLSearchParams(globalThis.location?.search).has("bloodDebug")) m.emissiveNode = vec3(cloth, skinM, tide)
    m.name = `${s.name}+blood`
    cache.set(src, m)
    return m
  }
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material)
  })
}
