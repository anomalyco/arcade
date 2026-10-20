import * as THREE from "three/webgpu"
import { Fn, attribute, cos, float, length, luminance, mix, positionLocal, sin, mx_fractal_noise_float, mx_noise_float, mx_worley_noise_vec2, normalView, positionGeometry, positionView, smoothstep, uniform, vec3 } from "three/tsl"

// The shared creature material (one draw call for skin, bone, teeth, claws and antlers). Everything procedural and
// pinned to the bind-pose position, so detail sticks to the skin as it moves:
//   attrA = ao, curvature (0.5 flat), bone, horn      attrB = dirt, blood, dangle (sway), thinness
//   fiber = baked fibre direction (xyz) and amount (w)
// Fibres: noise squashed along the baked direction gives cords that run down each limb, tendon and branch, so skin
// reads as dried sinew and antlers as fissured dead wood. Skin also gets pores and cracked-leather cells, cavity
// darkening, a wet sheen in folds (clearcoat), dried blood and dirt, and back-lit translucency through thin parts.
// Bone: chalky with pits, hairline cracks and grime.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

export type CreaturePalette = {
  skin: THREE.Color
  skinRaw: THREE.Color
  skinDark: THREE.Color
  bone: THREE.Color
  horn: THREE.Color
  hornLight: THREE.Color
}

export const WENDIGO_PALETTE: CreaturePalette = {
  skin: new THREE.Color(0.112, 0.098, 0.084),
  skinRaw: new THREE.Color(0.2, 0.1, 0.09),
  skinDark: new THREE.Color(0.028, 0.02, 0.018),
  bone: new THREE.Color(0.3, 0.28, 0.245),
  horn: new THREE.Color(0.06, 0.05, 0.042),
  hornLight: new THREE.Color(0.2, 0.18, 0.16),
}

/** Bump a view-space normal by a procedural height in metres (Mikkelsen, unnormalised so heights are true scale). */
const bump = (H: N): N => {
  const dpdx = positionView.dFdx()
  const dpdy = positionView.dFdy()
  const n = normalView
  const r1 = dpdy.cross(n)
  const r2 = n.cross(dpdx)
  const det = dpdx.dot(r1)
  const grad = det.sign().mul(H.dFdx().mul(r1).add(H.dFdy().mul(r2)))
  return det.abs().mul(n).sub(grad).normalize()
}

export type CreatureMaterialOpts = {
  /** Fibre noise frequency (per metre across the fibres): ~30 sinew cords, ~150 fine hair strands. */
  fibreFreq?: number
  /** Translucency colour scale (thin parts, back-lit). */
  sss?: number
}

export function createCreatureMaterial(pal: CreaturePalette = WENDIGO_PALETTE, opts: CreatureMaterialOpts = {}) {
  const ff = opts.fibreFreq ?? 30
  const mat = new THREE.MeshSSSNodeMaterial()
  const A = attribute("attrA", "vec4") as N
  const B = attribute("attrB", "vec4") as N
  const Fa = attribute("fiber", "vec4") as N
  const P = positionGeometry as N
  const ao = A.x
  const curv = A.y
  const boneM = A.z
  const hornM = A.w
  const dirt = B.x
  const blood = B.y
  const dangle = B.z
  const thin = B.w
  const detail = uniform(1)
  /** 0..1 overall shade (1 = normal): scripted moments darken it at very close range so it never blows out. */
  const shade = uniform(1)
  /**
   * Close-up cut (death scenes): with `cutOn`, everything but the face is discarded inside the view cone toward the
   * skull (`cutDir`, view space; `cutCos` its half-angle) when nearer than `cutDist`, and everything nearer than
   * `nearCut` to the eye. So antlers, arms and body never fill or clip the lens in front of the face.
   */
  const cutOn = uniform(0)
  const cutDir = uniform(new THREE.Vector3(0, 0, -1))
  const cutCos = uniform(0.97)
  const cutDist = uniform(0)
  const nearCut = uniform(0)
  /** Sway clock (seconds); the animator advances it, and stops it on freeze. */
  const sway = uniform(0)
  const swayAmp = uniform(1)
  const cSkin = uniform(pal.skin) as N
  const cRaw = uniform(pal.skinRaw)
  const cDark = uniform(pal.skinDark)
  const cBone = uniform(pal.bone)
  const cHorn = uniform(pal.horn)
  const cHornL = uniform(pal.hornLight)

  // Fibre striations without swirl artefacts: three noises, each stretched along one world axis (each continuous over
  // the surface), blended by how closely the baked fibre direction follows that axis. Projecting the position onto a
  // per-vertex direction instead makes neighbouring vertices sample far-apart noise and draws contour-line swirls.
  const fdir = Fa.xyz.mul(2).sub(1).normalize().toVar()
  const fam = Fa.w.mul(0.6).add(0.4)
  // Anti-aliasing of the procedural detail: the pixel's footprint on the surface (m), and a fade per noise frequency
  // that removes a band before it's finer than ~2 pixels (else it aliases into stipple that TAA turns into boiling).
  const foot = (positionView.dFdx().length().add(positionView.dFdy().length()) as N).mul(0.5).max(1e-5).toVar()
  const aa = (freq: number) => smoothstep(0.5, 0.2, foot.mul(freq)) as N
  const wA = fdir.abs().pow(vec3(4)).toVar()
  const wN = wA.div(wA.x.add(wA.y).add(wA.z).max(1e-4)).toVar()
  const along = (k: number, oct: number) => {
    const nx = mx_fractal_noise_float(P.mul(vec3(k * 0.08, k, k)), oct, 2.1, 0.55) as N
    const ny = mx_fractal_noise_float(P.mul(vec3(k, k * 0.08, k)).add(5.1), oct, 2.1, 0.55) as N
    const nz = mx_fractal_noise_float(P.mul(vec3(k, k, k * 0.08)).add(9.7), oct, 2.1, 0.55) as N
    return nx.mul(wN.x).add(ny.mul(wN.y)).add(nz.mul(wN.z))
  }
  const cordA = (along(ff, 3) as N).toVar()
  const cordB = along(ff * 4, 2) as N
  const cords = smoothstep(-0.25, 0.25, cordA).toVar() as N
  // Filtered: each band fades to its mean (0.5) as it nears the pixel size.
  const aaA = aa(ff * 2).toVar()
  const aaB = aa(ff * 8).toVar()
  const cordsF = mix(float(0.5), cords, aaA).toVar() as N
  const cordsFine = cordsF.mul(0.75).add(mix(float(0.5), smoothstep(-0.3, 0.5, cordB), aaB).mul(0.25))
  // Grooves along the grain (soft, from the stretched noise; no zero-crossing lines).
  const fissure = smoothstep(-0.15, -0.45, along(32, 1)).toVar()

  const big = (mx_fractal_noise_float(P.mul(2.7), 3, 2, 0.5) as N).toVar()
  const mid = (mx_fractal_noise_float(P.mul(15), 3, 2, 0.5) as N).toVar()
  const cells = (mx_worley_noise_vec2(P.mul(45)) as N).toVar()
  const crack = smoothstep(0.0, 0.03, cells.y.sub(cells.x)).mul(0.6).add(0.4).toVar()
  const fine = (mx_noise_float(P.mul(90)) as N).mul(aa(90))

  // ---------------------------------------------------------------- albedo
  // Skin: grey-brown dried sinew. Cord tops catch the light grey; the grooves between cords go nearly black; raw
  // pink-red shows in folds and in long streaks; big patches drift between ashen grey and reddish brown.
  const streak = smoothstep(0.1, 0.6, along(5, 2))
  // Dried sinew, desaturated: value does the work. Fibre bundles catch light, the recesses between them go nearly
  // black; mottling is value only (about ±12%), with a faint raw tint kept to the deepest folds.
  // Fine striations (thin, along the grain) are the main detail; broad cord bundles only shade them.
  const stri = mix(float(0.5), smoothstep(-0.45, 0.45, cordB), aaB).toVar()
  let skin: N = cSkin.mul(stri.mul(0.5).add(0.65)).mul(cordsF.mul(0.25).add(0.85))
  const blot = (mx_fractal_noise_float(P.mul(5.5).add(1.7), 3, 2, 0.5) as N).toVar()
  skin = skin.mul(blot.mul(0.2).add(1))
  skin = skin.mul(mix(float(0.7), crack, aa(90)).mul(0.15).add(0.85))
  skin = (mix as N)(skin, cRaw, smoothstep(0.38, 0.22, curv).mul(0.2))
  // Dark recesses: the deep grooves between fibre bundles and the folds (from curvature).
  skin = (mix as N)(skin, cDark, smoothstep(0.25, 0.0, stri).mul(fam).mul(0.6).add(smoothstep(0.45, 0.25, curv).mul(0.5)).clamp(0, 0.85))
  // Hard desaturation toward grey-brown.
  skin = (mix as N)(vec3(luminance(skin)).mul(vec3(1.04, 1.0, 0.95)), skin, 0.25)
  // Bone: chalky, pitted, cracked, grimed in hollows.
  let boneC: N = cBone.mul(big.mul(0.12).add(1)).mul(mid.mul(0.1).add(1))
  // Cell-border cracks are hairlines: only where the pixel is small enough to hold them.
  const hair = aa(300).toVar()
  boneC = boneC.mul(mix(float(0.75), float(1), smoothstep(0.0, 0.01, cells.y.sub(cells.x)).max(hair.oneMinus())))
  boneC = mix(boneC, vec3(0.12, 0.09, 0.06), smoothstep(0.46, 0.2, curv).mul(0.85).clamp(0, 1))
  // Hairline cracks and sutures.
  // A few hairline cracks: cell borders, only where a low-frequency mask allows.
  boneC = boneC.mul(mix(float(0.6), float(1), smoothstep(0.0, 0.008, cells.y.sub(cells.x)).max(smoothstep(0.2, 0.0, big)).max(hair.oneMinus())))
  boneC = boneC.mul(mix(vec3(1), vec3(0.85, 0.78, 0.68), smoothstep(-0.2, 0.6, big)))
  // Horn: dead wood / keratin, bleached on ridges, black in fissures.
  let hornC: N = mix(cHorn, cHornL, cords.mul(0.6).add(smoothstep(0.5, 0.85, curv).mul(0.3)).add(mid.mul(0.25)).clamp(0, 1))
  hornC = hornC.mul(fissure.mul(fam).oneMinus().mul(0.75).add(0.25))
  let col: N = mix(mix(skin, boneC, boneM), hornC, hornM)
  // Teeth: tagged bone 1 + horn 0.25 by the bake. Ivory to yellowed, darker toward the root.
  const toothM = boneM.mul(smoothstep(0.1, 0.2, hornM)).mul(smoothstep(0.42, 0.32, hornM)).toVar()
  const ivory = (mix as N)(vec3(0.62, 0.56, 0.42), vec3(0.78, 0.74, 0.62), smoothstep(-0.2, 0.5, mid))
  col = (mix as N)(col, ivory, toothM)
  // Inner mouth (painted dirt 1 + blood 1): near-black red, wet but not lacquered.
  // (Also the skull's own heavily bloodied inner surfaces behind the split: the cavity reads black, not red.)
  const mouthM: N = smoothstep(0.9, 1, blood).mul(smoothstep(0.9, 1, dirt)).max(smoothstep(0.55, 0.85, blood).mul(boneM.oneMinus().max(smoothstep(0.5, 0.2, curv)))).toVar()
  const grime = smoothstep(0.2, 0.9, dirt.add(mid.mul(0.4)))
  col = mix(col, vec3(0.05, 0.04, 0.03), grime.mul(0.75))
  const bl = smoothstep(0.35, 0.8, blood.add(mid.mul(0.3)))
  col = mix(col, vec3(0.035, 0.006, 0.004), bl)
  // Cavities darken even under direct light (aoNode only touches ambient).
  const cav = smoothstep(0.5, 0.18, curv).mul(mix(float(1), float(0.35), boneM))
  col = col.mul(mix(float(0.15), float(1), ao.pow(1.5))).mul(mix(float(1), float(0.3), cav))
  mat.colorNode = (mix as N)(col, vec3(0.008, 0.0045, 0.004), mouthM).mul(shade)
  {
    const face = attribute("face", "float") as N
    const pv = positionView as N
    const dist = length(pv)
    const inCone = pv.normalize().dot(cutDir).greaterThan(cutCos).and(dist.lessThan(cutDist))
    const keep = face.greaterThan(0.5).or(inCone.not()).and(dist.greaterThan(nearCut))
    mat.maskNode = cutOn.lessThan(0.5).or(keep)
  }

  // ---------------------------------------------------------------- sway: tendrils drift and swing (after skinning)
  {
    const d = dangle.pow(1.4).mul(0.035).mul(swayAmp)
    const ph = P.x.mul(6).add(P.z.mul(4)).add(P.y.mul(3))
    const off = vec3(sin(sway.mul(1.3).add(ph)).add(sin(sway.mul(2.9).add(ph.mul(1.7))).mul(0.35)), sin(sway.mul(1.1).add(ph.mul(0.7))).mul(0.25), cos(sway.mul(1.05).add(ph.mul(1.3))))
    mat.positionNode = positionLocal.add(off.mul(d))
  }

  // ---------------------------------------------------------------- relief
  const fade = smoothstep(16, 2.5, length(positionView)).mul(detail)
  const crackF = mix(float(0.7), crack, aa(90))
  const hSkin: N = mix(mid.mul(0.0005).add(crackF.mul(0.00025)), cordsFine.mul(0.0024), fam).add(fine.mul(0.00004))
  const hBone: N = crackF.mul(0.0002).add(fine.mul(0.00004))
  const hHorn: N = cordsF.mul(0.001).sub(mix(float(0), fissure, aa(64)).mul(0.0012))
  // Hanging strands are a few pixels wide at most: no relief on them (their normals would sparkle).
  const H = mix(mix(hSkin, hBone, boneM), hHorn, hornM).mul(fade).mul(smoothstep(0.35, 0.1, dangle))
  mat.normalNode = Fn(() => bump(H))()

  // ---------------------------------------------------------------- surface response
  const strand = smoothstep(0.1, 0.35, dangle)
  const wetness: N = cav.mul(0.6).mul(strand.oneMinus()).add(bl.mul(0.4)).clamp(0, 1).mul(hornM.oneMinus())
  mat.roughnessNode = mix(mix(mix(mix(mix(mix(float(0.66), float(0.62), boneM), float(0.8), hornM), float(0.4), wetness.mul(0.45)).sub(cords.mul(0.06).mul(fam).mul(hornM.oneMinus())), float(0.85), strand), float(0.16), toothM), float(0.7), mouthM)
  mat.metalnessNode = float(0)
  mat.clearcoatNode = wetness.mul(0.15).mul(mouthM.oneMinus()).mul(boneM.oneMinus()).mul(hornM.oneMinus()).add(toothM.mul(0.7))
  mat.clearcoatRoughnessNode = float(0.25)
  mat.aoNode = ao
  mat.specularIntensityNode = (((mix(float(0.5), float(0.3), dirt).mul(mix(float(1), float(0.5), hornM))).mul(shade)).mul(strand.mul(-0.6).add(1))).mul(mouthM.mul(-0.85).add(1))
  // Back-lit translucency through thin parts: a faint, dull flesh tint only (never a glow).
  mat.thicknessColorNode = vec3(0.06, 0.025, 0.02).mul(opts.sss ?? 1).mul(thin).mul(boneM.oneMinus()).mul(hornM.oneMinus()).mul(bl.oneMinus())
  mat.thicknessDistortionNode = float(0.25)
  mat.thicknessAmbientNode = float(0.0)
  mat.thicknessAttenuationNode = float(0.35)
  mat.thicknessPowerNode = float(3)
  mat.thicknessScaleNode = float(3)
  return { material: mat, uniforms: { detail, cutOn, cutDir, cutCos, cutDist, nearCut, shade, sway, swayAmp, cSkin, cRaw, cDark, cBone, cHorn, cHornL } }
}
