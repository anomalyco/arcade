/** A CSS `cubic-bezier(x1, y1, x2, y2)`. */
export type Bezier = readonly [number, number, number, number]

/** Named curves offered as chips in the easing editor. */
export const EASINGS = {
  ease: [0.25, 0.1, 0.25, 1],
  in: [0.42, 0, 1, 1],
  out: [0, 0, 0.58, 1],
  "in-out": [0.42, 0, 0.58, 1],
  linear: [0, 0, 1, 1],
  smooth: [0.65, 0, 0.35, 1],
  snappy: [0.32, 0.72, 0, 1],
  back: [0.34, 1.56, 0.64, 1],
} as const satisfies Record<string, Bezier>
export type EasingName = keyof typeof EASINGS | "ease-in" | "ease-out" | "ease-in-out"

export const EASING_Y: readonly [number, number] = [-0.6, 1.6]

export function namedEasing(name: string): Bezier | undefined {
  const key = name.replace(/^ease-(?=in|out)/, "") as keyof typeof EASINGS
  return Object.hasOwn(EASINGS, key) ? EASINGS[key] : undefined
}

/** The chip name whose curve this is, if any. */
export function easingName(value: Bezier): string | undefined {
  return Object.entries(EASINGS).find(([, b]) => b.every((n, i) => n === value[i]))?.[0]
}

/** The curve's point at parameter `t` (not time): (0,0) → (1,1). */
export function bezierPoint([x1, y1, x2, y2]: Bezier, t: number): [number, number] {
  const u = 1 - t
  const a = 3 * u * u * t
  const b = 3 * u * t * t
  const c = t * t * t
  return [a * x1 + b * x2 + c, a * y1 + b * y2 + c]
}

export const bezierCss = (b: Bezier) => `cubic-bezier(${b.join(", ")})`
