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
export type CorpseBlood = {
  wounds: readonly CorpseWound[]
  /** Close-cropped hair painted onto the scalp (characters whose hair cards are only a front fringe: lewis): linear
   *  colour of the stubble; the crown and back of the head above the ears take it, the face and ears don't. */
  scalp?: readonly [number, number, number]
}

const MAX_WOUNDS = 6
const SOAK = color(0x160203)
/** Blood film on skin: wet deep red, dried flaking maroon-brown. */
const SKIN_WET = color(0x2c0304)
const SKIN_DRY = color(0x241008)

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
    // Head wounds are on skin (face, scalp): a wound with runs, not a cloth soak.
    const skin = w.skin ?? /Hand|ForeArm|Head/.test(w.bone)
    W[i]!.at.value.set(p.x, p.y, p.z, w.radius)
    W[i]!.run.value.set(w.run ?? 1.8, w.strength ?? 1)
    // w: 0 cloth, 1 skin (hands, forearms), 2 head skin (wound + gravity runs only, no scattered smears).
    W[i]!.axis.value.set(axis.x, axis.y, axis.z, skin ? (/Head/.test(w.bone) ? 2 : 1) : 0)
  })
  const P = positionWorld
  // Cloth: a warped, multi-octave field so the soak spreads in blotches (folds and seams wick more), not a disc.
  const warp = vec3(mx_noise_float(P.mul(9).add(3.1)), mx_noise_float(P.mul(9).add(7.3)), mx_noise_float(P.mul(9).add(1.7))).mul(0.035)
  const Q = P.add(warp)
  const blotch = mx_noise_float(Q.mul(vec3(16, 9, 16))).mul(0.2).add(mx_noise_float(Q.mul(38)).mul(0.1)).add(mx_noise_float(Q.mul(95)).mul(0.05))
  // Gravity runs: noise stretched along world Y (fine across, long down) that lets the soak front reach further below.
  const runsN = mx_noise_float(Q.mul(vec3(60, 4, 60)))
  const dryPatch = smoothstep(0.1, 0.45, mx_noise_float(Q.mul(22).add(11.0)))
  let soak: THREE.Node<"float"> = float(0)
  let cloth: THREE.Node<"float"> = float(0)
  let core: THREE.Node<"float"> = float(0)
  let tide: THREE.Node<"float"> = float(0)
  let skinM: THREE.Node<"float"> = float(0)
  let skinWet: THREE.Node<"float"> = float(0)
  for (const w of W) {
    const d = P.sub(w.at.xyz)
    const isSkin = step(0.5, w.axis.w)
    const isHead = step(1.5, w.axis.w)
    // Cloth soak.
    const dy = select(d.y.lessThan(0), d.y.div(w.run.x.mul(float(1).add(smoothstep(0.1, 0.5, runsN).mul(1.4)))), d.y.mul(1.4))
    const r = length(vec3(d.x, dy, d.z)).div(w.at.w).add(blotch)
    // A continuous soak field (1 at the wound, 0 at the front); thresholded once after the loop.
    soak = max(soak, clamp(float(1).sub(r), 0, 1).mul(w.run.y).mul(float(1).sub(isSkin)))
    // Skin: streaks along the limb axis (fine across it, long along it), smears, drips, dried flakes.
    const ax = normalize(w.axis.xyz)
    const along = dot(d, ax)
    const across = length(d.sub(ax.mul(along)))
    const inside = float(1).sub(smoothstep(0.6, 1.0, length(d).div(w.at.w)))
    const streak = mx_noise_float(vec3(along.mul(9), P.x.add(P.z).mul(70), across.mul(70)))
    const smear = mx_noise_float(P.mul(24).add(5.0))
    const flake = step(0.55, mx_noise_float(P.mul(160)))
    const sm = max(smoothstep(0.18, 0.32, streak), smoothstep(0.3, 0.45, smear)).mul(float(1).sub(flake.mul(0.85)))
    // Wound core on skin: a solid glossy patch with noisy edges; on the head, runs from it straight down (gravity).
    const rr = length(vec3(d.x, dy, d.z)).div(w.at.w).add(blotch.mul(0.8))
    const sCore = float(1).sub(smoothstep(0.42, 0.62, rr))
    const below = clamp(d.y.negate().div(w.at.w.mul(w.run.x).mul(1.6)), 0, 1)
    const run = smoothstep(0.55, 0.75, mx_noise_float(vec3(P.x.mul(55), d.y.mul(4), P.z.mul(55)))).mul(step(d.y, 0)).mul(float(1).sub(below))
    const runs = run.mul(float(1).sub(smoothstep(0.5, 0.9, length(vec3(d.x, 0, d.z)).div(w.at.w))))
    const headM = max(sCore, runs)
    skinM = max(skinM, mix(max(sm.mul(inside), sCore), headM, isHead).mul(w.run.y).mul(isSkin))
    skinWet = max(skinWet, max(smoothstep(0.45, 0.7, smear).mul(inside).mul(float(1).sub(isHead)), float(1).sub(smoothstep(0.15, 0.35, rr))).mul(w.run.y).mul(isSkin))
  }
  // Cloth: threshold the soak field once, with a fibre-scale noise on the threshold so the front follows the weave.
  // No partial blending anywhere: outside the front the cloth keeps its own colour (just a faint wet halo), inside it
  // is blood colour (deep red → near-black at the core), so there is no pale pink stage and no hard cut-out patches.
  const fibre = mx_noise_float(P.mul(vec3(320, 320, 320))).mul(0.035).add(mx_noise_float(P.mul(vec3(90, 140, 90))).mul(0.03))
  const t = soak.add(fibre)
  cloth = smoothstep(0.12, 0.19, t)
  // Wet halo just outside the front: the cloth goes a little darker and greyer (water wicked ahead of the blood).
  tide = smoothstep(0.05, 0.14, t).mul(float(1).sub(cloth))
  core = smoothstep(0.3, 0.75, t)
  // Scalp mask in head space: above the ear line, behind the hairline, fading at the edges.
  let scalpM: THREE.Node<"float"> = float(0)
  const head = bones.get("Head")
  if (blood.scalp && head) {
    head.updateWorldMatrix(true, false)
    head.matrixWorld.decompose(p, q, sc)
    const hp = uniform(p.clone().add(new THREE.Vector3(0, 0.06, -0.01).applyQuaternion(q)))
    const hu = uniform(new THREE.Vector3(0, 1, 0).applyQuaternion(q))
    const hf = uniform(new THREE.Vector3(0, 0, 1).applyQuaternion(q))
    const hr = uniform(new THREE.Vector3(1, 0, 0).applyQuaternion(q))
    const d = P.sub(hp)
    const up = dot(d, hu)
    const fw = dot(d, hf)
    // Ears stick out sideways at ear height: keep them skin.
    const ear = smoothstep(0.065, 0.078, dot(d, hr).abs()).mul(float(1).sub(smoothstep(0.0, 0.03, up)))
    const stub = smoothstep(-0.2, 0.4, mx_noise_float(P.mul(420)))
    scalpM = smoothstep(-0.05, -0.015, up)
      .mul(float(1).sub(smoothstep(0.06, 0.09, fw.sub(up.mul(0.45)))))
      .mul(float(1).sub(smoothstep(0.16, 0.2, length(d))))
      .mul(float(1).sub(ear))
      .mul(mix(float(0.55), float(1), stub))
  }
  const scalpColour = vec3(...((blood.scalp ?? [0, 0, 0]) as [number, number, number]))
  const cache = new Map<THREE.Material, THREE.Material>()
  const convert = (src: THREE.Material) => {
    const hit = cache.get(src)
    if (hit) return hit
    const s = src as THREE.MeshStandardMaterial
    const m = new THREE.MeshStandardNodeMaterial()
    for (const k of ["map", "normalMap", "normalScale", "roughnessMap", "metalnessMap", "aoMap", "roughness", "metalness", "color", "side", "alphaTest", "transparent", "opacity", "name"] as const)
      if (s[k] !== undefined) (m as unknown as Record<string, unknown>)[k] = (s[k] as { clone?: () => unknown })?.clone && k !== "map" && !k.endsWith("Map") ? (s[k] as { clone: () => unknown }).clone() : s[k]
    // Hair cards keep their own material: a node copy of the alpha-tested card material drew the whole scalp shell
    // (the cards' grid as a dark band round the head). Blood on the head reads on the skin beneath.
    if (/hair|lash/i.test(s.name)) {
      cache.set(src, src)
      return src
    }
    const base = s.map ? texture(s.map) : vec4(1)
    const raw = base.rgb.mul(color(s.color ?? new THREE.Color(1, 1, 1)))
    // Dead skin: skin-hued texels (r > g > b, warm) lose most of their saturation and go a little paler and greyer,
    // so the bodies don't read orange under the warm practicals. Cloth colours are untouched.
    const lum = dot(raw, vec3(0.2126, 0.7152, 0.0722))
    const warm = smoothstep(0.004, 0.03, raw.r.sub(raw.b)).mul(step(raw.g, raw.r)).mul(step(raw.b, raw.g))
    const pallor = mix(vec3(lum, lum, lum), vec3(0.62, 0.6, 0.6).mul(lum.mul(1.6)), 0.25).mul(0.8)
    const albedo = mix(raw, pallor, warm.mul(0.72))
    // Cloth: dyed by the soak (deep red to maroon, not pure red), browner and lighter where it has dried, darker
    // through to the core, a darker tide-line at the front.
    // Blood colour in the cloth: a dark rim at the front (where it dried first), deep red inside, near-black at the
    // core, browner in dried patches; darker on dark cloth (the weave's own value shows through).
    const clothLum = dot(albedo, vec3(0.2126, 0.7152, 0.0722))
    const rim = float(1).sub(smoothstep(0.17, 0.26, t))
    let bloodC = mix(color(0x4a080a), SOAK, core)
    bloodC = mix(bloodC, color(0x2e0a07), dryPatch.mul(float(1).sub(core)).mul(0.45))
    bloodC = bloodC.mul(float(1).sub(rim.mul(0.4))).mul(clothLum.mul(0.9).add(0.35).min(1))
    // The soak is for fabric. Where the texel is skin (neck, jaw, face under a neck wound) the same field becomes runs
    // of blood down the skin instead: a cloth soak across the face read as a red mask over the eyes.
    const onCloth = cloth.mul(float(1).sub(warm))
    const onSkin = cloth.mul(warm).mul(max(smoothstep(0.25, 0.55, runsN), smoothstep(0.35, 0.6, t)))
    let c = albedo.mul(float(1).sub(tide.mul(0.28).mul(float(1).sub(warm))))
    c = mix(c, bloodC, onCloth)
    c = mix(c.mul(0.7), mix(SKIN_DRY, SKIN_WET, smoothstep(0.4, 0.8, t)), onSkin.mul(0.95)).add(c.mul(0.3).mul(float(1).sub(onSkin)))
    // Skin: a film of blood in streaks and smears, skin between them.
    // Skin under and around blood darkens, then the film itself.
    c = c.mul(float(1).sub(smoothstep(0, 0.6, skinM).mul(0.35)))
    c = mix(c, mix(SKIN_DRY, SKIN_WET, skinWet), skinM.mul(0.95))
    if (blood.scalp && !/hair|lash/i.test(s.name)) c = mix(c, scalpColour, scalpM.mul(float(1).sub(skinM)).mul(0.92))
    m.colorNode = vec4(c, base.a)
    // A wet sheen only where it is fresh: the soaked core and the wet smears; dried areas stay matte.
    m.roughnessNode = mix(materialRoughness, float(0.12), max(onCloth.mul(smoothstep(0.1, 0.6, core)).max(onSkin.mul(0.8)).mul(float(1).sub(dryPatch.mul(0.7))), skinWet.mul(0.9)))
    const dbg = new URLSearchParams(globalThis.location?.search).get("bloodDebug")
    if (dbg === "rough") m.roughnessNode = float(1)
    else if (dbg === "albedo") m.emissiveNode = c
    else if (dbg !== null) m.emissiveNode = vec3(cloth, skinM, scalpM)
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
