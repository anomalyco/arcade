const clamp = (v: number) => Math.max(0, Math.min(1, v))
const smooth = (v: number) => {
  const t = clamp(v)
  return t * t * (3 - 2 * t)
}
export const wrapHour = (hour: number) => ((hour % 24) + 24) % 24
/** timeScale is simulated seconds per real second. */
export const advanceHour = (hour: number, dt: number, timeScale: number) => wrapHour(hour + (dt * timeScale) / 3600)

export type DayCyclePhase = "day" | "dusk" | "night" | "dawn"

export function dayCycle(hour: number) {
  hour = wrapHour(hour)
  const arc = ((hour - 6) / 24) * Math.PI * 2
  const elevation = Math.sin(arc)
  const daylight = smooth((elevation + 0.02) / 0.54)
  // Continuous C1 darkness curve: 0 during peaceful day (08:45..15:15), ~0.5 at dusk (17:00) & dawn (07:00), 1 in Noir night (18:15..05:45)
  const darkness = 1 - daylight
  const threat = smooth(darkness)
  const twilight = 4 * darkness * (1 - darkness)
  const dusk = Math.max(0, 1 - Math.abs(hour - 17.4) / 2.2) * (1 - daylight * 0.5)
  const sign = elevation >= 0 ? 1 : -1
  const raw = [Math.cos(arc) * sign, Math.max(0.22, Math.abs(elevation)), 0.38]
  const length = Math.hypot(...raw)
  const phase: DayCyclePhase = darkness < 0.12 ? "day" : darkness > 0.88 ? "night" : hour >= 12 ? "dusk" : "dawn"
  return {
    phase,
    ambient: [
      0.024 + daylight * 0.33 + dusk * 0.018,
      0.042 + daylight * 0.35 + dusk * 0.028,
      0.086 + daylight * 0.36 + dusk * 0.058,
    ] as const,
    direction: raw.map((v) => v / length) as [number, number, number],
    sun: daylight,
    twilight,
    darkness,
    threat,
    strength: 0.12 + daylight * 0.58 + dusk * 0.08,
    lamps: 1 - smooth((elevation - 0.04) / 0.48),
  }
}

export const clockText = (hour: number) =>
  `${Math.floor(wrapHour(hour)).toString().padStart(2, "0")}:${Math.floor((wrapHour(hour) % 1) * 60)
    .toString()
    .padStart(2, "0")}`
