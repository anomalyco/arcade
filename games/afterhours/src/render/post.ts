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
  convertToTexture,
  fract,
  sin,
  sample,
  texture,
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
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js"
import { ssr } from "three/addons/tsl/display/SSRNode.js"
import { ao } from "three/addons/tsl/display/GTAONode.js"
import type { WorldContext } from "../world/context"
import { fogSigma, fogTransmittance, fogUniforms, insideBuilding } from "./atmosphere"
import { FLASH_REACH_AT, addControls, flag, num, renderState, type LampRuntime } from "./shared"
import type { LightMask } from "./clustered"
import { insideNode, segmentTouchesNode } from "./volumes"
import { sharpTaau } from "./taau"
import { taau } from "three/addons/tsl/display/TAAUNode.js"

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

/** Simple white balance: temperature shifts blue↔amber, tint green↔magenta, luminance roughly kept. */
function whiteBalance(temp: number, tint: number, out: THREE.Color) {
  out.setRGB(1 + 0.25 * temp, 1 - 0.18 * tint, 1 - 0.35 * temp)
  const l = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b
  return out.multiplyScalar(1 / l)
}

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
      // Retina: 0.9 samples per CSS px, reconstructed by TAAU to the 1.5× output and sharpened (the old 0.8 samples on a
      // 1.25× canvas, stretched 1.6× by the compositor, was the main source of blur).
      value: typeof devicePixelRatio === "number" && devicePixelRatio > 1.1 ? 0.9 : 1,
    },
    { key: "post.autoRes", label: "Auto resolution (hold 60 fps)", group: "Performance", type: "toggle", value: true },
    { key: "post.minScale", label: "Auto resolution floor", group: "Performance", unit: "×", min: 0.4, max: 1, step: 0.05, value: 0.7 },
    {
      key: "post.maxDpr",
      label: "Output pixel ratio cap (Retina)",
      group: "Performance",
      unit: "×",
      min: 1,
      max: 2,
      step: 0.25,
      // 1.5 on Retina: TAAU + sharpening at 1.5× gets within a hair of a native 2× canvas for ~2/3 of the post cost
      // (TAAU's history passes scale with output pixels); the browser's last 1.33× stretch is mild.
      value: 1.5,
    },
    { key: "post.taa", label: "Temporal AA + upscale (TAAU)", group: "Performance", type: "toggle", value: true },
    { key: "post.taaSharp", label: "TAAU: stable sharp resolve (off = three's stock TAAU)", group: "Performance", type: "toggle", value: true },
    { key: "post.taaSharpness", label: "TAAU resolve sharpness (at rest)", group: "Performance", min: 0, max: 1, step: 0.05, value: 0.4 },
    { key: "post.sharpness", label: "Sharpness (contrast-adaptive)", group: "Camera", min: 0, max: 1, step: 0.05, value: 0.6 },
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
    { key: "scatter.strength", label: "Lamp light in fog", group: "Fog scattering", unit: "×", min: 0, max: 6, step: 0.05, value: 0.12 },
    { key: "scatter.halo", label: "Halo (side leak)", group: "Fog scattering", min: 0, max: 0.5, step: 0.005, value: 0.03 },
    { key: "scatter.reflection", label: "Glow reflected on wet ground", group: "Fog scattering", unit: "×", min: 0, max: 4, step: 0.05, value: 4 },
    { key: "scatter.coneLength", label: "Visible cone length", group: "Fog scattering", unit: "m", min: 1, max: 40, step: 0.5, value: 4.5 },
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
    { key: "scatter.lights", label: "Lights evaluated outdoors", group: "Fog scattering", min: 0, max: MAX_SCATTER, step: 1, value: 16 },
    { key: "scatter.lightsIndoor", label: "Lights evaluated indoors", group: "Fog scattering", min: 0, max: MAX_SCATTER, step: 1, value: 8 },
    { key: "post.exposure", label: "Exposure", group: "Camera", unit: "EV", min: -6, max: 4, step: 0.05, value: -2.2 },
    { key: "post.interiorExposure", label: "Indoor exposure offset", group: "Camera", unit: "EV", min: -4, max: 2, step: 0.05, value: -1 },
    { key: "post.bloom", label: "Bloom", group: "Camera", min: 0, max: 1.5, step: 0.01, value: 0.26 },
    { key: "post.bloomRadius", label: "Bloom radius", group: "Camera", min: 0, max: 1, step: 0.01, value: 0.75 },
    { key: "post.bloomThreshold", label: "Bloom threshold", group: "Camera", min: 0, max: 2, step: 0.01, value: 0.0 },
    // The bloom is a diffusion-filter glow over the whole (dark) frame plus glare round emitters. Lit surfaces only
    // feed it up to a cap (in exposed, display-linear units), so a bright room seen up close doesn't drown in its own
    // veil (the booth read as thick orange haze); emitter cores above the hot level bloom fully again.
    { key: "post.bloomSurfaceCap", label: "Bloom: lit-surface cap (exposed)", group: "Camera", min: 0.005, max: 2, step: 0.005, value: 0.02 },
    { key: "post.bloomHot", label: "Bloom: emitter level (exposed)", group: "Camera", min: 0.5, max: 20, step: 0.1, value: 4 },
    { key: "post.ssr", label: "Wet reflections (SSR)", group: "Reflections", type: "toggle", value: true },
    { key: "post.ssrAccumulate", label: "Temporal accumulation (stable at rest)", group: "Reflections", type: "toggle", value: true },
    { key: "post.ssrStrength", label: "Strength", group: "Reflections", unit: "×", min: 0, max: 3, step: 0.05, value: 1.3 },
    { key: "post.ssrWet", label: "Dielectric reflectance", group: "Reflections", min: 0, max: 1, step: 0.01, value: 0.5 },
    { key: "post.ssrRough", label: "Roughness cut-off", group: "Reflections", min: 0.1, max: 1, step: 0.01, value: 0.85 },
    { key: "post.ssrStreak", label: "Vertical streaking", group: "Reflections", unit: "×", min: 0, max: 4, step: 0.05, value: 2.2 },
    { key: "post.ssrDistance", label: "Max distance", group: "Reflections", unit: "m", min: 2, max: 80, step: 1, value: 30 },
    { key: "post.glint", label: "Lamp glints on wet ground", group: "Reflections", unit: "×", min: 0, max: 4, step: 0.05, value: 2 },
    { key: "post.ssrQuality", label: "Ray steps indoors", group: "Reflections", min: 0.1, max: 1, step: 0.05, value: 0.6 },
    { key: "post.ssrQualityOutdoor", label: "Ray steps outdoors", group: "Reflections", min: 0.1, max: 1, step: 0.05, value: 0.2 },
    { key: "post.ssrScale", label: "Resolution indoors", group: "Reflections", unit: "× 3D res", min: 0.25, max: 1, step: 0.05, value: 0.5 },
    { key: "post.ssrScaleOutdoor", label: "Resolution outdoors", group: "Reflections", unit: "× 3D res", min: 0.25, max: 1, step: 0.05, value: 0.25 },
    { key: "post.aoScale", label: "Resolution", group: "Ambient occlusion", unit: "× 3D res", min: 0.25, max: 1, step: 0.05, value: 0.5 },
    { key: "post.aoScaleOutdoor", label: "Resolution outdoors", group: "Ambient occlusion", unit: "× 3D res", min: 0.25, max: 1, step: 0.05, value: 0.35 },
    { key: "post.aoSamples", label: "Samples", group: "Ambient occlusion", min: 4, max: 16, step: 1, value: 8 },
    { key: "post.ao", label: "Ambient occlusion", group: "Ambient occlusion", type: "toggle", value: true },
    { key: "post.aoStrength", label: "Strength", group: "Ambient occlusion", min: 0, max: 1, step: 0.01, value: 0.7 },
    { key: "post.aoRadius", label: "Radius", group: "Ambient occlusion", unit: "m", min: 0.1, max: 3, step: 0.05, value: 0.8 },
    { key: "grade.lift", label: "Teal lift (blacks)", group: "Grade", min: 0, max: 0.1, step: 0.001, value: 0.018 },
    { key: "grade.warmth", label: "Warm highlights", group: "Grade", min: 0, max: 1, step: 0.01, value: 0.12 },
    { key: "grade.teal", label: "Teal shadows", group: "Grade", min: 0, max: 1, step: 0.01, value: 0.6 },
    { key: "grade.shoulder", label: "Highlight roll-off", group: "Grade", min: 0.3, max: 6, step: 0.05, value: 1.6 },
    { key: "grade.contrast", label: "Contrast", group: "Grade", min: 0.5, max: 1.6, step: 0.01, value: 1.12 },
    { key: "grade.saturation", label: "Saturation", group: "Grade", min: 0, max: 2, step: 0.01, value: 0.92 },
    // Fine and faint by default: a re-rolled per-pixel grain reads as shimmer on a still frame.
    { key: "grade.grain", label: "Film grain", group: "Grade", min: 0, max: 0.1, step: 0.001, value: 0.008 },
    { key: "grade.temperature", label: "White balance: temperature", group: "Grade", unit: "← blue · amber →", min: -1, max: 1, step: 0.01, value: -0.12 },
    { key: "grade.tint", label: "White balance: tint", group: "Grade", unit: "← green · magenta →", min: -1, max: 1, step: 0.01, value: -0.04 },
    { key: "grade.gamma", label: "Mid-tone curve (gamma)", group: "Grade", min: 0.6, max: 1.6, step: 0.01, value: 1.06 },
    { key: "grade.warmSaturation", label: "Warm-hue saturation (practicals)", group: "Grade", min: 0, max: 2, step: 0.01, value: 1.4 },
    { key: "grade.halation", label: "Halation", group: "Grade", min: 0, max: 1, step: 0.01, value: 0.08 },
    { key: "grade.distortion", label: "Lens distortion (barrel)", group: "Grade", min: -0.1, max: 0.15, step: 0.005, value: 0 },
    { key: "grade.interiorTemperature", label: "Indoor temperature", group: "Grade", unit: "← blue · amber →", min: -1, max: 1, step: 0.01, value: 0.25 },
    { key: "grade.interiorTint", label: "Indoor tint", group: "Grade", unit: "← green · magenta →", min: -1, max: 1, step: 0.01, value: -0.45 },
    { key: "grade.interiorExposure", label: "Indoor grade exposure", group: "Grade", unit: "EV", min: -2, max: 2, step: 0.05, value: 0 },
    { key: "rain.on", label: "Drizzle (streaks in lamp light)", group: "Weather", type: "toggle", value: false },
    { key: "rain.brightness", label: "Drizzle catch-light", group: "Weather", unit: "×", min: 0, max: 100, step: 1, value: 30 },
    { key: "rain.amount", label: "Drizzle density", group: "Weather", min: 0, max: 1, step: 0.01, value: 0.6 },
    { key: "post.dof", label: "Depth of field", group: "Camera", type: "toggle", value: false },
    { key: "post.dofFocus", label: "Focus distance", group: "Camera", unit: "m", min: 0.5, max: 60, step: 0.5, value: 8 },
    { key: "post.dofAperture", label: "Bokeh size", group: "Camera", min: 0, max: 4, step: 0.05, value: 1 },
    { key: "grade.vignette", label: "Vignette", group: "Grade", min: 0, max: 1, step: 0.01, value: 0.45 },
    { key: "grade.aberration", label: "Chromatic aberration", group: "Grade", unit: "px", min: 0, max: 4, step: 0.1, value: 0 },
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

  // Reversed-Z (renderer option): the cleared far plane is depth 0 instead of 1.
  const reversedZ = (renderer as unknown as { reversedDepthBuffer?: boolean }).reversedDepthBuffer === true
  const isSky = (d: N) => (reversedZ ? d.lessThanEqual(1e-6) : d.greaterThanEqual(0.99999))

  /** World position and view distance of the pixel at `u` from the depth buffer (sky pushed far away). */
  const worldAt = (u: N, d: N) => {
    const vp = getViewPosition(u, d, projInv) as N
    const sky = isSky(d)
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
  const LE = blank() // raw emitter output (rgb, before fog scaling) and local fog extinction, for wet glints
  const lightE = uniformArray(LE, "vec4") as N
  // The flashlight's adapted floor (lighting.ts `flashColorNode`): reach lux at FLASH_REACH_AT / candela (0: none),
  // and its falloff exponent.
  const LF = blank()
  const lightF = uniformArray(LF, "vec4") as N
  const glintStrength = uniform(1)
  const lightCount = uniform(0, "int")
  const phaseG = uniform(0.6)
  const ssrStreak = uniform(1)
  const reflStreak = ssrStreak

  const haloLeak = uniform(0.06)
  const coneLen = uniform(6)
  const reflWet = uniform(0.5)
  const reflRough = uniform(0.6)
  const reflStrength = uniform(1)

  /** Single-scattered lamp light along the ray ro + rd·[0, dist] (equiangular sampling per light). */
  const airlight = (ro: N, rd: N, dist: N, samples: number, jitter: N) => {
    // Rays that never come near a building skip the per-sample interior test (most outdoor pixels).
    const touches = segmentTouchesNode(ro, rd, dist.min(400)).toVar()
    const g = phaseG
    const g2 = g.mul(g)
    const acc = vec3(0).toVar()
    Loop(lightCount, ({ i }: { i: N }) => {
      const A = lightA.element(i)
      const B = lightB.element(i)
      const C = lightC.element(i)
      const D = lightD.element(i)
      const Fb = lightF.element(i)
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
          // Walls bound lamp light in the fog as well: interior lamps only light interior haze of their storey,
          // exterior lamps only the outdoor fog (soft across doorways).
          const sp = ro.add(rd.mul(sv))
          const ins = float(0).toVar()
          If(touches, () => {
            ins.assign(insideNode(sp, 0.5))
          })
          const zoneW = D.y.greaterThan(1.5).select(ins.oneMinus(), D.y.greaterThan(0.5).select(ins, 1))
          const yW = smoothstep(D.z.sub(0.3), D.z, sp.y).mul(smoothstep(D.w.add(0.3), D.w, sp.y))
          // Visible beam length: the concept's lamps show a short soft cone under the head that dies well above the
          // ground, not a column of light all the way down (extra falloff beyond inverse-square, a stylised choice).
          const reach = Fb.x.mul(ld.mul(ld)).mul(ld.div(FLASH_REACH_AT).max(1e-3).pow(Fb.y.negate())).max(1)
          const beam = exp(ld.div(coneLen).negate()).mul(reach)
          const win = ld.div(A.w).pow(4).oneMinus().clamp().pow(2).mul(smoothstep(0, D.x, ld)).mul(zoneW).mul(yW).mul(beam)
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
        .mul(isSky(d).select(float(0), float(1)))
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
        // Emitter glints: the lamp heads themselves mirrored in the wet surface. SSR can't (the emitters are tiny and
        // the glow sprites write no depth), so each fog-scattering lamp adds a lobe around its mirror direction whose
        // width grows with roughness; with the jittered normal above it draws the long vertical streaks of r3-05.
        const g = vec3(0).toVar()
        // Anisotropic lobe around the un-jittered mirror direction: tight across (a lamp-wide streak), long along
        // the view's vertical plane (the wet-asphalt smear), both widening with roughness.
        const rm = rd.sub(nW.mul(dot(rd, nW).mul(2))).normalize()
        const across = mr.g.mul(0.02).add(0.004)
        const along = mr.g.mul(mr.g).mul(0.6).add(0.02).mul(reflStreak.mul(0.5))
        Loop(lightCount, ({ i }: { i: N }) => {
          const E = lightE.element(i)
          const toL = lightA.element(i).xyz.sub(world)
          const dl = length(toL).max(0.5)
          const L = toL.div(dl)
          const dx = dot(L.sub(rm), side)
          const dy = dot(L.sub(rm), fwd.cross(side).normalize().cross(side)).abs().add(dot(L.sub(rm), vec3(0, 1, 0)).abs())
          const lobe = exp(dx.mul(dx).div(across.mul(across)).add(dy.mul(dy).div(along.mul(along))).negate())
          // The emitter is only seen (and mirrored) from inside its cone, like its light.
          const aim = smoothstep(lightB.element(i).w.sub(0.1), lightC.element(i).w, dot(L.negate(), lightC.element(i).xyz))
          g.addAssign(E.rgb.mul(lobe).mul(aim.mul(0.9).add(0.1)).div(dl.mul(dl).add(4)).mul(exp(dl.mul(E.w).negate())))
        })
        acc.addAssign(g.mul(fres).mul(wet).mul(T).mul(glintStrength))
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
  /** 1 re-rolls the streak taps every frame (the stock behaviour, when accumulation is off). */
  const ssrJitter = uniform(0)
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
    const len = ssrStreak.mul(rough.mul(rough).add(0.02)).mul(hitDist.div(dist.max(1))).mul(0.25).clamp(0, 0.3).max(texel.y.mul(1.5))
    const wide = len.mul(0.08).max(texel.x.mul(1.5))
    // A fixed per-pixel tap offset (not re-rolled per frame): the accumulation below smooths it once, and a still
    // camera gets a still streak.
    const j = interleavedGradientNoise(screenCoordinate.xy).add(frameNoise.mul(0.618034).mul(ssrJitter)).fract().sub(0.5)
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

  // Temporal accumulation of the reflections at their own (low) resolution. The camera's TAA jitter moves every SSR
  // texel by a fraction of itself each frame, so bright reflections (lamp pools, lit windows) flickered blockwise;
  // TAAU can't absorb that because its 3×3 neighbourhood sits inside one coarse reflection texel and flickers with it.
  // History is reprojected with the surface velocity, clamped to the current 3×3 box (padded) and blended slowly at
  // rest, quickly in motion.
  const ssrHistory = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
  const ssrHistoryTex = texture(ssrHistory.texture) as N
  const ssrResponse = uniform(0.08)
  const ssrHistoryValid = uniform(0)
  const accumulate = Fn(() => {
    const u = uv()
    const texel = vec2(1).div(ssrSize)
    const cur = ssrStreaked.sample(u).toVar()
    const mn = cur.toVar()
    const mx = cur.toVar()
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
      const c = ssrStreaked.sample(u.add(texel.mul(vec2(ox, oy))))
      mn.assign(min(mn, c))
      mx.assign(max(mx, c))
    }
    const offset = vel.sample(u).xy.mul(vec2(0.5, -0.5))
    const hu = u.sub(offset)
    const inside = hu.greaterThanEqual(vec2(0)).all().and(hu.lessThanEqual(vec2(1)).all())
    const pad = mx.sub(mn).mul(0.25)
    const prev = ssrHistoryTex.sample(hu).clamp(mn.sub(pad), mx.add(pad))
    const motion = offset.mul(ssrSize).length()
    const a = inside.and(ssrHistoryValid.greaterThan(0.5)).select(mix(ssrResponse, float(1), motion.div(1.5).saturate()), float(1))
    return mix(prev, cur, a)
  })()
  const ssrAccum = rtt(accumulate, null, null, { resolutionScale: 0.5 } as never) as N
  const blitSource = texture(new THREE.Texture()) as N
  const blitMaterial = new THREE.NodeMaterial()
  blitMaterial.colorNode = blitSource.sample(uv())
  const blitQuad = new THREE.QuadMesh(blitMaterial)

  // ------------------------------------------------------------------ ambient occlusion
  const aoNode = ao(depth, normal, camera) as N
  aoNode.resolutionScale = 0.5
  aoNode.samples.value = 8
  const aoTex = aoNode.getTextureNode() as N
  const aoStrength = uniform(0.7)

  // ------------------------------------------------------------------ composite (HDR)
  const lastFlags = { ssr: true, ao: true, taa: true, taaSharp: true, debug: "final", dof: false, rain: false }
  const dofFocus = uniform(8)
  const dofBokeh = uniform(1)
  const exposure = uniform(1)
  const bloomCap = uniform(0.02)
  const bloomHot = uniform(4)
  const bloomNodeRef: { node: N } = { node: null }
  const taauRef: { node: N } = { node: null }
  const sharpness = uniform(0.5)
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
    halation: uniform(0.15),
    warmSaturation: uniform(1.35),
    distortion: uniform(0.02),
    gamma: uniform(1),
  }
  const wb = uniform(new THREE.Color(1, 1, 1))
  const interiorTint = uniform(new THREE.Color(1, 1, 1))
  const indoorU = uniform(0)
  const resolution = uniform(new THREE.Vector2(1, 1))

  // Drizzle: falling streaks in three depth layers near the camera, visible only where lamp light scatters in the
  // fog (the streaks catch the light, as in a photo of rain under a streetlight) and only in front of the surface.
  // Screen-space and analytic: one hash per layer per pixel, no particles.
  const rainAmount = uniform(0.6)
  const rainTime = uniform(0)
  const rainGain = uniform(30)
  const rainStreaks = (u: N, dist: N, light: N) => {
    const acc = float(0).toVar()
    const aspect = resolution.x.div(resolution.y)
    for (const [depthM, scale, speed] of [
      [2.5, 70, 1.9],
      [5, 120, 1.35],
      [9, 190, 1.0],
    ] as const) {
      const p = vec2(u.x.mul(aspect).mul(scale), u.y.mul(scale * 0.12).add(rainTime.mul(speed * scale * 0.12)))
      const cell = p.floor()
      const f = p.fract()
      const h = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453))
      const h2 = fract(h.mul(91.7))
      // A thin vertical streak at a random x in some cells, with a soft head/tail along its length.
      const line = smoothstep(0.06, 0.0, abs(f.x.sub(h2.mul(0.8).add(0.1))))
      const along = smoothstep(0, 0.3, f.y).mul(smoothstep(1, 0.6, f.y))
      const present = h.lessThan(rainAmount.mul(0.35))
      const inFront = smoothstep(depthM - 1, depthM + 1, dist)
      acc.addAssign(present.select(line.mul(along).mul(inFront), float(0)))
    }
    return light.mul(acc).mul(rainGain).add(fogUniforms.color.mul(0.25).mul(acc))
  }

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
    ssr: withSsr ? bilateral(ssrAccum, ssrSize, u, dist) : vec3(0),
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
      ssrAccum.setResolutionScale(internal * ssrScale)
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
    ssrAccum.setResolutionScale(internal * ssrScale)
    ssrNode.resolutionScale = internal * ssrScale
    aoNode.resolutionScale = internal * aoScale
  }

  const build = () => {
    const useSsr = flag(ctx, "post.ssr")
    const useAo = flag(ctx, "post.ao")
    const useTaa = flag(ctx, "post.taa")
    const debug = String(ctx.settings["post.debug"])
    const useDof = flag(ctx, "post.dof")
    const useRain = flag(ctx, "rain.on")
    lastFlags.rain = useRain
    lastFlags.dof = useDof
    const useSharpTaa = flag(ctx, "post.taaSharp")
    Object.assign(lastFlags, { ssr: useSsr, ao: useAo, taa: useTaa, taaSharp: useSharpTaa, debug })
    aoNode.useTemporalFiltering = useTaa

    const composite = Fn(() => {
      const u = uv()
      const d = depth.sample(u).x
      const { world, dist } = worldAt(u, d)
      const T = fogTransmittance(camPos, world).toVar()
      let c: N = color.sample(u).rgb
      // Sky pixels are skipped: with reversed-Z the cleared depth (0) isn't GTAO's "background" (≥ 1), so it shades them.
      const aoW: N = (isSky(d) as N).select(float(0), aoStrength.mul(T))
      if (useAo) c = c.mul(mix(float(1), aoTex.sample(u).r, aoW))
      // Half-resolution buffers come back through a depth-aware (joint bilateral) upsample so fog light and
      // reflections don't bleed a blocky fringe across silhouettes (poles, fence posts, door frames).
      const up = upsample(u, dist, useSsr)
      if (useSsr) c = c.add(up.ssr.mul(ssrStrength).mul(T))
      c = c.add(up.scatter)
      if (useRain) c = c.add(rainStreaks(u, dist, up.scatter))
      return vec4(c, 1)
    })()
    compositeTex.node = composite

    let resolved: N
    if (useTaa) {
      const t = useSharpTaa ? sharpTaau(compositeTex, depth, vel, camera) : (taau(compositeTex, depth, vel, camera) as N)
      taauRef.node = useSharpTaa ? t : null
      resolved = t.getTextureNode()
    } else {
      taauRef.node = null
      resolved = compositeTex
    }
    if (useDof) {
      // Optional: thin-lens depth of field on the resolved image (focus distance in metres, view-space depth).
      resolved = convertToTexture(dof(resolved, scenePass.getViewZNode(), dofFocus, float(1), dofBokeh) as N) as N
    }
    const bloomInput = Fn(() => {
      const c = resolved.sample(uv()).rgb
      const l = luminance(c).mul(exposure).max(1e-5)
      const keep = bloomCap.div(l).min(1)
      const hot = smoothstep(bloomHot, bloomHot.mul(2), l)
      return vec4(c.mul(mix(keep, float(1), hot)), 1)
    })()
    const bl = bloom(bloomInput, 0.22, 0.75, 0) as N
    bloomNodeRef.node = bl

    const finish = Fn(() => {
      const u0 = uv()
      // Lens: a touch of barrel distortion (sampled slightly zoomed so corners stay filled), then lateral chromatic
      // aberration towards the corners, from the resolved HDR image.
      const d0 = u0.sub(0.5)
      const r2 = dot(d0.mul(vec2(resolution.x.div(resolution.y), 1)), d0.mul(vec2(resolution.x.div(resolution.y), 1)))
      // Zoom by the corner's stretch so the corners stay inside the frame (sampling past the edge smeared a strip of
      // clamped, jitter-flickering edge pixels down the side).
      const aspect = resolution.x.div(resolution.y)
      const corner = aspect.mul(aspect).add(1).mul(0.25)
      const u = d0.mul(r2.mul(grade.distortion).add(1)).div(corner.mul(grade.distortion.max(0)).add(1)).add(0.5)
      const off = u.sub(0.5)
      const ca = off.mul(length(off).mul(2)).mul(grade.aberration).div(resolution)
      // Contrast-adaptive sharpening (RCAS-style) of the upscaled image, in a tone-compressed space so emitters don't
      // ring: a negative-lobe cross filter whose lobe is limited so the result never leaves the neighbours' range.
      const px = vec2(1).div(resolution)
      const centre = resolved.sample(u).rgb
      const comp = (c: N) => c.mul(exposure).div(c.mul(exposure).add(1))
      const e = comp(centre)
      const nb = comp(resolved.sample(u.add(vec2(0, px.y.negate()))).rgb)
      const nd = comp(resolved.sample(u.add(vec2(px.x.negate(), 0))).rgb)
      const nf = comp(resolved.sample(u.add(vec2(px.x, 0))).rgb)
      const nh = comp(resolved.sample(u.add(vec2(0, px.y))).rgb)
      const mn4 = min(min(nb, nd), min(nf, nh))
      const mx4 = max(max(nb, nd), max(nf, nh))
      const hitMin = mn4.div(mx4.mul(4).max(1e-5))
      const hitMax = vec3(1).sub(mx4).div(mn4.mul(4).sub(4).min(-1e-5))
      const lobeRGB = max(hitMin.negate(), hitMax)
      const lobe = max(-0.1875, min(max(max(lobeRGB.r, lobeRGB.g), lobeRGB.b), 0)).mul(sharpness)
      const sharp = nb.add(nd).add(nf).add(nh).mul(lobe).add(e).div(lobe.mul(4).add(1)).clamp(0, 0.999)
      const sharpHdr = sharp.div(vec3(1).sub(sharp)).div(exposure)
      // Lateral chromatic aberration as a delta on top (zero by default).
      let hdr: N = sharpHdr.add(vec3(resolved.sample(u.add(ca)).r, centre.g, resolved.sample(u.sub(ca)).b).sub(centre))
      // Halation: film's red-orange glow around bright sources (light scattering back off the film base), from the
      // wide bloom, weighted to the red layer.
      hdr = hdr.add(bl.rgb).add(bl.rgb.mul(vec3(1, 0.35, 0.12)).mul(grade.halation))
      hdr = hdr.mul(exposure)
      // White balance (temperature: blue↔amber, tint: green↔magenta) and the indoor grade (dim, warm-green tubes).
      hdr = hdr.mul(wb).mul(mix(vec3(1), interiorTint, indoorU))

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
      // Film keeps practicals' orange rich even in a cool, desaturated grade: warm hues (red > green > blue) get
      // their own saturation, so lit windows and sodium heads stay amber instead of drifting to beige.
      const mx = max(max(ldr.r, ldr.g), ldr.b).max(1e-5)
      const warmth = smoothstep(0.15, 0.45, ldr.r.sub(ldr.b).div(mx)).mul(smoothstep(0.02, 0.12, mx))
      ldr = mix(vec3(l2), ldr, mix(grade.saturation, grade.warmSaturation, warmth)).max(0)
      ldr = sRGBTransferOETF(ldr)
      // Contrast around mid-grey, then the lifted teal floor of a night film print.
      ldr = ldr.sub(0.42).mul(grade.contrast).add(0.42).clamp()
      // Grade curve: gamma on the mids (after contrast), keeping black and white points.
      ldr = ldr.pow(grade.gamma)
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
      ssr: (vec4 as N)((sRGBTransferOETF as N)(ssrAccum.sample(uv()).rgb.mul(exposure).mul(4).clamp()), 1),
      ao: (vec4 as N)((vec3 as N)(aoTex.sample(uv()).r), 1),
      rough: (vec4 as N)(mrTex.sample(uv()).g, ssrWeight, mrTex.sample(uv()).r, 1),
    }
    pipeline.outputNode = show[debug] ?? finish
    pipeline.needsUpdate = true
  }
  build()

  // ------------------------------------------------------------------ per-frame
  const candidates: LampRuntime[] = []
  /** Lamps whose fog light was evaluated last frame (selection hysteresis). */
  const scattering = new Set<LampRuntime>()
  const frustum = new THREE.Frustum()
  const projView = new THREE.Matrix4()
  const sphere = new THREE.Sphere()
  let frame = 0
  let indoor = 0
  const lastCamPos = new THREE.Vector3()

  const pushLight = (
    i: number,
    pos: THREE.Vector3,
    range: number,
    rad: THREE.Color,
    k: number,
    dir: THREE.Vector3 | null,
    co: number,
    ci: number,
    near: number,
    mask?: LightMask,
    raw = 0,
    sigmaHere = 0,
    reachPerCd = 0,
    throwExp = 2,
  ) => {
    LF[i]!.set(reachPerCd, throwExp, 0, 0)
    LD[i]!.set(near, mask?.mode ?? 0, mask?.y0 ?? -1e5, mask?.y1 ?? 1e5)
    LE[i]!.set(rad.r * raw, rad.g * raw, rad.b * raw, sigmaHere)
    LA[i]!.set(pos.x, pos.y, pos.z, range)
    LB[i]!.set(rad.r * k, rad.g * k, rad.b * k, co)
    LC[i]!.set(dir?.x ?? 0, dir?.y ?? -1, dir?.z ?? 0, ci)
  }

  // Dynamic resolution: when frames run long for a while, step the 3D resolution down (TAAU keeps the output sharp);
  // after a calm stretch, step back up. Hysteresis: a long median window, a 0.6 s hold after every change, and a calm
  // period before stepping up that doubles each time an up-step had to be undone (so it settles instead of
  // oscillating). Paused while the world streams in (`setBooting`) and in `?shot` captures.
  // The controller below picks a target; the applied scale glides towards it (0.25 per second, in 0.02 steps so
  // the render targets aren't reallocated every frame) instead of jumping 0.1 at once.
  let autoScale = 1
  let autoTarget = 1
  let lastNow = 0
  const recent: number[] = []
  let calmSince = 0
  let holdUntil = 0
  let backoff = 4000
  let lastUpAt = -Infinity
  let booting = false
  let glide = 0
  const autoResolution = (now: number) => {
    const enabled = flag(ctx, "post.autoRes") && !ctx.params.has("shot")
    if (!enabled) {
      autoScale = autoTarget = 1
      lastNow = 0
      return
    }
    const dt = lastNow ? now - lastNow : 16
    lastNow = now
    if (Math.abs(autoTarget - autoScale) > 1e-4) {
      glide += (Math.min(dt, 50) / 1000) * 0.25
      if (glide >= 0.02 || Math.abs(autoTarget - autoScale) <= glide) {
        autoScale += Math.sign(autoTarget - autoScale) * Math.min(glide, Math.abs(autoTarget - autoScale))
        glide = 0
      }
    }
    if (booting || dt > 250) {
      recent.length = 0
      calmSince = now
      return
    }
    recent.push(dt)
    if (recent.length > 45) recent.shift()
    if (recent.length < 45 || now < holdUntil) return
    const sorted = [...recent].sort((a, b) => a - b)
    const median = sorted[22]!
    const p80 = sorted[36]!
    const floor = num(ctx, "post.minScale")
    if (median > 18.5 && autoTarget > floor + 1e-3) {
      autoTarget = Math.max(floor, autoTarget - 0.1)
      // Undoing a recent up-step: wait much longer before trying again.
      if (now - lastUpAt < 5000) backoff = Math.min(backoff * 2, 60000)
      recent.length = 0
      holdUntil = now + 600
      calmSince = now
    } else if (p80 < 17.6 && autoTarget < 1 - 1e-3) {
      if (now - calmSince > backoff) {
        autoTarget = Math.min(1, autoTarget + 0.1)
        lastUpAt = now
        recent.length = 0
        holdUntil = now + 600
        calmSince = now
      }
    } else if (p80 >= 17.6) {
      calmSince = now
    }
  }

  const api = {
    /** Pause dynamic resolution while the world streams in (capped/hitchy frames are not a GPU-cost signal). */
    setBooting(on: boolean) {
      booting = on
      renderState.streaming = on
    },
    render() {
      frame++
      autoResolution(performance.now())
      applyScale()
      if (
        flag(ctx, "post.ssr") !== lastFlags.ssr ||
        flag(ctx, "post.ao") !== lastFlags.ao ||
        flag(ctx, "post.taa") !== lastFlags.taa ||
        flag(ctx, "post.taaSharp") !== lastFlags.taaSharp ||
        String(ctx.settings["post.debug"]) !== lastFlags.debug ||
        flag(ctx, "post.dof") !== lastFlags.dof ||
        flag(ctx, "rain.on") !== lastFlags.rain
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
      renderState.pixelAngle =
        (2 * Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360)) / Math.max(1, renderer.domElement.height * scaleState.internal)
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
        if (r.level <= 0.01 || r.vis <= 0.001 || r.sigma <= 0) continue
        sphere.set(r.pos, r.lamp.range)
        if (!frustum.intersectsSphere(sphere)) continue
        candidates.push(r)
      }
      // Ranked by nominal output (not the flicker level, which reshuffled the budget every frame and popped other lamps'
      // fog in and out), with a bonus for lamps already in the set so near-ties don't swap back and forth.
      const score = (r: LampRuntime) =>
        ((r.lamp.intensity * r.vis * r.sigma * r.transmittance) / Math.max(r.distance - r.lamp.range, 1)) * (scattering.has(r) ? 1.5 : 1)
      candidates.sort((a, b) => score(b) - score(a) || a.lamp.position[0] - b.lamp.position[0] || a.lamp.position[2] - b.lamp.position[2])
      const strength = num(ctx, "scatter.strength")
      const budget = Math.min(MAX_SCATTER, Math.round(num(ctx, indoor > 0.5 ? "scatter.lightsIndoor" : "scatter.lights")))
      let count = 0
      const f = renderState.flash
      if (f.on && budget > 0) {
        // The flashlight is at the camera, so its own fog (σ there) and no extinction to the eye.
        const sigma = fogSigma(camPos.value)
        pushLight(count++, f.pos, f.range, f.radiance, sigma, f.dir, f.cosOuter, f.cosInner, num(ctx, "flash.near"), undefined, 0, 0, num(ctx, "flash.reach") / Math.max(f.candela ?? 0, 1e-3), num(ctx, "flash.throw"))
      }
      scattering.clear()
      for (const r of candidates) {
        if (count >= budget) break
        scattering.add(r)
        pushLight(count++, r.pos, r.lamp.range, r.radiance, r.level * r.vis * r.sigma * r.transmittance * strength, r.dir, r.cosOuter, r.cosInner, (r.lamp.size ?? 0.2) * 0.5, r.mask, r.level * r.vis, r.sigma)
      }
      lightCount.value = count
      phaseG.value = num(ctx, "scatter.forward")

      ssrWet.value = num(ctx, "post.ssrWet")
      ssrRough.value = num(ctx, "post.ssrRough")
      reflWet.value = ssrWet.value
      reflRough.value = ssrRough.value
      reflStrength.value = num(ctx, "scatter.reflection")
      haloLeak.value = num(ctx, "scatter.halo")
      coneLen.value = num(ctx, "scatter.coneLength")
      rainTime.value = performance.now() / 1000
      rainAmount.value = num(ctx, "rain.amount")
      rainGain.value = num(ctx, "rain.brightness")
      glintStrength.value = num(ctx, "post.glint")
      ssrStrength.value = num(ctx, "post.ssrStrength")
      ssrStreak.value = num(ctx, "post.ssrStreak")
      ssrNode.maxDistance.value = num(ctx, "post.ssrDistance")
      // SSR spends `quality` steps per reflection texel, so fewer texels (lower 3D or reflection resolution) meant
      // coarser steps that missed thin hits and dimmed the reflections at each auto-res step. Keep the step density per
      // CSS pixel that the settings give at the Retina defaults (0.9 samples per CSS px, 0.5 / 0.25 reflection scale).
      const ssrIn = indoor > 0.5
      const ssrSamples = num(ctx, "post.renderScale") * autoScale * num(ctx, ssrIn ? "post.ssrScale" : "post.ssrScaleOutdoor")
      const ssrReference = 0.9 * (ssrIn ? 0.5 : 0.25)
      ssrNode.quality.value = Math.min(1, Math.max(0.02, (num(ctx, ssrIn ? "post.ssrQuality" : "post.ssrQualityOutdoor") * ssrReference) / ssrSamples))
      aoStrength.value = num(ctx, "post.aoStrength")
      aoNode.radius.value = num(ctx, "post.aoRadius")
      aoNode.samples.value = num(ctx, "post.aoSamples")
      // Indoors (inside the building shell) the eye is adapted to the tubes, not the fog: blend an EV offset.
      const inside = insideBuilding(camPos.value) ? 1 : 0
      const camJump = lastCamPos.distanceToSquared(camPos.value) > 1.5 * 1.5
      lastCamPos.copy(camPos.value)
      indoor += (inside - indoor) * (frame < 3 || camJump ? 1 : 0.03)
      // A cut restarts the temporal history (TAAU and reflections) instead of letting the old view bleed out slowly.
      if (taauRef.node) taauRef.node.reset.value = camJump ? 1 : 0
      if (camJump) ssrHistoryValid.value = 0
      exposure.value = 2 ** (num(ctx, "post.exposure") + indoor * num(ctx, "post.interiorExposure"))
      const bl = bloomNodeRef.node
      // The glow keeps its size and cost in CSS pixels whatever the output pixel ratio (half of a 1.25× canvas).
      const bloomScale = Math.min(0.5, 0.625 / Math.max(1, scaleState.dpr))
      if (bl.getResolutionScale() !== bloomScale) bl.setResolutionScale(bloomScale)
      bl.strength.value = num(ctx, "post.bloom")
      bl.radius.value = num(ctx, "post.bloomRadius")
      bl.threshold.value = num(ctx, "post.bloomThreshold")
      bloomCap.value = num(ctx, "post.bloomSurfaceCap")
      bloomHot.value = num(ctx, "post.bloomHot")
      grade.lift.value = num(ctx, "grade.lift")
      grade.warmth.value = num(ctx, "grade.warmth")
      grade.teal.value = num(ctx, "grade.teal")
      grade.contrast.value = num(ctx, "grade.contrast")
      grade.shoulder.value = num(ctx, "grade.shoulder")
      grade.saturation.value = num(ctx, "grade.saturation")
      grade.grain.value = num(ctx, "grade.grain")
      sharpness.value = num(ctx, "post.sharpness")
      const accumulate = flag(ctx, "post.ssrAccumulate")
      ssrResponse.value = accumulate ? 0.08 : 1
      ssrJitter.value = accumulate ? 0 : 1
      if (taauRef.node) taauRef.node.sharpness.value = num(ctx, "post.taaSharpness")
      grade.vignette.value = num(ctx, "grade.vignette")
      grade.aberration.value = num(ctx, "grade.aberration")
      dofFocus.value = num(ctx, "post.dofFocus")
      dofBokeh.value = num(ctx, "post.dofAperture")
      grade.halation.value = num(ctx, "grade.halation")
      grade.warmSaturation.value = num(ctx, "grade.warmSaturation")
      grade.distortion.value = num(ctx, "grade.distortion")
      grade.gamma.value = num(ctx, "grade.gamma")
      whiteBalance(num(ctx, "grade.temperature"), num(ctx, "grade.tint"), wb.value)
      whiteBalance(num(ctx, "grade.interiorTemperature"), num(ctx, "grade.interiorTint"), interiorTint.value)
      interiorTint.value.multiplyScalar(2 ** num(ctx, "grade.interiorExposure"))
      indoorU.value = indoor

      for (const f of renderState.beforeRender) f()
      pipeline.render()

      // Keep this frame's accumulated reflections as next frame's history. The history keeps the size the reflections
      // have at full auto-res scale and is resampled into (it's read by UV), so an auto-res step blends through
      // instead of resetting; only a settings or window change restarts it.
      const src = ssrAccum.renderTarget as THREE.RenderTarget | undefined
      if (flag(ctx, "post.ssr") && src && src.width > 1) {
        const full = Math.min(1, num(ctx, "post.renderScale") / scaleState.dpr) * scaleState.ssr
        const hw = Math.max(1, Math.floor(resolution.value.x * full))
        const hh = Math.max(1, Math.floor(resolution.value.y * full))
        if (ssrHistory.width !== hw || ssrHistory.height !== hh) {
          ssrHistory.setSize(hw, hh)
          ;(renderer as unknown as { initRenderTarget(t: THREE.RenderTarget): void }).initRenderTarget(ssrHistory)
          ssrHistoryValid.value = 0
        } else ssrHistoryValid.value = 1
        if (src.width === hw && src.height === hh) renderer.copyTextureToTexture(src.texture, ssrHistory.texture)
        else {
          if (blitSource.value !== src.texture) blitSource.value = src.texture
          renderer.setRenderTarget(ssrHistory)
          blitQuad.render(renderer)
          renderer.setRenderTarget(null)
        }
      } else ssrHistoryValid.value = 0
    },
  }
  // Automation hook for GPU-time breakdowns: scripts render frames back-to-back with settings toggled.
  if (ctx.params.has("perf")) (globalThis as { __afterhoursRender?: unknown }).__afterhoursRender = { renderer, scene, camera, settings: ctx.settings, render: api.render, state: renderState, scale: () => ({ autoScale, ...scaleState }), scattering: () => [...scattering].map((r) => r.lamp.position.join(",")).sort().join(" ") }
  return api
}
