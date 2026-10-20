import * as THREE from "three/webgpu"
import { float, mix, positionWorld, uniform } from "three/tsl"
import type { WorldContext } from "../world/context"
import { fogUniforms } from "./atmosphere"
import { addControls, num } from "./shared"
import { insideNode } from "./volumes"

// Lightning visuals. A strike is a few return-stroke pulses (each a near-instant rise and a ~0.06–0.12 s fall, as
// in photographs and high-speed video of cloud-to-ground flashes). Its light reaches the scene three ways:
//   - every strike: the cloud deck and the fog bank glow around the strike's bearing (atmosphere.ts `flashLobe`,
//     used by the sky, the fog colour and therefore the view through windows), dimming with distance;
//   - near strikes (< ~2.5 km): a cool directional fill from the strike's bearing and elevation with a crisp shadow
//     map (tree, fence and building silhouettes), plus a flat cool skylight outdoors;
//   - nothing else: no exposure change (post exposure is fixed), no bolt geometry (a billboard bolt read as a decal
//     in the fog; behind the fog bank a real bolt is a lit patch of cloud anyway, which the glow already shows).
// Idle cost: the fill light is always in the light list (adding/removing it would recompile every material) at zero
// intensity with a frozen shadow map, and the glow uniforms are zero; nothing renders or updates between strikes.

export type LightningEvent = {
  /** Time of the flash (s) on the `performance.now() / 1000` clock; earlier or omitted = now. */
  at?: number
  distanceM: number
  /** Bearing of the strike from the player, radians: 0 = north (−Z), positive towards west (−X), like player yaw. */
  bearingRad: number
  /** 0..1 */
  intensity: number
  /** Return-stroke onsets in seconds after `at`. */
  flashes: number[]
}

type Active = { t0: number; pulses: number[]; dist: number; bearing: number; intensity: number; near: number; glow: number }

const listeners: ((e: LightningEvent) => void)[] = []
/** Fire a strike's visuals (the weather system calls this through `onLightning`; tests can call it directly). */
export function strike(e: LightningEvent) {
  for (const l of listeners) l(e)
}

// Hooks up to the weather module (world/weather.ts) once it exists; `import.meta.glob` is empty until then.
const weatherModules = import.meta.glob("../world/weather.ts")

export function createLightning(ctx: WorldContext) {
  addControls(ctx, [
    { key: "lightning.glow", label: "Cloud and fog glow", group: "Lightning", unit: "×", min: 0, max: 4, step: 0.05, value: 1 },
    { key: "lightning.fill", label: "Near-strike light on the world", group: "Lightning", unit: "×", min: 0, max: 4, step: 0.05, value: 1 },
    { key: "lightning.decay", label: "Pulse decay", group: "Lightning", unit: "s", min: 0.02, max: 0.3, step: 0.005, value: 0.075 },
    {
      key: "lightning.test",
      label: "Test strike (visuals only)",
      group: "Lightning",
      type: "action",
      run: () => strike(testStrike(ctx.camera, 900)),
      value: 0,
    },
    {
      key: "lightning.testFar",
      label: "Test distant strike (visuals only)",
      group: "Lightning",
      type: "action",
      run: () => strike(testStrike(ctx.camera, 8000)),
      value: 0,
    },
  ])

  const { scene, camera } = ctx
  const sun = new THREE.DirectionalLight(0xcfdcff, 0)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.autoUpdate = false
  const sc = sun.shadow.camera as THREE.OrthographicCamera
  sc.left = sc.bottom = -45
  sc.right = sc.top = 45
  sc.near = 1
  sc.far = 260
  sun.shadow.bias = -0.0006
  sun.shadow.normalBias = 0.04
  sun.shadow.radius = 1
  // Indoors it would leak through roofs and walls the 90 m shadow map is too coarse for: off inside the volumes (the
  // windows still flash: the sky and fog seen through them carry the glow).
  const flashSun = uniform(new THREE.Color(0, 0, 0))
  ;(sun as unknown as { colorNode: unknown }).colorNode = flashSun.mul(mix(float(1), float(0), insideNode(positionWorld, 0.3)))
  scene.add(sun, sun.target)

  const active: Active[] = []
  // Automation can drive the strike clock frame by frame (deterministic captures); null = real time.
  const clock = { t: null as number | null }
  const nowS = () => clock.t ?? performance.now() / 1000
  const onStrike = (e: LightningEvent) => {
    const t = nowS()
    const t0 = e.at !== undefined && e.at > t - 5 && e.at < t + 30 ? e.at : t
    // Physical-ish falloff: the lit cloud patch's brightness at the eye falls with distance through haze.
    const km = Math.max(0.2, e.distanceM / 1000)
    const glow = e.intensity / (1 + (km / 6) ** 2)
    const near = e.intensity * Math.max(0, 1 - km / 2.5) ** 1.5
    active.push({ t0, pulses: e.flashes.length ? e.flashes : [0], dist: e.distanceM, bearing: e.bearingRad, intensity: e.intensity, near, glow })
  }
  listeners.push(onStrike)
  void Object.values(weatherModules)[0]?.().then((m) => {
    const on = (m as { onLightning?: (cb: (e: LightningEvent) => void) => void }).onLightning
    on?.((e) => strike(e))
  })
  if (ctx.params.has("perf")) (globalThis as { __afterhoursLightning?: unknown }).__afterhoursLightning = { strike, test: (d: number) => strike(testStrike(camera, d)), clock, state: () => ({ active: active.length, sun: sun.intensity, glow: fogUniforms.flashGlow.value.r, amb: fogUniforms.flashAmbient.value.r }) }

  const dir = new THREE.Vector3()
  const camPos = new THREE.Vector3()
  const COLD = new THREE.Color(0.78, 0.84, 1.0)
  /** Peak irradiance of a near strike's flash relative to the scene's lamps (they are ~0.3–1 lux-equivalent). */
  const SUN = 6
  let wasLit = false
  return {
    update() {
      if (!active.length && !wasLit) return
      const t = nowS()
      const decay = num(ctx, "lightning.decay")
      let glow = 0
      let fill = 0
      let lead: Active | null = null
      let leadLevel = 0
      for (let i = active.length - 1; i >= 0; i--) {
        const a = active[i]!
        let level = 0
        let done = true
        for (const p of a.pulses) {
          const dt = t - a.t0 - p
          if (dt < 0) {
            done = false
            continue
          }
          // First stroke is the brightest; later ones a little weaker, with a slow-decaying continuing current.
          const k = p === a.pulses[0] ? 1 : 0.75
          const v = k * (Math.exp(-dt / decay) + 0.12 * Math.exp(-dt / (decay * 4)))
          if (v > 0.002) done = false
          level += v
        }
        if (done) {
          active.splice(i, 1)
          continue
        }
        glow += level * a.glow
        fill += level * a.near
        if (level * a.intensity > leadLevel) {
          leadLevel = level * a.intensity
          lead = a
        }
      }
      wasLit = active.length > 0
      const g = Math.min(glow, 3) * num(ctx, "lightning.glow")
      const f = Math.min(fill, 3) * num(ctx, "lightning.fill")
      if (lead) {
        // Direction towards the strike: horizontal bearing, raised to the lit cloud base (lower when far away).
        const elev = Math.atan2(1500, Math.max(lead.dist, 300))
        dir.set(-Math.sin(lead.bearing) * Math.cos(elev), Math.sin(elev), -Math.cos(lead.bearing) * Math.cos(elev))
        fogUniforms.flashDir.value.copy(dir)
        fogUniforms.flashSpread.value = 0.25 + 0.5 * Math.min(1, 800 / Math.max(lead.dist, 1))
      }
      fogUniforms.flashGlow.value.copy(COLD).multiplyScalar(0.06 * g)
      fogUniforms.flashAmbient.value.copy(COLD).multiplyScalar(0.025 * f)
      // The light's colorNode replaces colour × intensity, so the strength lives in this uniform.
      flashSun.value.copy(COLD).multiplyScalar(SUN * f)
      sun.intensity = f > 1e-4 ? 1 : 0
      if (f > 1e-4) {
        camPos.setFromMatrixPosition(camera.matrixWorld)
        sun.target.position.copy(camPos)
        sun.position.copy(camPos).addScaledVector(dir, 150)
        sun.target.updateMatrixWorld()
        sun.updateMatrixWorld()
        sun.shadow.needsUpdate = true
      }
    },
  }
}

function testStrike(camera: THREE.Camera, distanceM: number): LightningEvent {
  // Ahead and a little to the left of the view, so captures see it.
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ")
  return { distanceM, bearingRad: e.y + 0.35, intensity: 1, flashes: [0, 0.11, 0.19, 0.42] }
}
