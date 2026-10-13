/** Presentation-only powertrain. Speeds are m/s, angles radians, RPM crank revolutions/minute. */
export const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x))
export type Character = { cylinders: number; idle: number; redline: number; ratios: number[]; final: number; exhaust: number; intake: number; uneven: number }
const muscle: Character = { cylinders: 8, idle: 780, redline: 6200, ratios: [3.2, 2.05, 1.42, 1.05, 0.82], final: 3.7, exhaust: 700, intake: 1500, uneven: 0.32 }
const van: Character = { cylinders: 6, idle: 680, redline: 4600, ratios: [3.5, 2.15, 1.45, 1], final: 3.6, exhaust: 480, intake: 950, uneven: 0.2 }
export const characters: Record<string, Character> = {
  muscle,
  jeep: { ...muscle, cylinders: 6, redline: 5400, final: 4.6, exhaust: 620, uneven: 0.22 },
  scooter: { cylinders: 1, idle: 1600, redline: 9000, ratios: [3.2, 2.3, 1.7, 1.25], final: 5.5, exhaust: 1700, intake: 2800, uneven: 0.12 },
  compact: { cylinders: 4, idle: 950, redline: 7200, ratios: [3.6, 2.25, 1.6, 1.2, 0.94], final: 4.3, exhaust: 1100, intake: 2100, uneven: 0.07 },
  van, swat: van,
  bike: { cylinders: 4, idle: 1400, redline: 11500, ratios: [3.1, 2.3, 1.85, 1.5, 1.25, 1.05], final: 6.1, exhaust: 1900, intake: 3100, uneven: 0.04 },
  cruiser: { ...muscle, redline: 5700, final: 3.35, exhaust: 570, uneven: 0.19 },
  interceptor: { ...muscle, cylinders: 6, redline: 7000, exhaust: 1000, uneven: 0.1 },
}
export const character = (id: string) => characters[id] ?? muscle

export class Gearbox {
  gear = 0
  rpm: number
  shift = 0
  shifted = false
  private cooldown = 0.5
  constructor(readonly spec: Character) { this.rpm = spec.idle }
  update(speed: number, throttle: number, boost: boolean, dt: number) {
    dt = clamp(dt, 0, 0.1)
    const s = this.spec
    const wheel = Math.abs(speed) * 60 / (2 * Math.PI * 0.34) * s.final
    this.shifted = false
    this.cooldown = Math.max(0, this.cooldown - dt)
    this.shift = Math.max(0, this.shift - dt)
    const coupled = wheel * s.ratios[this.gear]!
    // Downshift tests the next gear: prevents hunting around a speed boundary.
    if (!this.cooldown && speed >= 0) {
      if (coupled > s.redline * (throttle > 0.7 || boost ? 0.88 : 0.72) && this.gear < s.ratios.length - 1) {
        this.gear++; this.shifted = true
      } else if (this.gear > 0 && wheel * s.ratios[this.gear - 1]! < s.redline * 0.57) {
        this.gear--; this.shifted = true
      }
      if (this.shifted) { this.shift = 0.16; this.cooldown = 0.65 }
    }
    if (speed < 0) this.gear = 0
    const clutch = s.idle + clamp(throttle) * (boost ? 2400 : 1600)
    const target = clamp(Math.max(clutch, wheel * s.ratios[this.gear]!) * (this.shift > 0 ? 0.85 : 1), s.idle, s.redline)
    this.rpm += (target - this.rpm) * (1 - Math.exp(-dt * (target < this.rpm ? 18 : 9)))
    return this.rpm
  }
}

export type Surface = "road" | "kerb" | "grass"
export function tyreSlip(speed: number, lateral: number, ratio: number, handbrake: boolean, airborne = false, surface: Surface = "road") {
  const v = Math.abs(speed)
  const angle = Math.atan2(Math.abs(lateral), Math.max(3, v))
  const slip = clamp(Math.max((angle - 0.055) / 0.42, Math.abs(ratio) * 0.85, handbrake ? v / 28 : 0))
  const movement = airborne ? 0 : clamp(v / 5 + Math.abs(ratio) * 0.65)
  const squeal = clamp((slip - 0.22) / 0.65) ** 1.35 * movement * (surface === "grass" ? 0.08 : 1)
  return { slip, squeal, scrub: movement * clamp(slip * 1.8 + (surface !== "road" ? v / 70 : 0)) * (1 - squeal * 0.55), hz: 900 + 1350 * slip + 200 * clamp(v / 45) }
}
