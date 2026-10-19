import { Particles } from "@arcade/kit/fx/particles"
import type { FrameInput } from "@arcade/kit/gpu/renderer"
import { LIGHT_FLOATS } from "@arcade/kit/limits"
import type { Town } from "../../shared/map"
import type { OutbreakVehicle } from "../../shared/vehicles"
import type { OutbreakAirSettings } from "../air/settings"
import { WorldSmoke } from "../air/smoke"
import type { FireFrame } from "../fire/fx"
import { FlameFx } from "../fire/kit-fx"

/** Lights the kit particles see (the particle shader reads eight). */
const FX_LIGHTS = 8

/**
 * Outbreak's kit particle pool (`@arcade/kit/fx`, drawn by the renderer's `fxParticles` path): the kit fire
 * (`fire/kit-fx.ts`) and world smoke (`air/smoke.ts`). Each frame it ages the pool, takes the new births, and picks
 * the lights particles are lit by: the flashlight as a spot (so smoke catches the beam and nothing behind it), then
 * the strongest nearby lamps and fire lights. Ambient is the sky's grey level, so at night smoke is dark until a light
 * reaches it, and fire keeps its colour under the Noir colour mask (`keepColour`).
 */
export class OutbreakFxParticles {
  readonly particles = new Particles()
  readonly flames = new FlameFx()
  readonly smoke = new WorldSmoke()
  private readonly lights = new Float32Array(FX_LIGHTS * LIGHT_FLOATS)
  private readonly ambient: [number, number, number] = [0, 0, 0]
  private readonly pick: { i: number; score: number }[] = []
  private readonly wrecks: { id: string; x: number; y: number; h: number }[] = []
  readonly lighting: NonNullable<FrameInput["fxLighting"]> = { ambient: this.ambient, lights: this.lights, lightCount: 0, spotCones: true, keepColour: true }

  /** Proof readout: live particles, dropped births, this frame's fire births and smoking sources. */
  stats() {
    return { particles: this.particles.count, dropped: this.particles.dropped, lights: this.lighting.lightCount, fire: { ...this.flames.shown }, smoke: { ...this.smoke.shown } }
  }

  reset(): void {
    this.particles.reset()
    this.flames.reset()
    this.smoke.reset()
  }

  step(o: {
    dt: number
    fire: FireFrame
    town: Town
    air: OutbreakAirSettings
    vehicles: readonly OutbreakVehicle[]
    day: { readonly ambient: readonly [number, number, number]; readonly sun: number }
    skyFill: number
    interior: boolean
    support: (x: number, z: number) => number
  }): Particles | undefined {
    const p = this.particles
    // All Today: nothing of ours is drawn, so drop what is still alive rather than let it burn out.
    if (o.fire.look.fireStyle !== 1 && !o.air.worldSmoke) {
      p.reset()
      return undefined
    }
    p.update(o.dt, [], o.support)
    const view = o.fire.view
    this.wrecks.length = 0
    for (const v of o.vehicles) if (v.wreck) this.wrecks.push({ id: `${v.id}@${Math.round(v.x)},${Math.round(v.y)}`, x: v.x, y: v.y, h: v.h })
    this.smoke.emit(p, o.town, o.air, o.dt, view.player, o.day.sun, o.interior, o.support, this.wrecks)
    if (o.fire.look.fireStyle === 1) this.flames.emit(p, o.fire, o.dt)
    const a = o.day.ambient
    const grey = ((a[0] + a[1] + a[2]) / 3) * o.skyFill * o.air.smokeAmbient
    this.ambient[0] = grey
    this.ambient[1] = grey
    this.ambient[2] = grey * 1.02
    return p.count ? p : undefined
  }

  /**
   * Picks this frame's particle lights from the frame's `lights` (`count` of them; slot 0 is the eye, `flashlight`
   * the beam's slot or -1): the beam first as a plan-cone spot, then the strongest point lights near `(cx, cz)`.
   */
  packLights(lights: Float32Array, count: number, flashlight: number, cx: number, cz: number, air: OutbreakAirSettings): void {
    const out = this.lights
    out.fill(0)
    let n = 0
    if (flashlight > 0 && flashlight < count && air.smokeBeamCatch > 0) {
      const k = flashlight * LIGHT_FLOATS
      out.set(lights.subarray(k, k + 8), 0)
      // The scene shades the beam with its own radiance curve (FLASH_RADIANCE, a softened inverse square); the
      // particle shader's linear-squared falloff needs about five times the power to read the same in the air.
      out[7] = lights[k + 7]! * air.smokeBeamCatch * 5
      out[8] = lights[k + 8]!
      out[9] = lights[k + 9]!
      out[10] = lights[k + 10]!
      out[11] = 1
      n = 1
    }
    const pick = this.pick
    pick.length = 0
    if (air.smokeLampCatch > 0) {
      for (let i = 1; i < count; i++) {
        if (i === flashlight) continue
        const k = i * LIGHT_FLOATS
        const power = lights[k + 7]!
        const r = lights[k + 3]!
        // Skip spots and wall washes: the particle shader lights by distance only.
        if (power <= 0.01 || r <= 0.1 || lights[k + 11]! > 0.5) continue
        const d2 = (lights[k]! - cx) ** 2 + (lights[k + 2]! - cz) ** 2
        pick.push({ i, score: (power * r * r) / (1 + d2 / 64) })
      }
      pick.sort((l, r) => r.score - l.score)
    }
    for (let j = 0; j < pick.length && n < FX_LIGHTS; j++, n++) {
      const k = pick[j]!.i * LIGHT_FLOATS
      const o = n * LIGHT_FLOATS
      out.set(lights.subarray(k, k + 8), o)
      // Surfaces take about twice a point light's power up close (`lightAttenuation`); match that in the air.
      out[o + 7] = lights[k + 7]! * air.smokeLampCatch * 2
    }
    this.lighting.lightCount = n
  }
}

let current: OutbreakFxParticles | null = null

export function setCurrentFx(fx: OutbreakFxParticles): void {
  current = fx
}

export const currentFx = (): OutbreakFxParticles | null => current
