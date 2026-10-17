import * as THREE from "three/webgpu"
import {
  Fn as TslFn,
  If,
  Loop as TslLoop,
  atan,
  dot,
  abs,
  exp,
  float,
  getViewPosition,
  int,
  interleavedGradientNoise,
  length,
  luminance,
  max,
  metalness,
  min,
  mix,
  mrt,
  normalView,
  output,
  packNormalToRGB,
  pass,
  pow,
  roughness,
  rtt,
  sample,
  screenCoordinate,
  screenUV,
  smoothstep,
  sqrt,
  sRGBTransferOETF,
  tan,
  uniform,
  uniformArray,
  unpackRGBToNormal,
  uv,
  vec2,
  vec3,
  vec4,
  velocity,
} from "three/tsl"
import { bloom } from "three/addons/tsl/display/BloomNode.js"
import { ssr } from "three/addons/tsl/display/SSRNode.js"
import { ao } from "three/addons/tsl/display/GTAONode.js"
import { taau } from "three/addons/tsl/display/TAAUNode.js"
import type { WorldContext } from "../world/context"
import { fogSigma, fogTransmittance, insideBuilding } from "./atmosphere"
import { addControls, flag, num, renderState, type LampRuntime } from "./shared"

// The frame: one scene pass with a small G-buffer (normals, metal/rough, velocity), then at reduced resolution the
// lamps' single-scattering in the fog (equiangular-sampled per light, cone- and phase-aware), streaky wet-surface SSR
// and GTAO, composited in HDR, TRAA-resolved, bloomed softly and finished with an AgX film look (teal lifted blacks,
// warm highlights), grain, vignette and dither.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any
const Fn = TslFn as N
const Loop = TslLoop as N

/** Lights the fog scattering pass evaluates per pixel (the flashlight takes slot 0 when on). */
const MAX_SCATTER = 24

export function createPost(ctx: WorldContext) {
  addControls(ctx, [
    {
      key: "post.renderScale",
      label: "3D resolution (samples per CSS px)",
      group: "Performance",
      unit: "×",
      min: 0.5,
      max: 2,
      step: 0.05,
      value: 1,
    },
    { key: "post.autoRes", label: "Auto resolution (hold 60 fps)", group: "Performance", type: "toggle", value: true },
    { key: "post.minScale", label: "Auto resolution floor", group: "Performance", unit: "×", min: 0.4, max: 1, step: 0.05, value: 0.6 },
    { key: "post.maxDpr", label: "Output pixel ratio cap", group: "Performance", unit: "×", min: 1, max: 2, step: 0.25, value: 2 },
    { key: "post.taa", label: "Temporal AA + upscale (TAAU)", group: "Performance", type: "toggle", value: true },
    {
      key: "post.debug",
      label: "Show buffer",
      group: "Performance",
      type: "select",
      options: [
        { value: "final", label: "Final image" },
        { value: "scatter", label: "Fog in-scattering" },
        { value: "ssr", label: "Reflections" },
        { value: "ao", label: "Ambient occlusion" },
        { value: "rough", label: "Roughness / SSR weight" },
      ],
      value: "final",
    },
    { key: "scatter.strength", label: "Lamp light in fog", group: "Fog scattering", unit: "×", min: 0, max: 6, step: 0.05, value: 0.3 },
    { key: "scatter.halo", label: "Halo (side leak)", group: "Fog scattering", min: 0, max: 0.5, step: 0.005, value: 0.05 },
    { key: "scatter.reflection", label: "Glow reflected on wet ground", group: "Fog scattering", unit: "×", min: 0, max: 4, step: 0.05, value: 1 },
    { key: "scatter.forward", label: "Forward scattering (g)", group: "Fog scattering", min: 0, max: 0.9, step: 0.01, value: 0.6 },
    {
      key: "scatter.samples",
      label: "Samples per light",
      group: "Fog scattering",
      type: "select",
      options: [
        { value: 2, label: "2" },
        { value: 3, label: "3" },
        { value: 4, label: "4" },
        { value: 6, label: "6" },
        { value: 8, label: "8" },
      ],
      value: 4,
    },
    { key: "scatter.lights", label: "Lights evaluated", group: "Fog scattering", min: 0, max: MAX_SCATTER, step: 1, value: 16 },
    { key: "post.exposure", label: "Exposure", group: "Camera", unit: "EV", min: -6, max: 4, step: 0.05, value: -2 },
    { key: "post.interiorExposure", label: "Indoor exposure offset", group: "Camera", unit: "EV", min: -4, max: 2, step: 0.05, value: -1 },
    { key: "post.bloom", label: "Bloom", group: "Camera", min: 0, max: 1.5, step: 0.01, value: 0.22 },
    { key: "post.bloomRadius", label: "Bloom radius", group: "Camera", min: 0, max: 1, step: 0.01, value: 0.75 },
    { key: "post.bloomThreshold", label: "Bloom threshold", group: "Camera", min: 0, max: 2, step: 0.01, value: 0.0 },
    { key: "post.ssr", label: "Wet reflections (SSR)", group: "Reflections", type: "toggle", value: true },
    { key: "post.ssrStrength", label: "Strength", group: "Reflections", unit: "×", min: 0, max: 3, step: 0.05, value: 1 },
    { key: "post.ssrWet", label: "Dielectric reflectance", group: "Reflections", min: 0, max: 1, step: 0.01, value: 0.5 },
    { key: "post.ssrRough", label: "Roughness cut-off", group: "Reflections", min: 0.1, max: 1, step: 0.01, value: 0.6 },
    { key: "post.ssrStreak", label: "Vertical streaking", group: "Reflections", unit: "×", min: 0, max: 4, step: 0.05, value: 1 },
    { key: "post.ssrDistance", label: "Max distance", group: "Reflections", unit: "m", min: 2, max: 80, step: 1, value: 30 },
    { key: "post.ssrQuality", label: "Ray steps indoors", group: "Reflections", min: 0.1, max: 1, step: 0.05, value: 0.6 },
    { key: "post.ssrQualityOutdoor", label: "Ray steps outdoors", group: "Reflections", min: 0.1, max: 1, step: 0.05, value: 0.3 },
    { key: "post.ssrScale", label: "Resolution indoors", group: "Reflections", unit: "× 3D res", min: 0.25, max: 1, step: 0.05, value: 0.5 },
    { key: "post.ssrScaleOutdoor", label: "Resolution outdoors", group: "Reflections", unit: "× 3D res", min: 0.25, max: 1, step: 0.05, value: 0.35 },
    { key: "post.aoScale", label: "Resolution", group: "Ambient occlusion", unit: "× 3D res", min: 0.25, max: 1, step: 0.05, value: 0.5 },
    { key: "post.aoScaleOutdoor", label: "Resolution outdoors", group: "Ambient occlusion", unit: "× 3D res", min: 0.25, max: 1, step: 0.05, value: 0.35 },
    { key: "post.aoSamples", label: "Samples", group: "Ambient occlusion", min: 4, max: 16, step: 1, value: 8 },
    { key: "post.ao", label: "Ambient occlusion", group: "Ambient occlusion", type: "toggle", value: true },
    { key: "post.aoStrength", label: "Strength", group: "Ambient occlusion", min: 0, max: 1, step: 0.01, value: 0.7 },
    { key: "post.aoRadius", label: "Radius", group: "Ambient occlusion", unit: "m", min: 0.1, max: 3, step: 0.05, value: 0.8 },
    { key: "grade.lift", label: "Teal lift (blacks)", group: "Grade", min: 0, max: 0.1, step: 0.001, value: 0.015 },
    { key: "grade.warmth", label: "Warm highlights", group: "Grade", min: 0, max: 1, step: 0.01, value: 0.35 },
    { key: "grade.teal", label: "Teal shadows", group: "Grade", min: 0, max: 1, step: 0.01, value: 0.4 },
    { key: "grade.shoulder", label: "Highlight roll-off", group: "Grade", min: 0.3, max: 6, step: 0.05, value: 1.6 },
    { key: "grade.contrast", label: "Contrast", group: "Grade", min: 0.5, max: 1.6, step: 0.01, value: 1.08 },
    { key: "grade.saturation", label: "Saturation", group: "Grade", min: 0, max: 2, step: 0.01, value: 1.0 },
    { key: "grade.grain", label: "Film grain", group: "Grade", min: 0, max: 0.1, step: 0.001, value: 0.022 },
    { key: "grade.vignette", label: "Vignette", group: "Grade", min: 0, max: 1, step: 0.01, value: 0.35 },
    { key: "grade.aberration", label: "Chromatic aberration", group: "Grade", unit: "px", min: 0, max: 4, step: 0.1, value: 0.8 },
  ])

  const { renderer, scene, camera } = ctx
  const pipeline = new THREE.RenderPipeline(renderer)
  // Automation hook for GPU-time breakdowns (scripts drive ablations through the same settings).
  pipeline.outputColorTransform = false

  // ------------------------------------------------------------------ scene pass + G-buffer
  const scenePass = pass(scene, camera)
  const gbuffer = mrt({
    output,
    normal: packNormalToRGB(normalView),
    metalrough: vec2(metalness, roughness),
    velocity,
  }) as N
  // Material blending on every attachment: opaque surfaces still overwrite, while additive emitter glows (which
  // write zero there with zero alpha) leave the G-buffer untouched instead of punching holes in it.
  const materialBlend = new THREE.BlendMode(THREE.MaterialBlending)
  for (const name of ["normal", "metalrough", "velocity"]) gbuffer.setBlendMode(name, materialBlend)
  scenePass.setMRT(gbuffer)
  scenePass.getTexture("normal").type = THREE.UnsignedByteType
  scenePass.getTexture("metalrough").type = THREE.UnsignedByteType
  const color = scenePass.getTextureNode("output") as N
  const depth = scenePass.getTextureNode("depth") as N
  const vel = scenePass.getTextureNode("velocity") as N
  const normalTex = scenePass.getTextureNode("normal") as N
  const mrTex = scenePass.getTextureNode("metalrough") as N
  const normal = sample((u: N) => unpackRGBToNormal(normalTex.sample(u).rgb)) as N

  // Unjittered camera, refreshed before each frame.
  const projInv = uniform(new THREE.Matrix4())
  const camWorld = uniform(new THREE.Matrix4())
  const camPos = uniform(new THREE.Vector3())
  const frameNoise = uniform(0)

  /** World position and view distance of the pixel at `u` from the depth buffer (sky pushed far away). */
  const worldAt = (u: N, d: N) => {
    const vp = getViewPosition(u, d, projInv) as N
    const sky = d.greaterThanEqual(0.99999)
    const dist = sky.select(float(3000), length(vp))
    const dir = camWorld.mul(vec4(vp.normalize(), 0)).xyz.normalize()
    return { dist, dir, world: camPos.add(dir.mul(dist)) }
  }

  // ------------------------------------------------------------------ lamp light scattered in the fog
  const blank = () => Array.from({ length: MAX_SCATTER }, () => new THREE.Vector4())
  const LA = blank() // pos.xyz, range
  const LB = blank() // radiance × σ × T (rgb), cos outer
  const LC = blank() // dir.xyz, cos inner
  const lightA = uniformArray(LA, "vec4") as N
  const lightB = uniformArray(LB, "vec4") as N
  const lightC = uniformArray(LC, "vec4") as N
  const LD = blank() // near-fade radius (light only emerges into the fog beyond the fixture / lens)
  const lightD = uniformArray(LD, "vec4") as N
  const lightCount = uniform(0, "int")
  const phaseG = uniform(0.6)
  const ssrStreak = uniform(1)
  const reflStreak = ssrStreak

  const haloLeak = uniform(0.06)
  const reflWet = uniform(0.5)
  const reflRough = uniform(0.6)
  const reflStrength = uniform(1)

  /** Single-scattered lamp light along the ray ro + rd·[0, dist] (equiangular sampling per light). */
  const airlight = (ro: N, rd: N, dist: N, samples: number, jitter: N) => {
    const g = phaseG
    const g2 = g.mul(g)
    const acc = vec3(0).toVar()
    Loop(lightCount, ({ i }: { i: N }) => {
      const A = lightA.element(i)
      const B = lightB.element(i)
      const C = lightC.element(i)
      const D = lightD.element(i)
      const toL = A.xyz.sub(ro).toVar()
      const s0 = dot(toL, rd).toVar()
      const h = sqrt(max(dot(toL, toL).sub(s0.mul(s0)), 0)).max(0.03).toVar()
      const a = max(s0.sub(A.w), 0)
      const b = min(s0.add(A.w), dist)
      If(b.greaterThan(a), () => {
        // The 1/d² falloff cancels against the equiangular pdf, leaving cone, range window and phase.
        const ta = atan(a.sub(s0).div(h)).toVar()
        const tb = atan(b.sub(s0).div(h)).toVar()
        const sum = float(0).toVar()
        for (let j = 0; j < samples; j++) {
          const t = mix(ta, tb, jitter.add(j).div(samples))
          const sv = s0.add(h.mul(tan(t)))
          const lx = rd.mul(sv).sub(toL)
          const ld = length(lx).max(1e-3)
          const ln = lx.div(ld)
          // Refractor glass leaks a little light sideways, which is what draws the round halo around each head.
          const cone = smoothstep(B.w, C.w, dot(ln, C.xyz)).mul(haloLeak.oneMinus()).add(haloLeak)
          const win = ld.div(A.w).pow(4).oneMinus().clamp().pow(2).mul(smoothstep(0, D.x, ld))
          const cosT = dot(ln, rd).negate()
          const hg = g2.oneMinus().div(pow(g2.add(1).sub(g.mul(2).mul(cosT)).max(1e-4), 1.5))
          const phase = mix(float(1), hg, 0.85).mul(1 / (4 * Math.PI))
          sum.addAssign(cone.mul(win).mul(phase))
        }
        acc.addAssign(B.rgb.mul(sum).mul(tb.sub(ta)).div(h.mul(samples)))
      })
    })
    return acc
  }

  // Fog glow seen by the camera, plus the same glow seen in mirror reflection off wet ground and waxed floors: the
  // reflected ray's in-scattering is what paints the long soft lamp streaks on wet asphalt (SSR can't: the halos are
  // in front of the sky, which has no depth to hit).
  const buildScatter = (samples: number) =>
    Fn(() => {
      const u = uv()
      const d = depth.sample(u).x
      const { dist, dir: rd, world } = worldAt(u, d)
      // Interleaved gradient noise advanced by the golden ratio each frame: low-discrepancy in space and time, which
      // the temporal resolve integrates into a smooth result.
      const jitter = interleavedGradientNoise(screenCoordinate.xy).add(frameNoise.mul(0.618034)).fract()
      const acc = airlight(camPos, rd, dist, samples, jitter).toVar()
      const mr = mrTex.sample(u)
      const nW = camWorld.mul(vec4(unpackRGBToNormal(normalTex.sample(u).rgb), 0)).xyz.normalize().toVar()
      const wet = mr.g
        .smoothstep(reflRough, reflRough.mul(0.2))
        .mul(mix(reflWet, float(1), mr.r))
        .mul(smoothstep(0.55, 0.85, nW.y))
        .mul(d.lessThan(0.99999).select(float(1), float(0)))
        .toVar()
      If(wet.greaterThan(0.002), () => {
        // Rough wet surfaces smear the reflection vertically: tilt the mirror normal by a per-pixel random
        // amount along the view's vertical plane, more for rougher surfaces (temporal AA integrates it).
        const n2 = interleavedGradientNoise(screenCoordinate.xy.add(vec2(37, 11))).add(frameNoise.mul(0.754878)).fract()
        const tilt = n2.sub(0.5).mul(mr.g.mul(mr.g)).mul(reflStreak)
        const side = rd.cross(vec3(0, 1, 0)).normalize()
        const fwd = vec3(0, 1, 0).cross(side).normalize()
        const nT = nW.add(fwd.mul(tilt)).normalize()
        const rr = rd.sub(nT.mul(dot(rd, nT).mul(2))).normalize()
        const cosV = dot(rd, nW).negate().clamp(0, 1)
        const fres = float(0.04).add(float(0.96).mul(cosV.oneMinus().pow(5)))
        const T = fogTransmittance(camPos, world)
        const refl = airlight(world.add(nW.mul(0.02)), rr, float(250), Math.max(2, samples >> 1), jitter)
        acc.addAssign(refl.mul(fres).mul(wet).mul(T).mul(reflStrength))
      })
      return vec4(acc, 1)
    })()

  let scatterSamples = Number(ctx.settings["scatter.samples"])
  const scatterTex = rtt(buildScatter(scatterSamples), null, null, { resolutionScale: 0.5 } as never) as N

  // ------------------------------------------------------------------ wet reflections
  // SSR's per-pixel weight: glossy surfaces only (rough ones are discarded early), metals fully, wet dielectrics partly;
  // SSR multiplies in its own grazing Fresnel and distance fade.
  const ssrWet = uniform(0.5)
  const ssrRough = uniform(0.6)
  const ssrStrength = uniform(1)
  const mrAt = mrTex as N
  // Only floors and the wet ground reflect here (walls would just smear): weight by the world-up of the normal.
  const worldUp = camWorld.mul(vec4(unpackRGBToNormal(normalTex.rgb), 0)).y
  const ssrWeight = mrAt.g
    .smoothstep(ssrRough, ssrRough.mul(0.25))
    .mul(mix(ssrWet, float(1), mrAt.r))
    .mul(smoothstep(0.55, 0.85, worldUp))
  // A constant roughness keeps SSR's own isotropic mip blur out of the way (its mip chain is emptied so the blur
  // passes never run); the streak pass below does the roughness-dependent blur instead.
  const ssrNode = ssr(color, depth, normal, { metalnessNode: ssrWeight, roughnessNode: float(0), camera } as never) as N
  ssrNode.resolutionScale = 0.5
  ssrNode.screenEdgeFade.value = 0.15
  ssrNode._blurRenderTarget.texture.mipmaps.length = 0
  const ssrRaw = ssrNode._textureNode as N

  // Rough wet asphalt smears reflections into long vertical streaks: blur along screen Y in proportion to the
  // surface roughness and the reflected distance, only a little along X.
  const ssrSize = uniform(new THREE.Vector2(1, 1))
  const streak = Fn(() => {
    const u = uv()
    const rough = mrTex.sample(u).g
    const centre = ssrRaw.sample(u)
    const d = depth.sample(u).x
    const { dist } = worldAt(u, d)
    const hitDist = centre.a.max(1)
    // At least ~1.5 source texels of blur so the low-res reflection never shows its pixels, and a per-pixel,
    // per-frame jitter of the taps that the temporal resolve averages into a smooth streak.
    const texel = vec2(1).div(ssrSize)
    const len = ssrStreak.mul(rough.mul(rough).add(0.02)).mul(hitDist.div(dist.max(1))).mul(0.25).clamp(0, 0.12).max(texel.y.mul(1.5))
    const wide = len.mul(0.08).max(texel.x.mul(1.5))
    const j = interleavedGradientNoise(screenCoordinate.xy).add(frameNoise.mul(0.618034)).fract().sub(0.5)
    const acc = vec4(0).toVar()
    const wsum = float(0).toVar()
    const TAPS = 8
    for (let k = -TAPS; k <= TAPS; k++) {
      const f = k / TAPS
      const w = Math.exp(-f * f * 2.5)
      const o = (vec2 as N)(wide.mul(j.mul(1.6).add(f * 0.5)), len.mul(j.div(TAPS).add(f)))
      acc.addAssign(ssrRaw.sample(u.add(o)).mul(w))
      wsum.addAssign(w)
    }
    return acc.div(wsum)
  })()
  const ssrStreaked = rtt(streak, null, null, { resolutionScale: 0.5 } as never) as N

  // ------------------------------------------------------------------ ambient occlusion
  const aoNode = ao(depth, normal, camera) as N
  aoNode.resolutionScale = 0.5
  aoNode.samples.value = 8
  const aoTex = aoNode.getTextureNode() as N
  const aoStrength = uniform(0.7)

  // ------------------------------------------------------------------ composite (HDR)
  const lastFlags = { ssr: true, ao: true, taa: true, debug: "final" }
  const exposure = uniform(1)
  const bloomNodeRef: { node: N } = { node: null }
  const grade = {
    lift: uniform(0.028),
    warmth: uniform(0.35),
    teal: uniform(0.4),
    contrast: uniform(1.08),
    saturation: uniform(1.15),
    grain: uniform(0.06),
    vignette: uniform(0.35),
    aberration: uniform(0.8),
    shoulder: uniform(1.6),
  }
  const resolution = uniform(new THREE.Vector2(1, 1))

  /** Joint bilateral upsample of a low-res buffer (fog light, reflections), guided by full-res depth. */
  const halfSize = uniform(new THREE.Vector2(1, 1))
  const bilateral = (tex: N, size: N, u: N, dist: N) => {
    const p = u.mul(size).sub(0.5)
    const base = p.floor()
    const f = p.sub(base)
    const acc = vec3(0).toVar()
    const wsum = float(0).toVar()
    for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const tu = base.add(vec2(ox + 0.5, oy + 0.5)).div(size)
      const bw = (ox ? f.x : f.x.oneMinus()).mul(oy ? f.y : f.y.oneMinus())
      const dz = worldAt(tu, depth.sample(tu).x).dist
      // Relative depth difference: 10 % apart is a different surface.
      const w = bw.mul(exp(abs(dz.sub(dist)).div(dist.mul(0.1).add(0.05)).negate())).add(1e-4)
      acc.addAssign(tex.sample(tu).rgb.mul(w))
      wsum.addAssign(w)
    }
    return acc.div(wsum)
  }
  const upsample = (u: N, dist: N, withSsr: boolean) => ({
    scatter: bilateral(scatterTex, halfSize, u, dist),
    ssr: withSsr ? bilateral(ssrStreaked, ssrSize, u, dist) : vec3(0),
  })
  const compositeTex = rtt(vec4(0), null, null, { resolutionScale: 1 } as never) as N
  let scaleState = { internal: -1, dpr: -1, ssr: -1, ao: -1 }
  const applyScale = () => {
    const dpr = Math.min(devicePixelRatio, num(ctx, "post.maxDpr"))
    // Internal 3D resolution relative to the output buffer; TAAU reconstructs the rest.
    const internal = Math.min(1, Math.max(0.25, (num(ctx, "post.renderScale") * autoScale) / dpr))
    // The waxed corridor floor is a near-mirror and needs the resolution; wet asphalt smears it anyway.
    const ssrScale = num(ctx, indoor > 0.5 ? "post.ssrScale" : "post.ssrScaleOutdoor")
    // AO matters indoors (corners, door frames); outdoors the fog swallows most of it, so it can run coarser.
    const aoScale = num(ctx, indoor > 0.5 ? "post.aoScale" : "post.aoScaleOutdoor")
    if (ssrScale !== scaleState.ssr || aoScale !== scaleState.ao) {
      ssrStreaked.setResolutionScale(internal * ssrScale)
      ssrNode.resolutionScale = internal * ssrScale
      aoNode.resolutionScale = internal * aoScale
      scaleState.ssr = ssrScale
      scaleState.ao = aoScale
    }
    if (Math.abs(internal - scaleState.internal) < 1e-4 && dpr === scaleState.dpr) return
    if (dpr !== scaleState.dpr) {
      renderer.setPixelRatio(dpr)
      renderer.setSize(innerWidth, innerHeight, false)
    }
    scaleState = { internal, dpr, ssr: ssrScale, ao: aoScale }
    scenePass.setResolutionScale(internal)
    compositeTex.setResolutionScale(internal)
    scatterTex.setResolutionScale(internal * 0.5)
    ssrStreaked.setResolutionScale(internal * ssrScale)
    ssrNode.resolutionScale = internal * ssrScale
    aoNode.resolutionScale = internal * aoScale
  }

  const build = () => {
    const useSsr = flag(ctx, "post.ssr")
    const useAo = flag(ctx, "post.ao")
    const useTaa = flag(ctx, "post.taa")
    const debug = String(ctx.settings["post.debug"])
    Object.assign(lastFlags, { ssr: useSsr, ao: useAo, taa: useTaa, debug })
    aoNode.useTemporalFiltering = useTaa

    const composite = Fn(() => {
      const u = uv()
      const d = depth.sample(u).x
      const { world, dist } = worldAt(u, d)
      const T = fogTransmittance(camPos, world).toVar()
      let c: N = color.sample(u).rgb
      if (useAo) c = c.mul(mix(float(1), aoTex.sample(u).r, aoStrength.mul(T)))
      // Half-resolution buffers come back through a depth-aware (joint bilateral) upsample so fog light and
      // reflections don't bleed a blocky fringe across silhouettes (poles, fence posts, door frames).
      const up = upsample(u, dist, useSsr)
      if (useSsr) c = c.add(up.ssr.mul(ssrStrength).mul(T))
      c = c.add(up.scatter)
      return vec4(c, 1)
    })()
    compositeTex.node = composite

    let resolved: N
    if (useTaa) {
      const t = taau(compositeTex, depth, vel, camera) as N
      resolved = t.getTextureNode()
    } else {
      resolved = compositeTex
    }
    const bl = bloom(resolved, 0.22, 0.75, 0) as N
    bloomNodeRef.node = bl

    const finish = Fn(() => {
      const u = uv()
      // Lens: a little lateral chromatic aberration towards the corners, sampled from the resolved HDR image.
      const off = u.sub(0.5)
      const ca = off.mul(length(off).mul(2)).mul(grade.aberration).div(resolution)
      let hdr: N = vec3(resolved.sample(u.add(ca)).r, resolved.sample(u).g, resolved.sample(u.sub(ca)).b)
      hdr = hdr.add(bl.rgb)
      hdr = hdr.mul(exposure)

      // Split-tone in scene-linear: cool teal into the shadows, sodium warmth into the highlights.
      const lum = luminance(hdr).toVar()
      const shadowW = smoothstep(0.15, 0.0, lum)
      const hiW = smoothstep(0.05, 1.5, lum)
      hdr = hdr.mul(mix(vec3(1), vec3(0.86, 1.04, 1.02), shadowW.mul(grade.teal)))
      hdr = hdr.mul(mix(vec3(1), vec3(1.12, 1.0, 0.82), hiW.mul(grade.warmth)))

      // Hue-preserving filmic curve on the max channel (sodium halos stay orange instead of going yellow-white),
      // blended towards a per-channel curve only in the hottest cores so emitters still burn out to white.
      const peak = max(max(hdr.r, hdr.g), hdr.b).max(1e-5).toVar()
      const curve = (x: N) => {
        // Toe-less shoulder: ~linear up to 0.4, rolling off to 1.
        const k = x.mul(grade.shoulder)
        return k.div(k.add(1)).mul(grade.shoulder.add(1).div(grade.shoulder))
      }
      const mapped = curve(peak).min(1)
      const huePreserve = hdr.mul(mapped.div(peak))
      const perChannel = vec3(curve(hdr.r), curve(hdr.g), curve(hdr.b)).min(1)
      let ldr: N = mix(huePreserve, perChannel, smoothstep(4, 40, peak))
      // Saturation around luminance.
      const l2 = luminance(ldr)
      ldr = mix(vec3(l2), ldr, grade.saturation).max(0)
      ldr = sRGBTransferOETF(ldr)
      // Contrast around mid-grey, then the lifted teal floor of a night film print.
      ldr = ldr.sub(0.42).mul(grade.contrast).add(0.42).clamp()
      const liftCol = vec3(0.55, 1.05, 1.0).mul(grade.lift)
      ldr = liftCol.add(ldr.mul(vec3(1).sub(liftCol)))

      // Vignette (gentle, slightly oval like a lens).
      const v = length(off.mul(vec2(1.0, 1.15)))
      ldr = ldr.mul(mix(float(1), smoothstep(0.85, 0.25, v), grade.vignette))

      // Fine 35 mm grain: per output pixel white noise, re-rolled every frame, strongest in the shadows and mids.
      // At output resolution (after the upscale) so it is one physical pixel, never a block.
      const p = screenCoordinate.xy
      const hash = (q: N) => {
        const w = vec3(q.x, q.y, frameNoise.mul(17.31)).mul(vec3(0.1031, 0.103, 0.0973)).fract().toVar()
        const w2 = w.add(dot(w, w.yzx.add(33.33)))
        return w2.x.add(w2.y).mul(w2.z).fract()
      }
      const nn = hash(p.floor()).add(hash(p.floor().add(vec2(57.3, 19.1)))).sub(1).mul(0.7)
      const gl = luminance(ldr)
      const amt = grade.grain.mul(mix(float(0.55), float(1), smoothstep(0.9, 0.15, gl)))
      ldr = ldr.add(nn.mul(amt).mul(vec3(1, 0.97, 1.02)))

      // Dither before 8-bit quantisation.
      const dn = interleavedGradientNoise(p.add(vec2(frameNoise.mul(5.3), 0))).sub(0.5).div(255)
      return vec4(ldr.add(dn).clamp(), 1)
    })()

    const show: Record<string, N> = {
      scatter: (vec4 as N)((sRGBTransferOETF as N)(scatterTex.sample(uv()).rgb.mul(exposure).mul(4).clamp()), 1),
      ssr: (vec4 as N)((sRGBTransferOETF as N)(ssrStreaked.sample(uv()).rgb.mul(exposure).mul(4).clamp()), 1),
      ao: (vec4 as N)((vec3 as N)(aoTex.sample(uv()).r), 1),
      rough: (vec4 as N)(mrTex.sample(uv()).g, ssrWeight, mrTex.sample(uv()).r, 1),
    }
    pipeline.outputNode = show[debug] ?? finish
    pipeline.needsUpdate = true
  }
  build()

  // ------------------------------------------------------------------ per-frame
  const candidates: LampRuntime[] = []
  const frustum = new THREE.Frustum()
  const projView = new THREE.Matrix4()
  const sphere = new THREE.Sphere()
  let frame = 0
  let indoor = 0

  const pushLight = (i: number, pos: THREE.Vector3, range: number, rad: THREE.Color, k: number, dir: THREE.Vector3 | null, co: number, ci: number, near: number) => {
    LD[i]!.set(near, 0, 0, 0)
    LA[i]!.set(pos.x, pos.y, pos.z, range)
    LB[i]!.set(rad.r * k, rad.g * k, rad.b * k, co)
    LC[i]!.set(dir?.x ?? 0, dir?.y ?? -1, dir?.z ?? 0, ci)
  }

  // Dynamic resolution: when frames run long for a while, step the 3D resolution down (TAAU keeps the output sharp);
  // when they have been comfortably on time for a few seconds, step back up. Steps are coarse and rate-limited so
  // render targets are not reallocated constantly; captures (`?shot`) keep a fixed resolution.
  let autoScale = 1
  let lastNow = 0
  const recent: number[] = []
  let calmSince = 0
  let holdUntil = 0
  let backoff = 3000
  const autoResolution = (now: number) => {
    const enabled = flag(ctx, "post.autoRes") && !ctx.params.has("shot")
    if (!enabled) {
      autoScale = 1
      return
    }
    const dt = lastNow ? now - lastNow : 16
    lastNow = now
    if (dt > 250) return // tab switch, breakpoint, loading hitch
    recent.push(dt)
    if (recent.length > 40) recent.shift()
    if (recent.length < 40 || now < holdUntil) return
    const sorted = [...recent].sort((a, b) => a - b)
    const median = sorted[20]!
    const floor = num(ctx, "post.minScale")
    if (median > 18.5 && autoScale > floor) {
      autoScale = Math.max(floor, autoScale - 0.1)
      recent.length = 0
      holdUntil = now + 600
      calmSince = now
      backoff = Math.min(backoff * 2, 30000)
    } else if (median < 17.4 && autoScale < 1) {
      if (now - calmSince > backoff) {
        autoScale = Math.min(1, autoScale + 0.1)
        recent.length = 0
        holdUntil = now + 600
        calmSince = now
      }
    } else if (median >= 17.4) {
      calmSince = now
    }
  }

  const api = {
    render() {
      frame++
      autoResolution(performance.now())
      applyScale()
      if (
        flag(ctx, "post.ssr") !== lastFlags.ssr ||
        flag(ctx, "post.ao") !== lastFlags.ao ||
        flag(ctx, "post.taa") !== lastFlags.taa ||
        String(ctx.settings["post.debug"]) !== lastFlags.debug
      ) {
        build()
      }
      const samples = Number(ctx.settings["scatter.samples"])
      if (samples !== scatterSamples) {
        scatterSamples = samples
        scatterTex.node = buildScatter(samples)
        pipeline.needsUpdate = true
      }

      camera.updateMatrixWorld()
      camera.updateProjectionMatrix()
      projInv.value.copy(camera.projectionMatrixInverse)
      camWorld.value.copy(camera.matrixWorld)
      camPos.value.setFromMatrixPosition(camera.matrixWorld)
      frameNoise.value = frame % 64
      renderer.getDrawingBufferSize(resolution.value)
      ssrSize.value.set(
        Math.max(1, Math.floor(resolution.value.x * scaleState.internal * scaleState.ssr)),
        Math.max(1, Math.floor(resolution.value.y * scaleState.internal * scaleState.ssr)),
      )
      halfSize.value.set(
        Math.max(1, Math.floor(resolution.value.x * scaleState.internal * 0.5)),
        Math.max(1, Math.floor(resolution.value.y * scaleState.internal * 0.5)),
      )

      // Pick the lamps whose light in the fog matters most to this view.
      projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      frustum.setFromProjectionMatrix(projView)
      candidates.length = 0
      for (const r of renderState.lamps) {
        if (r.level <= 0.01 || r.sigma <= 0) continue
        sphere.set(r.pos, r.lamp.range)
        if (!frustum.intersectsSphere(sphere)) continue
        candidates.push(r)
      }
      const score = (r: LampRuntime) => (r.lamp.intensity * r.level * r.sigma * r.transmittance) / Math.max(r.distance - r.lamp.range, 1)
      candidates.sort((a, b) => score(b) - score(a))
      const strength = num(ctx, "scatter.strength")
      const budget = Math.min(MAX_SCATTER, Math.round(num(ctx, "scatter.lights")))
      let count = 0
      const f = renderState.flash
      if (f.on && budget > 0) {
        // The flashlight is at the camera, so its own fog (σ there) and no extinction to the eye.
        const sigma = fogSigma(camPos.value)
        pushLight(count++, f.pos, f.range, f.radiance, sigma, f.dir, f.cosOuter, f.cosInner, num(ctx, "flash.near"))
      }
      for (const r of candidates) {
        if (count >= budget) break
        pushLight(count++, r.pos, r.lamp.range, r.radiance, r.level * r.sigma * r.transmittance * strength, r.dir, r.cosOuter, r.cosInner, (r.lamp.size ?? 0.2) * 0.5)
      }
      lightCount.value = count
      phaseG.value = num(ctx, "scatter.forward")

      ssrWet.value = num(ctx, "post.ssrWet")
      ssrRough.value = num(ctx, "post.ssrRough")
      reflWet.value = ssrWet.value
      reflRough.value = ssrRough.value
      reflStrength.value = num(ctx, "scatter.reflection")
      haloLeak.value = num(ctx, "scatter.halo")
      ssrStrength.value = num(ctx, "post.ssrStrength")
      ssrStreak.value = num(ctx, "post.ssrStreak")
      ssrNode.maxDistance.value = num(ctx, "post.ssrDistance")
      ssrNode.quality.value = num(ctx, indoor > 0.5 ? "post.ssrQuality" : "post.ssrQualityOutdoor")
      aoStrength.value = num(ctx, "post.aoStrength")
      aoNode.radius.value = num(ctx, "post.aoRadius")
      aoNode.samples.value = num(ctx, "post.aoSamples")
      // Indoors (inside the building shell) the eye is adapted to the tubes, not the fog: blend an EV offset.
      const inside = insideBuilding(camPos.value) ? 1 : 0
      indoor += (inside - indoor) * (frame < 3 ? 1 : 0.03)
      exposure.value = 2 ** (num(ctx, "post.exposure") + indoor * num(ctx, "post.interiorExposure"))
      const bl = bloomNodeRef.node
      bl.strength.value = num(ctx, "post.bloom")
      bl.radius.value = num(ctx, "post.bloomRadius")
      bl.threshold.value = num(ctx, "post.bloomThreshold")
      grade.lift.value = num(ctx, "grade.lift")
      grade.warmth.value = num(ctx, "grade.warmth")
      grade.teal.value = num(ctx, "grade.teal")
      grade.contrast.value = num(ctx, "grade.contrast")
      grade.shoulder.value = num(ctx, "grade.shoulder")
      grade.saturation.value = num(ctx, "grade.saturation")
      grade.grain.value = num(ctx, "grade.grain")
      grade.vignette.value = num(ctx, "grade.vignette")
      grade.aberration.value = num(ctx, "grade.aberration")

      pipeline.render()
    },
  }
  // Automation hook for GPU-time breakdowns: scripts render frames back-to-back with settings toggled.
  if (ctx.params.has("perf")) (globalThis as { __afterhoursRender?: unknown }).__afterhoursRender = { renderer, scene, camera, settings: ctx.settings, render: api.render, state: renderState, scale: () => ({ autoScale, ...scaleState }) }
  return api
}
