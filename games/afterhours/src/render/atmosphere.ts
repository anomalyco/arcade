import * as THREE from "three/webgpu"
import {
  Fn as TslFn,
  abs,
  cameraPosition,
  exp,
  fog,
  max,
  min,
  mix,
  positionWorld,
  positionWorldDirection,
  select,
  smoothstep,
  uniform,
  vec2,
  vec3,
  float,
  pmremTexture,
  normalWorld,
} from "three/tsl"
import type { WorldContext } from "../world/context"
import { VOLUMES, distanceToBuilding as distToBuilding, inside, insideNode } from "./volumes"
import { addControls, num } from "./shared"

// Night sky and exponential height fog. The fog is evaluated analytically along each view ray (height falloff plus a
// thin interior density inside the building shell), shared by the scene's fogNode, the sky, the post chain (AO and
// reflections fade into it) and the lighting rig (per-lamp transmittance on the CPU), so all of them agree.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any
const Fn = TslFn as N

const BOXES = VOLUMES

export const fogUniforms = {
  /** Extinction at the base height (1/m). */
  density: uniform(0.014),
  /** Height falloff (1/m). */
  falloff: uniform(1 / 28),
  base: uniform(0),
  interior: uniform(0.004),
  /** Radiance of the interior haze where no lamp lights it: dark and neutral, not the outdoor teal skylight. */
  interiorColor: uniform(new THREE.Color()),
  envInterior: uniform(0.06),
  interiorAmbient: uniform(new THREE.Color()),
  color: uniform(new THREE.Color()),
  skyColor: uniform(new THREE.Color()),
  skyGlow: uniform(0.3),
}

const envGround = uniform(0.12)

/** CPU mirror of the fog for per-lamp transmittance. */
const fogCpu = { density: 0.014, falloff: 1 / 28, base: 0, interior: 0.004 }

function boxSpan(ax: number, ay: number, az: number, dx: number, dy: number, dz: number, b: (typeof BOXES)[number]) {
  let t0 = 0
  let t1 = 1
  const o = [ax, ay, az]
  const d = [dx, dy, dz]
  for (let i = 0; i < 3; i++) {
    const di = d[i]!
    if (Math.abs(di) < 1e-6) {
      if (o[i]! < b.min[i]! || o[i]! > b.max[i]!) return 0
      continue
    }
    let ta = (b.min[i]! - o[i]!) / di
    let tb = (b.max[i]! - o[i]!) / di
    if (ta > tb) [ta, tb] = [tb, ta]
    t0 = Math.max(t0, ta)
    t1 = Math.min(t1, tb)
  }
  return Math.max(0, t1 - t0)
}

/** Optical depth (dimensionless) of the fog between two world points. */
export function opticalDepth(a: THREE.Vector3, b: THREE.Vector3) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-4) return 0
  const x = fogCpu.falloff * dy
  const f = Math.abs(x) > 1e-3 ? (1 - Math.exp(-x)) / x : 1 - x / 2
  const height = fogCpu.density * Math.exp(-fogCpu.falloff * Math.min(a.y - fogCpu.base, 200)) * len * f
  let inside = 0
  for (const box of BOXES) inside += boxSpan(a.x, a.y, a.z, dx, dy, dz, box)
  inside = Math.min(inside, 1)
  return height * (1 - inside) + fogCpu.interior * len * inside
}

export const distanceToBuilding = distToBuilding

/** Inside the building or the booth (fog/exposure sense). */
export function insideBuilding(p: THREE.Vector3) {
  return inside(p, true)
}

/** Local extinction at a point (1/m), interior-aware. */
export function fogSigma(p: THREE.Vector3) {
  if (inside(p, true)) return fogCpu.interior
  return fogCpu.density * Math.exp(-fogCpu.falloff * Math.min(p.y - fogCpu.base, 200))
}

const boxSpanNode = (o: N, d: N, b: (typeof BOXES)[number]) => {
  // Slab test in the segment's parameter space [0, 1]; the epsilon keeps axis-parallel rays finite.
  const inv = vec3(1).div(d.add(vec3(1e-6)))
  const ta = vec3(...b.min).sub(o).mul(inv)
  const tb = vec3(...b.max).sub(o).mul(inv)
  const lo = min(ta, tb)
  const hi = max(ta, tb)
  const t0 = max(max(lo.x, lo.y), max(lo.z, 0))
  const t1 = min(min(hi.x, hi.y), min(hi.z, 1))
  return max(t1.sub(t0), 0)
}

/** TSL optical depth between two world points, split into (outdoor, indoor) parts. */
export const fogOpticalDepth2 = Fn(([a, b]: [N, N]) => {
  const d = b.sub(a).toVar()
  const len = d.length().max(1e-4)
  const x = fogUniforms.falloff.mul(d.y).toVar()
  const f = (select as N)(abs(x).greaterThan(1e-3), exp(x.negate()).oneMinus().div(x), x.mul(-0.5).add(1))
  const height = fogUniforms.density.mul(exp(fogUniforms.falloff.negate().mul(min(a.y.sub(fogUniforms.base), 200)))).mul(len).mul(f)
  let inside: N = boxSpanNode(a, d, BOXES[0])
  for (let i = 1; i < BOXES.length; i++) inside = inside.add(boxSpanNode(a, d, BOXES[i]!))
  const inn = inside.min(1).toVar()
  return (vec2 as N)(height.mul(inn.oneMinus()), fogUniforms.interior.mul(len).mul(inn))
})

/** TSL optical depth between two world points (same model as `opticalDepth`). */
export const fogOpticalDepth = (a: N, b: N) => {
  const t = fogOpticalDepth2(a, b)
  return t.x.add(t.y)
}

/** Local extinction (1/m) at a world point in a shader, with a soft ramp through walls and doorways. */
export const fogSigmaNode = (p: N) => {
  const ins = insideNode(p, 0.6)
  const out = fogUniforms.density.mul(exp(fogUniforms.falloff.negate().mul(min(p.y.sub(fogUniforms.base), 200))))
  return mix(out, fogUniforms.interior, ins)
}

/** Fog transmittance from the camera to a world point. */
export const fogTransmittance = (camera: N, world: N) => exp(fogOpticalDepth(camera, world).negate())

/** Sky radiance for a view direction: the dark overcast seen through the fog bank, with a faint low glow. */
export const skyRadiance = (camera: N, dir: N) => {
  const far = camera.add(dir.mul(4000))
  const t = fogTransmittance(camera, far)
  const up = dir.y.max(0)
  const dark = fogUniforms.skyColor.mul(mix(1, 0.55, smoothstep(0, 0.8, up)))
  // Light pollution and the lamps of the compound faintly lighting the cloud deck from below, mostly near the horizon.
  const glow = fogUniforms.color.mul(fogUniforms.skyGlow).mul(exp(up.mul(-5)))
  return mix(fogUniforms.color, dark.add(glow), t)
}

export function createAtmosphere(ctx: WorldContext) {
  addControls(ctx, [
    { key: "fog.density", label: "Ground density", group: "Fog", unit: "1/m", min: 0, max: 0.06, step: 0.0005, value: 0.01 },
    { key: "fog.height", label: "Height falloff", group: "Fog", unit: "m", min: 4, max: 120, step: 1, value: 20 },
    { key: "fog.interior", label: "Interior haze", group: "Fog", unit: "1/m", min: 0, max: 0.03, step: 0.0005, value: 0.012 },
    { key: "fog.hue", label: "Colour hue", group: "Fog", unit: "°", min: 120, max: 220, step: 1, value: 181 },
    { key: "fog.saturation", label: "Colour saturation", group: "Fog", min: 0, max: 1, step: 0.01, value: 0.75 },
    { key: "fog.brightness", label: "Brightness", group: "Fog", min: 0, max: 0.5, step: 0.001, value: 0.034 },
    { key: "sky.dark", label: "Sky above fog", group: "Fog", min: 0, max: 1, step: 0.01, value: 0.45 },
    { key: "sky.glow", label: "Horizon glow", group: "Fog", min: 0, max: 2, step: 0.01, value: 0.35 },
    { key: "env.intensity", label: "Fog skylight (ambient + reflections)", group: "Fog", unit: "×", min: 0, max: 3, step: 0.01, value: 1 },
    { key: "env.interior", label: "Skylight left indoors", group: "Fog", min: 0, max: 1, step: 0.01, value: 0.06 },
    { key: "env.interiorGI", label: "Interior bounce (ambient GI)", group: "Fog", min: 0, max: 0.2, step: 0.001, value: 0.08 },
    { key: "fog.interiorTone", label: "Interior haze brightness", group: "Fog", min: 0, max: 0.05, step: 0.0005, value: 0.004 },
    { key: "env.ground", label: "Ground bounce", group: "Fog", min: 0, max: 1, step: 0.01, value: 0.12 },
  ])

  ctx.scene.background = null
  ctx.scene.fog = null
  // Outdoor and indoor stretches of the view ray fog towards different colours: the teal fog bank outside, a dark
  // neutral haze inside (its light comes from the lamps' in-scattering, added in post).
  const tau = fogOpticalDepth2(cameraPosition, positionWorld).toVar()
  const aOut = exp(tau.x.negate()).oneMinus()
  const aIn = exp(tau.y.negate()).oneMinus()
  const fogFactor = exp(tau.x.add(tau.y).negate()).oneMinus()
  const fogColor = fogUniforms.color.mul(aOut).add(fogUniforms.interiorColor.mul(aIn)).div(aOut.add(aIn).max(1e-5))
  ;(ctx.scene as unknown as { fogNode: N }).fogNode = fog(fogColor, fogFactor)
  ctx.scene.backgroundNode = skyRadiance(cameraPosition, positionWorldDirection)

  // Skylight: the fog bank itself is the only ambient source. Bake the sky (as seen from eye height, fully fogged at
  // the horizon) plus a dark ground into a PMREM so diffuse ambient and wet-surface reflections both see it.
  const envScene = new THREE.Scene()
  const eye = vec3(0, 1.7, 0)
  const ground = fogUniforms.color.mul(envGround)
  const envMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide })
  envMat.colorNode = mix(ground, skyRadiance(eye, positionWorldDirection), smoothstep(-0.12, 0.02, positionWorldDirection.y))
  envMat.fog = false
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), envMat))
  const pmrem = new THREE.PMREMGenerator(ctx.renderer)
  let envTarget: THREE.RenderTarget | null = null
  let envKey = ""
  let envNode: N = null
  const bakeEnv = () => {
    const key = ["fog.hue", "fog.saturation", "fog.brightness", "sky.dark", "sky.glow", "env.ground", "fog.density", "fog.height"]
      .map((k) => ctx.settings[k])
      .join("/")
    if (key === envKey) return
    envKey = key
    envTarget?.dispose()
    envTarget = pmrem.fromScene(envScene as never, 0.02) as unknown as THREE.RenderTarget
    if (envNode) {
      envNode.value = envTarget.texture
      return
    }
    // Inside the building the fog-sky skylight can't reach the walls: fade the environment to a faint remnant there
    // (ambient and reflections), keeping exterior faces of the outer walls on the sky.
    envNode = (pmremTexture as N)(envTarget.texture)
    // Indoors the sky can't reach: the environment becomes a dim warm-green bounce (light off tile and lino),
    // a little brighter from below than above so ceilings don't fall to black — cheap stand-in for interior GI.
    const ins = insideNode(positionWorld, 0.05, false)
    const up = (normalWorld as N).y
    const bounce = fogUniforms.interiorAmbient.mul(mix(float(1.15), float(0.8), up.mul(0.5).add(0.5)))
    ;(ctx.scene as unknown as { environmentNode: N }).environmentNode = mix(envNode, envNode.mul(fogUniforms.envInterior).add(bounce), ins)
  }

  const hsl = new THREE.Color()
  const apply = () => {
    fogCpu.density = num(ctx, "fog.density")
    fogCpu.falloff = 1 / num(ctx, "fog.height")
    fogCpu.interior = num(ctx, "fog.interior")
    fogUniforms.density.value = fogCpu.density
    fogUniforms.falloff.value = fogCpu.falloff
    fogUniforms.interior.value = fogCpu.interior
    // Hue/saturation pick the tint; brightness is the linear radiance of fully fogged distance.
    hsl.setHSL(num(ctx, "fog.hue") / 360, num(ctx, "fog.saturation"), 0.5)
    const lum = 0.2126 * hsl.r + 0.7152 * hsl.g + 0.0722 * hsl.b
    fogUniforms.color.value.copy(hsl).multiplyScalar(num(ctx, "fog.brightness") / Math.max(lum, 1e-4))
    fogUniforms.skyColor.value.copy(fogUniforms.color.value).multiplyScalar(num(ctx, "sky.dark"))
    fogUniforms.skyGlow.value = num(ctx, "sky.glow")
    envGround.value = num(ctx, "env.ground")
    fogUniforms.envInterior.value = num(ctx, "env.interior")
    fogUniforms.interiorAmbient.value.setRGB(0.78, 0.95, 0.7).multiplyScalar(num(ctx, "env.interiorGI"))
    fogUniforms.interiorColor.value.setRGB(0.9, 0.95, 0.92).multiplyScalar(num(ctx, "fog.interiorTone"))
    ctx.scene.environmentIntensity = num(ctx, "env.intensity")
    bakeEnv()
  }
  apply()
  return {
    update(_dt: number, _time: number) {
      apply()
    },
  }
}
