import { PORTRAITS } from "./index"

/**
 * Fitted thumbnails of the item portraits (AR-94): the largest the art can be inside a box less a margin, laid on the
 * diagonal (rising to the right) when that shows a long item noticeably bigger. The case's quick slots and the dock's
 * hand slots both draw items this way. Pure geometry plus markup, in whatever unit the caller's box is in.
 */

export type Box = { w: number; h: number }
/** The art's own size as it lies (`w`×`h`, the portrait's aspect) and how far it is turned, in degrees. */
export type Thumb = Box & { angle: number }

/** The dock's hand-slot thumbnail box and margin, in CSS pixels. */
export const DOCK_THUMB = { w: 34, h: 22, pad: 1 } as const

/** The axis-aligned box of a `w`×`h` rectangle turned `deg` degrees about its centre. */
export function rotatedBounds(w: number, h: number, deg: number): Box {
  const a = (Math.abs(deg) * Math.PI) / 180
  const c = Math.abs(Math.cos(a))
  const s = Math.abs(Math.sin(a))
  return { w: w * c + h * s, h: w * s + h * c }
}

/** Angles tried: as it lies, then rising to the right. */
const ANGLES = [0, -15, -20, -25, -30, -35, -40, -45, -50, -55, -60]
/** A turn has to show the item this much bigger to be worth it. */
const TURN_GAIN = 1.05

/** The largest thumbnail of `shape` (its portrait's aspect) inside `box` less `pad` on every side. */
export function fitThumb(shape: Box, box: Box, pad: number): Thumb {
  const inner = { w: Math.max(0, box.w - pad * 2), h: Math.max(0, box.h - pad * 2) }
  const scaleAt = (deg: number) => {
    const b = rotatedBounds(shape.w, shape.h, deg)
    return Math.min(inner.w / b.w, inner.h / b.h)
  }
  const flat = scaleAt(0)
  let best = { deg: 0, scale: flat }
  for (const deg of ANGLES) {
    const scale = scaleAt(deg)
    if (scale > best.scale) best = { deg, scale }
  }
  if (best.scale < flat * TURN_GAIN) best = { deg: 0, scale: flat }
  return { w: shape.w * best.scale, h: shape.h * best.scale, angle: best.deg }
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4

/**
 * An `<img>` of `item`'s portrait sized and turned as `t`, centred in its (relatively positioned) box. `unit` turns a
 * number into a CSS length, e.g. `(n) => `calc(var(--inv-cell) * ${n})``. Empty when the item has no portrait.
 */
export function thumbHtml(item: string, t: Thumb, unit: (n: number) => string, className: string): string {
  const url = PORTRAITS[item]
  if (!url) return ""
  const turn = t.angle ? ` rotate:${t.angle}deg;` : ""
  return `<img class="${className}" src="${url}" alt="" draggable="false" decoding="async" style="width:${unit(r4(t.w))};height:${unit(r4(t.h))};${turn}">`
}
