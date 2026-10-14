const clamp = (v: number) => Math.max(0, Math.min(1, v))
const smooth = (v: number) => { const t = clamp(v); return t * t * (3 - 2 * t) }
export const wrapHour = (hour: number) => ((hour % 24) + 24) % 24
/** timeScale is simulated seconds per real second. */
export const advanceHour = (hour: number, dt: number, timeScale: number) => wrapHour(hour + dt * timeScale / 3600)

export function dayCycle(hour: number) {
  hour = wrapHour(hour)
  const elevation = Math.sin((hour - 6) / 24 * Math.PI * 2)
  const daylight = smooth((elevation + .12) / .52)
  const dusk = Math.max(0, 1 - Math.abs(hour - 18.2) / 2.2) * (1 - daylight * .6)
  const arc = (hour - 6) / 24 * Math.PI * 2
  const sign = elevation >= 0 ? 1 : -1
  const raw = [Math.cos(arc) * sign, Math.max(.22, Math.abs(elevation)), .38]
  const length = Math.hypot(...raw)
  return {
    ambient: [.024 + daylight * .33 + dusk * .014, .042 + daylight * .35 + dusk * .026, .086 + daylight * .36 + dusk * .058] as const,
    direction: raw.map(v => v / length) as [number, number, number],
    sun: daylight,
    strength: .12 + daylight * .58 + dusk * .06,
    lamps: 1 - smooth((elevation + .03) / .15),
  }
}

export const clockText = (hour: number) => `${Math.floor(wrapHour(hour)).toString().padStart(2, "0")}:${Math.floor(wrapHour(hour) % 1 * 60).toString().padStart(2, "0")}`
