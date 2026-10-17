import * as THREE from "three/webgpu"
import {
  Fn as TslFn,
  abs,
  atan,
  cameraPosition,
  exp,
  float,
  instancedDynamicBufferAttribute,
  length,
  max,
  mrt,
  normalWorld,
  positionWorld,
  reference,
  uniform,
  texture,
  normalize,
  smoothstep,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl"
import { ConeClusteredLighting } from "./clustered"
import { initMirrors } from "./mirrors"
import type { Lamp, WorldContext } from "../world/context"
import type { Player } from "../player"
import { fogSigma, opticalDepth } from "./atmosphere"
import type { LightMask } from "./clustered"
import { inside, lampZone, storeyAt, storeySlab, type LampZone } from "./volumes"
import { addControls, flag, num, renderState, type LampRuntime } from "./shared"

// The light rig. Every registered lamp becomes an unshadowed clustered point light (Forward+, culled per cluster); a
// small pool of shadowed spot lights is handed to the nearest important `shadow: true` fixtures and cross-faded as the
// player moves, with shadow maps rendered only on hand-over (the world is static). Flicker, the warning blink and the
// flashlight live here; emitter glows are one instanced additive sprite batch, depth-tested so walls hide them.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any
const Fn = TslFn as N

const MAX_POOL = 6
/** Emitter glow instances (buffers are allocated once at this size so late lamps never reallocate them). */
const GLOW_CAPACITY = 1024
/** Within this distance of the building shell, lamps on both sides of its walls stay on (doors, windows). */
const OUTSIDE_INTERIOR_RANGE = 35
/** Exterior lamps kept on while the camera is indoors (lit through windows and doors). */
const INSIDE_EXTERIOR_RANGE = 30
/** A shadow slot's holder keeps it until a candidate scores this much higher (no slot thrashing). */
const SHADOW_HYSTERESIS = 1.6
const FADE_S = 0.35

/** Per-lamp flicker state machine. */
type Flicker = {
  seed: number
  state: "on" | "stutter" | "dark" | "starter" | "ignite" | "sag" | "off" | "restrike"
  until: number
  toggle: number
  on: boolean
  level: number
  /** Restrike colour: 0 = cold (pinkish, dim), 1 = fully warmed sodium. */
  warm: number
  blinks: number
}

type Rig = LampRuntime & {
  color: THREE.Color
  zone: LampZone
  /** Light-shading mask for the clustered shader (interior lamps only light interior surfaces of their storey). */
  mask: LightMask
  /** Smoothed culling weight (fades lights in and out instead of popping) and its target. */
  vis: number
  want: boolean
  /** Smoothed glow visibility (zone + walls between camera and emitter). */
  glowVis: number
  glowSeen: boolean
  scale: number
  lastPos: [number, number, number]
  point: THREE.PointLight
  shadowWeight: number
  flicker: Flicker
  lastIntensity: number
  animated: boolean
  glow: number
}

function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}
const random = rng(0x9e3779b9)

/**
 * Lamp colour as rendered. Low/high-pressure sodium is a narrow orange spectrum; builders give an RGB that reads
 * slightly yellow, so the rig deepens it towards the concept's orange (a render decision, kept in one place).
 */
function lampColor(l: Lamp, shift: number, out: THREE.Color) {
  out.setRGB(l.color[0], l.color[1], l.color[2])
  if (l.kind === "sodium") out.multiply(_tint.setRGB(1, 1 - 0.3 * shift, 1 - 0.55 * shift))
  return out
}
/** Cold sodium (restrike) burns dim pinkish-red before it warms to orange. */
function coldSodium(out: THREE.Color, warm: number) {
  if (warm >= 1) return out
  const k = 1 - warm
  return out.multiply(_tint.setRGB(1, 1 - 0.55 * k, 1 - 0.1 * k))
}
const _tint = new THREE.Color()

/** Smooth 1D value noise in [-1, 1]. */
function noise1(t: number, seed: number) {
  const i = Math.floor(t)
  const f = t - i
  const h = (n: number) => {
    const x = Math.sin((n + seed * 157.31) * 12.9898) * 43758.5453
    return (x - Math.floor(x)) * 2 - 1
  }
  const u = f * f * (3 - 2 * f)
  return h(i) * (1 - u) + h(i + 1) * u
}

/**
 * Lamp output multiplier at `time`. Fluorescent: a faint ballast hum (1–2 % wander), long steady stretches, then
 * either a short stutter burst or a full drop-out with the starter's blink-blink-ignite. Dying high-pressure
 * sodium: burns for a while, sags and goes out, sits dark, then restrikes dim and pinkish and warms back to orange
 * over several seconds (the classic cycling lamp). Warning beacons pulse like a filament. Incandescent with
 * `flicker` browns out gently. Deterministic per lamp and frame-rate independent.
 */
function flickerLevel(r: Rig, time: number, scale: number) {
  const lamp = r.lamp
  const f = r.flicker
  const amt = Math.min(1, (lamp.flicker ?? 0) * scale)
  if (lamp.kind === "warning") {
    if (r.animated) return 1
    const ph = (time * 0.9 + f.seed) % 1
    return ph < 0.5 ? 1 - Math.exp(-ph * 30) : Math.exp(-(ph - 0.5) * 14)
  }
  f.warm = 1
  if (amt <= 0) return 1
  if (lamp.kind === "incandescent" || lamp.kind === "window") {
    return 1 - amt * 0.12 * Math.max(0, noise1(time * 1.3, f.seed) * 0.6 + noise1(time * 7, f.seed + 3) * 0.4)
  }
  if (lamp.kind === "sodium") {
    if (f.until === 0) {
      f.state = "on"
      f.until = time + (4 + f.seed * 30) / amt
    }
    while (time >= f.until) {
      if (f.state === "on") {
        f.state = "sag"
        f.until += 2.5 + f.seed * 2
      } else if (f.state === "sag") {
        f.state = "off"
        f.until += 5 + ((f.seed * 7.3) % 1) * 9
      } else if (f.state === "off") {
        f.state = "restrike"
        f.until += 7 + ((f.seed * 3.1) % 1) * 5
      } else {
        f.state = "on"
        f.until += (12 + ((f.seed * 13.7 + f.until) % 1) * 40) / amt
      }
    }
    const left = f.until - time
    if (f.state === "sag") {
      const k = 1 - left / (2.5 + f.seed * 2)
      f.warm = 1 - 0.25 * k
      return Math.max(0.02, 1 - k * k * 0.98) * (1 + 0.04 * noise1(time * 9, f.seed))
    }
    if (f.state === "off") {
      f.warm = 0
      return 0.012
    }
    if (f.state === "restrike") {
      const dur = 7 + ((f.seed * 3.1) % 1) * 5
      const k = 1 - left / dur
      f.warm = k
      // Arc strikes with a blink, then a slow climb.
      const strike = k < 0.03 ? (Math.floor(time * 20) % 2 ? 0.25 : 0.05) : 0.08 + 0.92 * k * k * (3 - 2 * k)
      return strike
    }
    return 1 + 0.015 * noise1(time * 0.7, f.seed)
  }
  // Fluorescent (and exit signs on the same ballast).
  const hum = 1 - amt * (0.012 + 0.012 * noise1(time * 6, f.seed))
  if (f.until === 0) {
    f.state = "on"
    f.until = time + 1 + f.seed * 6
  }
  if (time >= f.until) {
    const pick = (f.seed * 97.13 + f.until * 0.731) % 1
    if (f.state === "on") {
      if (pick < 0.35 * amt + 0.1) {
        f.state = "dark"
        f.until = time + 0.3 + pick * 1.4
      } else {
        f.state = "stutter"
        f.until = time + 0.15 + pick * 0.9 * amt
        f.toggle = time
      }
    } else if (f.state === "dark") {
      f.state = "starter"
      f.blinks = 2 + Math.floor(pick * 3)
      f.until = time + f.blinks * 0.32
      f.toggle = time
    } else if (f.state === "starter") {
      f.state = "ignite"
      f.until = time + 0.12
    } else {
      f.state = "on"
      f.until = time + (2 + pick * 9) / Math.max(amt, 0.05)
    }
  }
  switch (f.state) {
    case "stutter":
      if (time >= f.toggle) {
        f.on = !f.on
        f.toggle = time + 0.03 + (((f.seed * 31.7 + time * 3.3) % 1) * 0.09)
        f.level = f.on ? 0.65 + 0.35 * ((time * 7.7 + f.seed) % 1) : 0.02 + 0.08 * (1 - amt)
      }
      return f.level * hum
    case "dark":
      return 0.01
    case "starter": {
      // Starter glow: the tube ends warm and the arc catches briefly a few times before it holds.
      const ph = ((time - (f.until - f.blinks * 0.32)) % 0.32) / 0.32
      return ph < 0.18 ? 0.45 : 0.015
    }
    case "ignite": {
      const k = 1 - (f.until - time) / 0.12
      return (0.5 + 0.5 * Math.min(1, k)) * hum
    }
    default:
      return hum
  }
}

/**
 * Shaped flashlight beam: a hot centre, a faint soft reflector ring and a wide dim spill (an incandescent torch with
 * a stippled reflector: the ring is a few percent, not a hard caustic halo).
 */
const flashCookie = Fn(([coord]: [N]) => {
  const r = length(coord.xy.sub(0.5)).mul(2)
  const hot = exp(r.mul(r).mul(-12)).mul(1.1)
  const ring = exp(r.sub(0.4).div(0.09).pow(2).negate()).mul(0.07)
  const dip = float(0)
  const spill = smoothstep(1, 0.3, r).mul(0.3)
  // Slight lens/reflector imperfection so the spot isn't perfectly round.
  const ang = atan(coord.y.sub(0.5), coord.x.sub(0.5))
  const wobble = ang.mul(5).sin().mul(0.04).add(ang.mul(3).add(1.3).sin().mul(0.03)).add(1)
  return vec3(1, 0.97, 0.9).mul(max(hot.add(ring).add(dip).add(spill), 0).mul(wobble))
})

/**
 * Slope-scaled, distance-aware depth bias for a spot light's perspective shadow map, evaluated per receiving
 * fragment. The world-space slack needed to avoid acne is about one shadow texel (which grows linearly with distance
 * from the light) times tan(angle between the surface normal and the light), so floors at grazing angles get much
 * more than surfaces facing the light. Converted to the map's [0, 1] perspective depth: dz = Δd·n·f / ((f − n)·d²).
 * The light's own `bias`/`normalBias` stay as small constant floors.
 */
function spotBias(light: THREE.SpotLight, lightPos: N, scale: N) {
  const cam = light.shadow.camera
  const near = reference("near", "float", cam)
  const far = reference("far", "float", cam)
  const size = reference("mapSize", "vec2", light.shadow) as N
  const halfAngle = reference("angle", "float", light)
  return Fn(() => {
    const toL = (lightPos as N).sub(positionWorld)
    const d = length(toL).max(0.05)
    const c = (normalWorld as N).dot(toL.div(d)).abs().max(0.08)
    const tanT = c.mul(c).oneMinus().max(0).sqrt().div(c).min(10)
    const texel = d.mul(halfAngle.tan().mul(2)).div(size.x)
    const slack = texel.mul(tanT.mul(1.2).add(0.6)).mul(scale)
    return slack.mul(near).mul(far).div(far.sub(near).mul(d).mul(d)).negate()
  })()
}

/**
 * Stable PCF for spot shadows: a fixed 3×3 grid of comparison taps (no per-pixel noise rotation, which shimmered
 * under the temporal AA's sub-pixel jitter) on a linearly filtered comparison sampler (see `smoothShadowMap`), so
 * each tap is itself a bilinear 2×2 PCF: 36 effective taps, soft edges with no texel stair-steps.
 */
const stablePCF = Fn(({ depthTexture, shadowCoord, shadow }: N) => {
  const size = reference("mapSize", "vec2", shadow) as N
  const radius = reference("radius", "float", shadow) as N
  const step = vec2(1).div(size).mul(radius.mul(0.5).max(0.5))
  let sum: N = null
  for (const oy of [-1, 0, 1]) {
    for (const ox of [-1, 0, 1]) {
      const v = (texture as N)(depthTexture, shadowCoord.xy.add(step.mul(vec2(ox, oy)))).compare(shadowCoord.z)
      sum = sum === null ? v : sum.add(v)
    }
  }
  return sum.mul(1 / 9)
})

/** Comparison sampling with linear filtering (hardware 2×2 PCF) once three has created the light's shadow map. */
function smoothShadowMap(light: THREE.SpotLight) {
  const depth = (light.shadow.map as unknown as { depthTexture?: THREE.Texture } | null)?.depthTexture
  if (depth && depth.minFilter !== THREE.LinearFilter) {
    depth.minFilter = THREE.LinearFilter
    depth.magFilter = THREE.LinearFilter
    depth.needsUpdate = true
  }
}

export function createLighting(ctx: WorldContext, player: Player) {
  addControls(ctx, [
    { key: "light.lampsExterior", label: "Exterior lamp intensity", group: "Lighting", unit: "×", min: 0, max: 4, step: 0.05, value: 0.3 },
    { key: "light.lampsInterior", label: "Interior lamp intensity", group: "Lighting", unit: "×", min: 0, max: 4, step: 0.05, value: 0.8 },
    { key: "light.ambient", label: "Extra fill (hemisphere)", group: "Lighting", min: 0, max: 1, step: 0.005, value: 0.02 },
    { key: "light.shadows", label: "Shadowed lamps", group: "Lighting", min: 0, max: MAX_POOL, step: 1, value: 2 },
    {
      key: "light.shadowSize",
      label: "Lamp shadow map",
      group: "Lighting",
      type: "select",
      options: [
        { value: 512, label: "512" },
        { value: 1024, label: "1024" },
        { value: 2048, label: "2048" },
      ],
      value: 512,
    },
    { key: "light.spillInterior", label: "Spot spill/bounce indoors", group: "Lighting", min: 0, max: 0.6, step: 0.01, value: 0.22 },
    { key: "light.spillExterior", label: "Spot spill outdoors", group: "Lighting", min: 0, max: 0.3, step: 0.005, value: 0.02 },
    { key: "light.sodiumShift", label: "Sodium deepening (towards orange)", group: "Lighting", min: 0, max: 1, step: 0.01, value: 0.6 },
    { key: "light.flicker", label: "Flicker", group: "Lighting", unit: "×", min: 0, max: 2, step: 0.05, value: 1 },
    { key: "glow.strength", label: "Emitter glow", group: "Lighting", unit: "×", min: 0, max: 4, step: 0.05, value: 1 },
    { key: "glow.size", label: "Glow size", group: "Lighting", unit: "×", min: 0.2, max: 4, step: 0.05, value: 1 },
    { key: "flash.intensity", label: "Intensity", group: "Flashlight", unit: "cd", min: 0, max: 4000, step: 10, value: 1000 },
    { key: "flash.angle", label: "Beam half-angle", group: "Flashlight", unit: "°", min: 8, max: 45, step: 1, value: 24 },
    { key: "flash.range", label: "Range", group: "Flashlight", unit: "m", min: 5, max: 80, step: 1, value: 40 },
    { key: "flash.lag", label: "Sway lag", group: "Flashlight", unit: "s", min: 0, max: 0.4, step: 0.01, value: 0.09 },
    { key: "flash.scatter", label: "Beam in fog", group: "Flashlight", unit: "×", min: 0, max: 2, step: 0.01, value: 0.15 },
    { key: "flash.near", label: "Beam fade-in distance", group: "Flashlight", unit: "m", min: 0, max: 8, step: 0.1, value: 3 },
    { key: "light.shadowBias", label: "Shadow bias (slope-scaled)", group: "Lighting", unit: "texels", min: 0, max: 4, step: 0.05, value: 1 },
    { key: "flash.shadows", label: "Casts shadows", group: "Flashlight", type: "toggle", value: true },
    {
      key: "flash.shadowSize",
      label: "Shadow map",
      group: "Flashlight",
      type: "select",
      options: [
        { value: 256, label: "256" },
        { value: 512, label: "512" },
        { value: 1024, label: "1024" },
      ],
      value: 512,
    },
    { key: "light.cull", label: "Cull lamps by view and zone", group: "Lighting", type: "toggle", value: true },
  ])

  const { renderer, scene, camera } = ctx
  ;(renderer as unknown as { lighting: unknown }).lighting = new ConeClusteredLighting(512, 32, 24, 48)

  const hemi = new THREE.HemisphereLight(0x2c5450, 0x0b0f0d, 0.1)
  scene.add(hemi)

  // ---------------------------------------------------------------- lamps → clustered point lights
  // Lamps may be registered after the rig exists (modules stream in after the first frame), so they are adopted in
  // update() too; `lamp.position` is re-read every frame (the loader parks a module's lamps until it is shown).
  const rigs: Rig[] = []
  const glowRigs: Rig[] = []
  const addRig = (lamp: Lamp) => {
    const point = new THREE.PointLight(new THREE.Color(...lamp.color), 0, lamp.range, 2)
    point.castShadow = false
    const angle = lamp.angle ?? 0.9
    const pen = lamp.penumbra ?? 0.5
    if (lamp.direction) {
      const d = new THREE.Vector3(...lamp.direction).normalize()
      point.userData.cone = { dir: [d.x, d.y, d.z], cosOuter: Math.cos(angle), cosInner: Math.cos(angle * (1 - pen)) }
    }
    const mask: LightMask = { mode: 0, y0: -1e5, y1: 1e5 }
    point.userData.mask = mask
    point.visible = false
    scene.add(point)
    const rig: Rig = {
      lamp,
      pos: new THREE.Vector3(),
      dir: lamp.direction ? new THREE.Vector3(...lamp.direction).normalize() : null,
      radiance: new THREE.Color(),
      level: 1,
      sigma: 0,
      transmittance: 1,
      distance: 0,
      cosOuter: lamp.direction ? Math.cos(angle) : -2,
      cosInner: lamp.direction ? Math.cos(angle * (1 - pen)) : -1,
      point,
      color: new THREE.Color(),
      shadowWeight: 0,
      flicker: { seed: random(), state: "on", until: 0, toggle: 0, on: true, level: 1, warm: 1, blinks: 0 },
      zone: { interior: false, storey: -1 },
      mask,
      vis: 0,
      want: false,
      glowVis: 0,
      glowSeen: true,
      scale: 1,
      lastPos: [NaN, NaN, NaN],
      lastIntensity: lamp.intensity,
      animated: false,
      // Panels and tubes are already large emissive meshes: their sprite only adds a little glare.
      glow: lamp.kind === "window" ? 0 : lamp.kind === "fluorescent" ? 0.3 : 1,
    }
    rigs.push(rig)
    if (rig.glow > 0 && glowRigs.length < GLOW_CAPACITY) glowRigs.push(rig)
  }
  let adopted = 0
  const adoptLamps = () => {
    while (adopted < ctx.lamps.length) addRig(ctx.lamps[adopted++]!)
  }
  adoptLamps()
  renderState.lamps = rigs

  const shadowBiasScale = uniform(1)
  // ---------------------------------------------------------------- shadow pool
  type Slot = { light: THREE.SpotLight; rig: Rig | null }
  const slots: Slot[] = []
  const makeSlots = () => {
    const n = Math.round(num(ctx, "light.shadows"))
    const size = Number(ctx.settings["light.shadowSize"])
    while (slots.length > n) {
      const s = slots.pop()!
      if (s.rig) s.rig.shadowWeight = 0
      scene.remove(s.light, s.light.target)
      s.light.dispose()
    }
    for (const s of slots) {
      if (s.light.shadow.mapSize.x !== size) {
        s.light.shadow.mapSize.set(size, size)
        s.light.shadow.needsUpdate = true
      }
    }
    while (slots.length < n) {
      const light = new THREE.SpotLight(0xffffff, 0, 30, 1, 0.5, 2)
      light.castShadow = true
      light.shadow.mapSize.set(size, size)
      light.shadow.bias = 0
      light.shadow.normalBias = 0.01
      light.shadow.radius = 2
      light.shadow.camera.near = 0.25
      const lp = uniform(new THREE.Vector3())
      light.userData.biasPos = lp
      ;(light.shadow as unknown as { biasNode: unknown }).biasNode = spotBias(light, lp, shadowBiasScale)
      ;(light.shadow as unknown as { filterNode: unknown }).filterNode = stablePCF
      light.shadow.autoUpdate = false
      scene.add(light, light.target)
      slots.push({ light, rig: null })
    }
  }
  makeSlots()
  let poolKey = `${ctx.settings["light.shadows"]}/${ctx.settings["light.shadowSize"]}`

  // ---------------------------------------------------------------- flashlight
  const flash = new THREE.SpotLight(0xfff0dc, 0, 40, 0.42, 0.35, 2)
  // castShadow stays on for good: toggling it at runtime recompiles every material and crashes r186's ShadowNode.
  // "Casts shadows" off is zero shadow intensity with the map frozen instead.
  flash.castShadow = true
  flash.shadow.mapSize.setScalar(Number(ctx.settings["flash.shadowSize"]))
  flash.shadow.bias = 0
  flash.shadow.normalBias = 0.01
  flash.shadow.radius = 2
  flash.shadow.camera.near = 0.3
  const flashBiasPos = uniform(new THREE.Vector3())
  ;(flash.shadow as unknown as { biasNode: unknown }).biasNode = spotBias(flash, flashBiasPos, shadowBiasScale)
  ;(flash.shadow as unknown as { filterNode: unknown }).filterNode = stablePCF
  // Shadow-map stability: the light only moves when the hand has moved more than a hair, so a still player gets a
  // still shadow map (no sub-texel re-quantisation shimmer from the sway filter's endless tiny convergence).
  const appliedDir = new THREE.Vector3(0, 0, -1)
  const appliedPos = new THREE.Vector3()
  ;(flash as unknown as { colorNode: unknown }).colorNode = flashCookie
  scene.add(flash, flash.target)
  const flashDir = new THREE.Vector3(0, 0, -1)
  const flashColor = new THREE.Color(1, 0.93, 0.82)
  let flashLevel = 0

  // ---------------------------------------------------------------- emitter glows
  const n = GLOW_CAPACITY
  const centerAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)
  const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)
  const dirAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)
  for (const a of [centerAttr, colorAttr, dirAttr]) a.setUsage(THREE.DynamicDrawUsage)
  const center = instancedDynamicBufferAttribute(centerAttr as never) as N
  const gcol = instancedDynamicBufferAttribute(colorAttr as never) as N
  const gdir = instancedDynamicBufferAttribute(dirAttr as never) as N

  const glowMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  glowMat.fog = false
  const toCam = normalize((cameraPosition as N).sub(center.xyz))
  // Pull the quad towards the camera so the fixture housing doesn't clip the core.
  glowMat.positionNode = center.xyz.add(toCam.mul(center.w.mul(0.35)))
  glowMat.scaleNode = vec2(center.w.mul(4))
  const facing = gdir.w.greaterThan(0.5).select(smoothstep(-0.25, 0.45, toCam.dot(gdir.xyz)), float(1))
  const r = length(uv().sub(0.5)).mul(2)
  // Hot core (the lamp's visible envelope) plus a short glare skirt; the wide halo is the fog in-scatter in post.
  const core = exp(r.mul(r).mul(-360)).mul(facing)
  const glare = exp(r.mul(r).mul(-40)).mul(0.12).mul(facing.mul(0.6).add(0.4))
  const skirt = exp(r.mul(-9)).mul(0.04).mul(facing.mul(0.75).add(0.25))
  const edge = smoothstep(1, 0.8, r)
  glowMat.colorNode = vec4(gcol.rgb.mul(core.add(glare).add(skirt)).mul(edge), 1)
  glowMat.opacityNode = float(1)
  // Additive over the colour target only: leave the G-buffer attachments (normals, roughness, velocity) untouched.
  // Additive zero over the G-buffer attachments (post.ts gives them material blending) leaves them untouched.
  glowMat.mrtNode = mrt({ normal: vec4(0), metalrough: vec4(0), velocity: vec4(0) })
  const glows = new THREE.Sprite(glowMat)
  ;(glows as unknown as { count: number }).count = glowRigs.length
  glows.frustumCulled = false
  glows.renderOrder = 10
  glows.visible = glowRigs.length > 0
  scene.add(glows)
  initMirrors(ctx, () => [glows])

  // Culling. Clustered lights cost per pixel for every light whose sphere reaches the pixel's cluster, and their data
  // is re-sorted and re-uploaded each frame, so lamps that can't reach anything on screen are dropped: switched off,
  // parked by the streaming loader, outside the view frustum, or in another zone (indoors on storey N: only that
  // storey's lamps, the neighbouring storey's near the camera, and exterior lamps close enough to come in through the
  // windows; outdoors: only interior lamps near enough to be seen through windows and doors). Lamps fade in and out
  // over FADE_S instead of popping.
  const frustum = new THREE.Frustum()
  const projView = new THREE.Matrix4()
  const sphere = new THREE.Sphere()
  let camInside = false
  let camStorey = -1
  const zoneOk = (r: Rig) => {
    if (r.lamp.intensity <= 0 || r.pos.y < -500) return false
    if (camInside) {
      if (r.zone.interior) return r.zone.storey === camStorey || (Math.abs(r.zone.storey - camStorey) === 1 && r.distance < 10)
      return r.distance < INSIDE_EXTERIOR_RANGE + r.lamp.range * 0.5
    }
    if (r.zone.interior) return r.distance < OUTSIDE_INTERIOR_RANGE
    return true
  }
  const lampNeeded = (r: Rig) => {
    if (r.level <= 0.003 || !zoneOk(r)) return false
    sphere.set(r.pos, r.lamp.range)
    // A live mirror sees behind the player: keep lamps lighting what it reflects.
    return frustum.intersectsSphere(sphere) || (renderState.mirrorFrustum?.intersectsSphere(sphere) ?? false)
  }

  // Glow occlusion: emitters hidden by walls must not shine through them. Sprites are depth-tested, but a halo quad is
  // several times the emitter's size and pokes out around walls and floors, so each glow is also faded by a CPU
  // segment test (camera → emitter) against the world's collision boxes, a few lamps per frame, through a coarse
  // grid that is rebuilt whenever modules stream in more boxes.
  const CELL = 6
  let gridCount = -1
  const grid = new Map<number, number[]>()
  const key = (cx: number, cz: number) => cx * 73856093 + cz * 19349663
  const buildGrid = () => {
    grid.clear()
    const boxes = ctx.colliders
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!
      // Skip thin posts and props: only walls, slabs and big solids occlude.
      const sx = b.max[0] - b.min[0]
      const sy = b.max[1] - b.min[1]
      const sz = b.max[2] - b.min[2]
      if (Math.max(sx, sz) < 1.2 || sy < 0.05) continue
      for (let cx = Math.floor(b.min[0] / CELL); cx <= Math.floor(b.max[0] / CELL); cx++) {
        for (let cz = Math.floor(b.min[2] / CELL); cz <= Math.floor(b.max[2] / CELL); cz++) {
          const k = key(cx, cz)
          let list = grid.get(k)
          if (!list) grid.set(k, (list = []))
          list.push(i)
        }
      }
    }
    gridCount = boxes.length
  }
  const stamp = new Uint32Array(1 << 16)
  let stampId = 0
  const segmentBlocked = (a: THREE.Vector3, b: THREE.Vector3) => {
    if (gridCount !== ctx.colliders.length) buildGrid()
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dz = b.z - a.z
    const len = Math.hypot(dx, dz)
    const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)))
    stampId = (stampId + 1) >>> 0 || 1
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const cx = Math.floor((a.x + dx * t) / CELL)
      const cz = Math.floor((a.z + dz * t) / CELL)
      const list = grid.get(key(cx, cz))
      if (!list) continue
      for (const i of list) {
        if (stamp[i & 0xffff] === stampId) continue
        stamp[i & 0xffff] = stampId
        const box = ctx.colliders[i]!
        // Slab test on the segment, shrunk a little at the emitter end so a lamp's own housing doesn't hide it.
        let t0 = 0
        let t1 = 0.97
        const o = [a.x, a.y, a.z]
        const d = [dx, dy, dz]
        let hit = true
        for (let k = 0; k < 3; k++) {
          const dk = d[k]!
          if (Math.abs(dk) < 1e-9) {
            if (o[k]! < box.min[k]! || o[k]! > box.max[k]!) {
              hit = false
              break
            }
            continue
          }
          let ta = (box.min[k]! - o[k]!) / dk
          let tb = (box.max[k]! - o[k]!) / dk
          if (ta > tb) [ta, tb] = [tb, ta]
          t0 = Math.max(t0, ta)
          t1 = Math.min(t1, tb)
          if (t0 > t1) {
            hit = false
            break
          }
        }
        if (hit) return true
      }
    }
    return false
  }
  let occCursor = 0
  const OCC_PER_FRAME = 24
  const occPoint = new THREE.Vector3()

  const tmpCam = new THREE.Vector3()
  let lastSpill = [NaN, NaN]
  const fwd = new THREE.Vector3()
  const order: Rig[] = []
  let frame = 0
  let wasStreaming = false
  let shadowColliders = -1
  const doorAmounts: number[] = []

  const rig = {
    update(dt: number, time: number) {
      frame++
      adoptLamps()
      ;(glows as unknown as { count: number }).count = glowRigs.length
      glows.visible = glowRigs.length > 0
      camera.updateMatrixWorld()
      tmpCam.setFromMatrixPosition(camera.matrixWorld)
      const extScale = num(ctx, "light.lampsExterior")
      const spillIn = num(ctx, "light.spillInterior")
      const spillOut = num(ctx, "light.spillExterior")
      if (spillIn !== lastSpill[0] || spillOut !== lastSpill[1]) {
        lastSpill = [spillIn, spillOut]
        for (const r of rigs) r.lastPos[0] = NaN
      }
      const intScale = num(ctx, "light.lampsInterior")
      const flickerScale = num(ctx, "light.flicker")
      const sodiumShift = num(ctx, "light.sodiumShift")
      hemi.intensity = num(ctx, "light.ambient")
      const cull = flag(ctx, "light.cull")
      projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      frustum.setFromProjectionMatrix(projView)
      camInside = inside(tmpCam)
      camStorey = camInside ? storeyAt(tmpCam.y) : -1
      const fade = frame < 3 ? 1 : dt / FADE_S

      // Lamps: live position/intensity (builders may animate them), flicker, fog terms.
      for (const r of rigs) {
        const l = r.lamp
        if (l.intensity !== r.lastIntensity) {
          r.animated = true
          r.lastIntensity = l.intensity
        }
        const lp = r.lastPos
        const moved = lp[0] !== l.position[0] || lp[1] !== l.position[1] || lp[2] !== l.position[2]
        if (moved) {
          lp[0] = l.position[0]
          lp[1] = l.position[1]
          lp[2] = l.position[2]
        }
        r.pos.set(l.position[0], l.position[1], l.position[2])
        if (r.dir) r.pos.addScaledVector(r.dir, 0.12)
        if (moved) {
          // Zone and shading mask follow the lamp (the loader parks lamps until their module is shown).
          r.zone = lampZone(l)
          // Building lamps light only the inside of the building, street and lot lamps only the outside; the guard
          // booth's lamp lights both (its glass spills onto the road, as in the concept).
          r.mask.mode = r.zone.interior || inside(r.pos) ? 1 : inside(r.pos, true) ? 0 : 2
          // Spots in rooms and semi-open spaces (bays, booth, doorways) light the space around their pool by bounce;
          // street and yard heads stay tight so the night between them stays black.
          r.point.userData.spill = r.dir ? (r.mask.mode === 2 ? spillOut : spillIn) : 0
          if (r.zone.interior) [r.mask.y0, r.mask.y1] = storeySlab(r.zone.storey)
          else [r.mask.y0, r.mask.y1] = [-1e5, 1e5]
        }
        r.level = flickerLevel(r, time, flickerScale)
        lampColor(l, sodiumShift, r.color)
        if (l.kind === "sodium") coldSodium(r.color, r.flicker.warm)
        // The booth lamp (mode 0) lights a room and the forecourt: halfway between the interior and street scales.
        const lampScale = r.zone.interior || r.mask.mode === 1 ? intScale : r.mask.mode === 0 ? (intScale + extScale) / 2 : extScale
        r.scale = lampScale
        r.radiance.copy(r.color).multiplyScalar(l.intensity * lampScale)
        r.distance = r.pos.distanceTo(tmpCam)
        r.sigma = fogSigma(r.pos)
        r.transmittance = Math.exp(-opticalDepth(tmpCam, r.pos))
        r.point.position.copy(r.pos)
        r.point.color.copy(r.color)
        r.point.distance = l.range
        r.want = !cull || lampNeeded(r)
        r.vis = r.want ? Math.min(1, r.vis + fade) : Math.max(0, r.vis - fade)
        r.point.intensity = l.intensity * lampScale * r.level * (1 - r.shadowWeight) * r.vis
        r.point.visible = r.vis > 0.001 && r.point.intensity > 1e-4
        const glowTarget = (!cull || zoneOk(r)) && r.glowSeen ? 1 : 0
        r.glowVis += (glowTarget - r.glowVis) * Math.min(1, frame < 3 ? 1 : dt / 0.15)
      }

      // Glow occlusion, a slice of lamps per frame.
      for (let k = 0; k < Math.min(OCC_PER_FRAME, glowRigs.length); k++) {
        const r = glowRigs[occCursor++ % glowRigs.length]!
        if (r.distance > 150 || r.pos.y < -500) continue
        occPoint.copy(r.pos)
        if (r.dir) occPoint.addScaledVector(r.dir, 0.15)
        r.glowSeen = !segmentBlocked(tmpCam, occPoint)
      }

      // Shadow pool: pick the most important shadow-casting fixtures near the camera.
      const key = `${ctx.settings["light.shadows"]}/${ctx.settings["light.shadowSize"]}`
      if (key !== poolKey) {
        poolKey = key
        makeSlots()
      }
      order.length = 0
      for (const r of rigs) {
        if (!r.lamp.shadow || !r.dir || !r.want || r.pos.y < -500 || r.distance > r.lamp.range + 15) continue
        order.push(r)
      }
      // Priority from the lamp's nominal output (not its flicker, which would reshuffle slots every frame) and
      // distance, with a bonus for holding a slot already so near-ties don't swap back and forth.
      const held = new Set<Rig>()
      for (const s of slots) if (s.rig && s.rig.shadowWeight > 0) held.add(s.rig)
      const score = (r: Rig) =>
        ((r.lamp.intensity / Math.max(r.distance - r.lamp.range * 0.3, 1) ** 2) * (held.has(r) ? SHADOW_HYSTERESIS : 1)) || 0
      order.sort((a, b) => score(b) - score(a) || a.point.id - b.point.id)
      const wanted = order.slice(0, slots.length)
      const step = dt / FADE_S
      for (const s of slots) {
        const keep = s.rig && wanted.includes(s.rig)
        if (s.rig && !keep) {
          s.rig.shadowWeight = Math.max(0, s.rig.shadowWeight - step)
          if (s.rig.shadowWeight === 0) s.rig = null
        } else if (s.rig) {
          s.rig.shadowWeight = Math.min(1, s.rig.shadowWeight + (frame < 4 ? 1 : step))
        }
      }
      for (const w of wanted) {
        if (slots.some((s) => s.rig === w)) continue
        const free = slots.find((s) => !s.rig)
        if (!free) break
        free.rig = w
        w.shadowWeight = frame < 4 ? 1 : 0
        const l = free.light
        l.position.copy(w.pos)
        l.target.position.copy(w.pos).add(w.dir!)
        l.angle = Math.min(Math.acos(Math.max(-1, w.cosOuter)), 1.4)
        l.penumbra = w.lamp.penumbra ?? 0.5
        l.distance = w.lamp.range
        l.shadow.camera.far = w.lamp.range
        l.shadow.needsUpdate = true
      }
      const streamingNow = renderState.streaming
      let worldChanged = (wasStreaming && !streamingNow) || ctx.colliders.length !== shadowColliders
      wasStreaming = streamingNow
      shadowColliders = ctx.colliders.length
      const doors = ctx.doors.all()
      for (let i = 0; i < doors.length; i++) {
        const a = doors[i]!.amount
        if (a !== doorAmounts[i]) worldChanged = true
        doorAmounts[i] = a
      }
      doorAmounts.length = doors.length
      for (const s of slots) {
        const w = s.rig
        if (!w) {
          s.light.intensity = 0
          continue
        }
        // A lamp can move after hand-over (the loader un-parks streamed modules; the dish beacon turns).
        if (!s.light.position.equals(w.pos)) {
          s.light.position.copy(w.pos)
          s.light.target.position.copy(w.pos).add(w.dir!)
          s.light.shadow.needsUpdate = true
        }
        ;(s.light.userData.biasPos as { value: THREE.Vector3 }).value.copy(s.light.position)
        s.light.color.copy(w.color)
        s.light.intensity = w.lamp.intensity * w.scale * w.level * w.shadowWeight * w.vis
        // Pooled maps are re-rendered only when the world changed: while modules stream in (one map now and then),
        // when colliders arrive or a door swings. A periodic refresh of a finished world re-caught the swaying pines
        // at a new phase each time, so their shadows jumped every ~0.75 s with the camera standing still.
        if (worldChanged || (streamingNow && frame % 45 === slots.indexOf(s) * 7) || frame < 6) s.light.shadow.needsUpdate = true
      }

      // Flashlight: hand-held, lagging slightly behind the view.
      shadowBiasScale.value = num(ctx, "light.shadowBias")
      smoothShadowMap(flash)
      for (const s of slots) smoothShadowMap(s.light)
      const on = player.flashlight
      flashLevel += ((on ? 1 : 0) - flashLevel) * Math.min(1, dt * 30)
      const forward = fwd.set(0, -0.04, -1).applyQuaternion(camera.quaternion).normalize()
      const lag = num(ctx, "flash.lag")
      const k = lag > 0 ? 1 - Math.exp(-dt / lag) : 1
      flashDir.lerp(forward, frame < 3 ? 1 : k).normalize()
      const handPos = fwd.set(0.22, -0.28, -0.1).applyQuaternion(camera.quaternion).add(tmpCam)
      if (frame < 3 || appliedDir.angleTo(flashDir) > 4e-4 || appliedPos.distanceToSquared(handPos) > 1e-6) {
        appliedDir.copy(flashDir)
        appliedPos.copy(handPos)
      }
      flash.position.copy(appliedPos)
      flash.target.position.copy(appliedPos).addScaledVector(appliedDir, 10)
      flashBiasPos.value.copy(appliedPos)
      const angle = (num(ctx, "flash.angle") * Math.PI) / 180
      flash.angle = angle
      flash.distance = num(ctx, "flash.range")
      // Tight depth range for the beam: precision where the floor actually is.
      flash.shadow.camera.far = Math.min(flash.distance, 25)
      flash.intensity = num(ctx, "flash.intensity") * flashLevel
      flash.color.copy(flashColor)
      // The flashlight never leaves the light list (toggling its visibility would change every material's light
      // set and recompile them all on F): off is zero intensity and a frozen shadow map.
      const lit = flashLevel > 0.01
      const wantShadow = flag(ctx, "flash.shadows")
      flash.shadow.autoUpdate = lit && wantShadow
      flash.shadow.intensity = wantShadow ? 1 : 0
      const fsize = Number(ctx.settings["flash.shadowSize"])
      if (flash.shadow.mapSize.x !== fsize) {
        flash.shadow.mapSize.setScalar(fsize)
        flash.shadow.needsUpdate = true
      }
      const fs = renderState.flash
      fs.on = lit
      fs.pos.copy(flash.position)
      fs.dir.copy(flashDir)
      fs.radiance.copy(flashColor).multiplyScalar(flash.intensity * num(ctx, "flash.scatter"))
      fs.range = flash.distance
      fs.cosOuter = Math.cos(angle)
      fs.cosInner = Math.cos(angle * 0.45)

      // Glow instances.
      const gs = num(ctx, "glow.strength")
      const gz = num(ctx, "glow.size")
      const c = centerAttr.array as Float32Array
      const col = colorAttr.array as Float32Array
      const d = dirAttr.array as Float32Array
      for (let i = 0; i < glowRigs.length; i++) {
        const r = glowRigs[i]!
        // Halo quad sized from the emitter but capped: a 1.2 m panel must not get a 5 m sprite.
        const size = Math.min(Math.max(r.lamp.size ?? 0.2, 0.05), 0.45)
        c[i * 4] = r.pos.x
        c[i * 4 + 1] = r.pos.y - (r.dir ? 0.1 : 0)
        c[i * 4 + 2] = r.pos.z
        c[i * 4 + 3] = size * gz
        // Emitter luminance ~ intensity / visible area, kept in a range bloom turns into a soft halo.
        const lum =
          (gs * r.glow * r.glowVis * r.level * r.transmittance * Math.sqrt(r.lamp.intensity * r.scale)) / (Math.max(size, 0.15) * 6)
        col[i * 4] = r.color.r * lum
        col[i * 4 + 1] = r.color.g * lum
        col[i * 4 + 2] = r.color.b * lum
        d[i * 4] = r.dir?.x ?? 0
        d[i * 4 + 1] = r.dir?.y ?? 0
        d[i * 4 + 2] = r.dir?.z ?? 0
        d[i * 4 + 3] = r.dir ? 1 : 0
      }
      for (const a of [centerAttr, colorAttr, dirAttr]) {
        a.clearUpdateRanges()
        a.addUpdateRange(0, Math.max(1, glowRigs.length) * 4)
      }
      centerAttr.needsUpdate = true
      colorAttr.needsUpdate = true
      dirAttr.needsUpdate = true
    },
  }
  renderState.lightingUpdate = rig.update
  return rig
}
