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
  normalize,
  smoothstep,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl"
import { ConeClusteredLighting } from "./clustered"
import type { Lamp, WorldContext } from "../world/context"
import type { Player } from "../player"
import { distanceToBuilding, fogSigma, insideBuilding, opticalDepth } from "./atmosphere"
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
const ZONE_MARGIN = 25
const FADE_S = 0.35

type Flicker = { next: number; until: number; toggle: number; on: boolean; slow: number; seed: number }

type Rig = LampRuntime & {
  color: THREE.Color
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
const _tint = new THREE.Color()

/** Fluorescent stutter / dying sodium / beacon blink for one lamp at `time`. Returns the intensity multiplier. */
function flickerLevel(r: Rig, time: number, scale: number) {
  const lamp = r.lamp
  const amt = (lamp.flicker ?? 0) * scale
  if (lamp.kind === "warning") {
    if (r.animated) return 1
    // Filament beacon: ~1 s period, warm-up and cool-down lag rather than a hard square wave.
    const ph = (time * 0.9 + r.flicker.seed) % 1
    return ph < 0.5 ? 1 - Math.exp(-ph * 30) : Math.exp(-(ph - 0.5) * 14)
  }
  if (amt <= 0) return 1
  const f = r.flicker
  if (lamp.kind === "sodium") {
    // A tired high-pressure sodium lamp cycling: a slow sag, brief drop-outs and a restrike.
    const sag = 0.5 + 0.5 * Math.sin(time * 0.37 + f.seed * 6.28) * Math.sin(time * 0.13 + f.seed * 3)
    let level = 1 - amt * 0.45 * Math.max(0, sag)
    if (time > f.next) {
      f.until = time + 0.4 + random() * 1.6
      f.next = f.until + (3 + random() * 9) / amt
    }
    if (time < f.until) {
      const k = (f.until - time) / 1.2
      level *= 0.15 + 0.85 * Math.min(1, Math.max(0, 1 - k)) ** 2
    }
    return level
  }
  // Fluorescent: mostly steady with a slight 'breathing', then bursts of rapid stutter where the tube drops out.
  let level = 1 - amt * 0.06 * (0.5 + 0.5 * Math.sin(time * 23 + f.seed * 40))
  if (time > f.next) {
    f.until = time + 0.08 + random() * 0.7 * amt
    f.next = f.until + (0.6 + random() * 5) / Math.max(amt, 0.05)
    f.toggle = time
  }
  if (time < f.until) {
    if (time > f.toggle) {
      f.on = !f.on
      f.toggle = time + 0.02 + random() * 0.07
    }
    level *= f.on ? 0.75 + random() * 0.25 : 0.04 + random() * 0.12 * (1 - amt)
  }
  return level
}

/** Shaped flashlight beam: a hot centre, a darker ring, a bright caustic ring and a soft wide spill. */
const flashCookie = Fn(([coord]: [N]) => {
  const r = length(coord.xy.sub(0.5)).mul(2)
  const hot = exp(r.mul(r).mul(-14)).mul(1.1)
  const ring = exp(abs(r.sub(0.34)).mul(-30)).mul(0.45)
  const dip = exp(abs(r.sub(0.24)).mul(-24)).mul(-0.15)
  const spill = smoothstep(1, 0.25, r).mul(0.28)
  // Slight lens/reflector imperfection so the spot isn't perfectly round.
  const ang = atan(coord.y.sub(0.5), coord.x.sub(0.5))
  const wobble = ang.mul(5).sin().mul(0.04).add(ang.mul(3).add(1.3).sin().mul(0.03)).add(1)
  return vec3(1, 0.97, 0.9).mul(max(hot.add(ring).add(dip).add(spill), 0).mul(wobble))
})

export function createLighting(ctx: WorldContext, player: Player) {
  addControls(ctx, [
    { key: "light.lamps", label: "Lamp intensity", group: "Lighting", unit: "×", min: 0, max: 4, step: 0.05, value: 1 },
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
      flicker: { next: random() * 4, until: 0, toggle: 0, on: true, slow: 0, seed: random() },
      lastIntensity: lamp.intensity,
      animated: false,
      glow: lamp.kind === "window" ? 0 : 1,
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
      light.shadow.bias = -0.0004
      light.shadow.normalBias = 0.03
      light.shadow.radius = 3
      light.shadow.camera.near = 0.25
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
  flash.shadow.bias = -0.0003
  flash.shadow.normalBias = 0.02
  flash.shadow.camera.near = 0.2
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

  // Clustered lights cost per pixel for every light whose sphere touches the pixel's cluster, and their data is
  // re-sorted and re-uploaded each frame: drop lamps whose light can't reach anything on screen (outside the view
  // frustum, switched off, still parked by the streaming loader) and, across the building shell, lamps on the
  // other side of the walls when the camera is not near a door or window.
  const frustum = new THREE.Frustum()
  const projView = new THREE.Matrix4()
  const sphere = new THREE.Sphere()
  let camInside = false
  let camNearBuilding = false
  const lampNeeded = (r: Rig) => {
    if (r.level <= 0.003 || r.lamp.intensity <= 0 || r.pos.y < -500) return false
    sphere.set(r.pos, r.lamp.range)
    if (!frustum.intersectsSphere(sphere)) return false
    const inside = insideBuilding(r.pos)
    if (inside !== camInside && !camNearBuilding) return false
    return true
  }
  const tmpCam = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const order: Rig[] = []
  let frame = 0

  const rig = {
    update(dt: number, time: number) {
      frame++
      adoptLamps()
      ;(glows as unknown as { count: number }).count = glowRigs.length
      glows.visible = glowRigs.length > 0
      camera.updateMatrixWorld()
      tmpCam.setFromMatrixPosition(camera.matrixWorld)
      const lampScale = num(ctx, "light.lamps")
      const flickerScale = num(ctx, "light.flicker")
      const sodiumShift = num(ctx, "light.sodiumShift")
      hemi.intensity = num(ctx, "light.ambient")
      const cull = flag(ctx, "light.cull")
      projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      frustum.setFromProjectionMatrix(projView)
      camInside = insideBuilding(tmpCam)
      camNearBuilding = distanceToBuilding(tmpCam) < ZONE_MARGIN

      // Lamps: live position/intensity (builders may animate them), flicker, fog terms.
      for (const r of rigs) {
        const l = r.lamp
        if (l.intensity !== r.lastIntensity) {
          r.animated = true
          r.lastIntensity = l.intensity
        }
        r.pos.set(l.position[0], l.position[1], l.position[2])
        if (r.dir) r.pos.addScaledVector(r.dir, 0.12)
        r.level = flickerLevel(r, time, flickerScale)
        lampColor(l, sodiumShift, r.color)
        r.radiance.copy(r.color).multiplyScalar(l.intensity * lampScale)
        r.distance = r.pos.distanceTo(tmpCam)
        r.sigma = fogSigma(r.pos)
        r.transmittance = Math.exp(-opticalDepth(tmpCam, r.pos))
        r.point.position.copy(r.pos)
        r.point.color.copy(r.color)
        r.point.distance = l.range
        r.point.intensity = l.intensity * lampScale * r.level * (1 - r.shadowWeight)
        r.point.visible = !cull || lampNeeded(r)
      }

      // Shadow pool: pick the most important shadow-casting fixtures near the camera.
      const key = `${ctx.settings["light.shadows"]}/${ctx.settings["light.shadowSize"]}`
      if (key !== poolKey) {
        poolKey = key
        makeSlots()
      }
      order.length = 0
      for (const r of rigs) {
        if (!r.lamp.shadow || !r.dir || !r.point.visible || r.pos.y < -500 || r.distance > r.lamp.range + 15) continue
        order.push(r)
      }
      const score = (r: Rig) => (r.lamp.intensity * (0.3 + 0.7 * r.level)) / (Math.max(r.distance - r.lamp.range * 0.3, 1) ** 2)
      order.sort((a, b) => score(b) - score(a))
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
        s.light.color.copy(w.color)
        s.light.intensity = w.lamp.intensity * lampScale * w.level * w.shadowWeight
        // The world is static; refresh one pooled map now and then in case geometry streamed in.
        if (frame % 45 === slots.indexOf(s) * 7 || frame < 6) s.light.shadow.needsUpdate = true
      }

      // Flashlight: hand-held, lagging slightly behind the view.
      const on = player.flashlight
      flashLevel += ((on ? 1 : 0) - flashLevel) * Math.min(1, dt * 30)
      const forward = fwd.set(0, -0.04, -1).applyQuaternion(camera.quaternion).normalize()
      const lag = num(ctx, "flash.lag")
      const k = lag > 0 ? 1 - Math.exp(-dt / lag) : 1
      flashDir.lerp(forward, frame < 3 ? 1 : k).normalize()
      flash.position.set(0.22, -0.28, -0.1).applyQuaternion(camera.quaternion).add(tmpCam)
      flash.target.position.copy(flash.position).addScaledVector(flashDir, 10)
      const angle = (num(ctx, "flash.angle") * Math.PI) / 180
      flash.angle = angle
      flash.distance = num(ctx, "flash.range")
      flash.shadow.camera.far = flash.distance
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
        const size = Math.max(r.lamp.size ?? 0.2, 0.05)
        c[i * 4] = r.pos.x
        c[i * 4 + 1] = r.pos.y - (r.dir ? 0.1 : 0)
        c[i * 4 + 2] = r.pos.z
        c[i * 4 + 3] = size * gz
        // Emitter luminance ~ intensity / visible area, kept in a range bloom turns into a soft halo.
        const lum = (gs * r.level * r.transmittance * Math.sqrt(r.lamp.intensity * lampScale)) / (size * 6)
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
