/**
 * Item silhouettes for the inventory styles (AR-94): filled shapes in `currentColor` on a grid of 24-unit cells, each
 * drawn to its footprint (cells across × down), so the Attaché Case can lay them on its grid and the Ground Pack can
 * lay them on the mat at their real proportions. Hand-built from rects, circles and polygons, like the action glyphs.
 */

export type Footprint = { w: number; h: number }

const U = 24

type Shape = string

const rect = (x: number, y: number, w: number, h: number, r = 0): Shape =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}"${r ? ` rx="${r}"` : ""}/>`
const circle = (cx: number, cy: number, r: number): Shape => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`
const poly = (...pts: number[]): Shape => {
  const out: string[] = []
  for (let i = 0; i < pts.length; i += 2) out.push(`${pts[i]},${pts[i + 1]}`)
  return `<polygon points="${out.join(" ")}"/>`
}
/** A cut-out, drawn in the background colour (`--inv-cut`). */
const cut = (s: Shape): Shape => s.replace("/>", ' class="cut"/>')

type Icon = { fp: Footprint; shapes: Shape[] }

/** A long tool: handle on the left, head on the right, on a footprint `w` cells long. */
function longTool(w: number, head: Shape[], grip = 0.38): Icon {
  const L = w * U
  return { fp: { w, h: 1 }, shapes: [rect(3, 10, L * grip, 5, 2.5), rect(3 + L * grip - 2, 10.5, L - L * grip - 10, 4, 1), ...head] }
}

const ICONS: Record<string, Icon> = {
  flashlight: { fp: { w: 2, h: 1 }, shapes: [rect(4, 8, 26, 8, 3), poly(30, 7, 40, 4, 40, 20, 30, 17), rect(41, 4, 4, 16, 1.5), cut(rect(14, 10, 6, 4, 1))] },
  pistol: {
    fp: { w: 2, h: 2 },
    shapes: [rect(4, 10, 40, 10, 2), rect(40, 12, 5, 4, 1), poly(8, 20, 22, 20, 24, 40, 12, 42, 9, 38), rect(22, 20, 8, 3), cut(rect(23, 23, 6, 6, 3))],
  },
  knife: { fp: { w: 2, h: 1 }, shapes: [rect(3, 9, 15, 7, 3), rect(17, 7, 3, 11, 1), poly(20, 8, 44, 10, 46, 13, 20, 16)] },
  hammer: longTool(2, [rect(36, 4, 7, 16, 1.5), poly(43, 6, 47, 3, 47, 9, 43, 11)], 0.5),
  pipe: { fp: { w: 3, h: 1 }, shapes: [rect(3, 9, 66, 6, 3), rect(2, 7, 7, 10, 2), rect(63, 7, 7, 10, 2)] },
  crowbar: { fp: { w: 3, h: 1 }, shapes: [rect(8, 10, 58, 4, 2), poly(66, 10, 70, 6, 70, 3, 66, 4, 62, 10), poly(8, 10, 2, 16, 4, 18, 9, 14)] },
  machete: { fp: { w: 3, h: 1 }, shapes: [rect(3, 9, 18, 7, 3), rect(20, 7, 3, 11, 1), poly(23, 8, 64, 6, 70, 9, 66, 15, 23, 16)] },
  bat: { fp: { w: 4, h: 1 }, shapes: [rect(2, 10, 6, 5, 2), poly(8, 10.5, 40, 9, 92, 6, 94, 12, 92, 18, 40, 15, 8, 14.5)] },
  "spiked-board": {
    fp: { w: 4, h: 1 },
    shapes: [rect(3, 8, 90, 9, 1), poly(40, 8, 42, 2, 44, 8), poly(56, 8, 58, 1, 60, 8), poly(72, 8, 74, 2, 76, 8), poly(86, 8, 88, 3, 90, 8), poly(64, 17, 66, 22, 68, 17)],
  },
  axe: longTool(3, [poly(56, 3, 66, 3, 70, 1, 70, 21, 66, 19, 56, 17)], 0.6),
  "fire-axe": longTool(4, [poly(76, 2, 86, 2, 92, 0, 92, 22, 86, 20, 76, 20), poly(70, 8, 64, 4, 64, 18, 70, 14)], 0.62),
  medkit: { fp: { w: 2, h: 2 }, shapes: [rect(4, 10, 40, 32, 4), rect(17, 5, 14, 7, 2), cut(rect(21, 17, 6, 18, 1)), cut(rect(15, 23, 18, 6, 1))] },
  fists: { fp: { w: 1, h: 1 }, shapes: [rect(4, 7, 16, 12, 4), rect(4, 4, 4, 6, 2), rect(8.5, 3, 4, 6, 2), rect(13, 3.5, 4, 6, 2), poly(3, 13, 0, 10, 2, 8, 6, 11)] },
  baseball: { fp: { w: 1, h: 1 }, shapes: [circle(12, 12, 9), cut(rect(6, 6, 1.5, 12, 0.75)), cut(rect(16.5, 6, 1.5, 12, 0.75))] },
  brick: { fp: { w: 2, h: 1 }, shapes: [poly(4, 8, 40, 6, 44, 9, 44, 18, 8, 20, 4, 17), cut(circle(16, 13, 2)), cut(circle(30, 12, 2))] },
  rock: { fp: { w: 1, h: 1 }, shapes: [poly(3, 15, 6, 7, 13, 4, 20, 8, 21, 16, 15, 20, 7, 20)] },
  "tin-can": { fp: { w: 1, h: 1 }, shapes: [rect(6, 4, 12, 17, 2), cut(rect(6, 9, 12, 1.5)), cut(rect(6, 15, 12, 1.5))] },
  bandage: { fp: { w: 1, h: 1 }, shapes: [circle(12, 12, 9), cut(circle(12, 12, 3.5)), poly(19, 15, 23, 22, 15, 20)] },
  noisemaker: { fp: { w: 1, h: 1 }, shapes: [rect(5, 6, 14, 14, 3), rect(9, 2, 6, 5, 1), cut(circle(12, 13, 3))] },
  bottle: { fp: { w: 1, h: 2 }, shapes: [rect(9, 3, 6, 10, 1.5), poly(9, 13, 15, 13, 20, 20, 20, 44, 4, 44, 4, 20)] },
  molotov: { fp: { w: 1, h: 2 }, shapes: [poly(9, 9, 15, 9, 20, 18, 20, 44, 4, 44, 4, 18), poly(10, 9, 8, 2, 13, 5, 16, 1, 15, 9), cut(rect(7, 26, 10, 7, 1))] },
  cans: { fp: { w: 2, h: 1 }, shapes: [rect(4, 6, 12, 15, 2), rect(19, 6, 12, 15, 2), rect(34, 6, 12, 15, 2), rect(2, 4, 46, 2, 1)] },
  flare: { fp: { w: 2, h: 1 }, shapes: [rect(4, 8, 34, 9, 4), rect(37, 9, 7, 7, 1.5), poly(44, 10, 47, 12, 44, 15)] },
  food: { fp: { w: 1, h: 1 }, shapes: [rect(4, 5, 16, 16, 3), cut(rect(4, 10, 16, 6))] },
  flamethrower: {
    fp: { w: 4, h: 2 },
    shapes: [rect(6, 6, 22, 34, 6), rect(28, 14, 50, 7, 2), rect(76, 12, 18, 11, 2), poly(40, 21, 50, 21, 46, 34, 38, 34), rect(14, 2, 6, 5, 1)],
  },
  dynamite: { fp: { w: 1, h: 2 }, shapes: [rect(3, 10, 8, 34, 2), rect(13, 10, 8, 34, 2), rect(2, 22, 20, 4), poly(12, 10, 13, 2, 17, 4)] },
  firecrackers: { fp: { w: 1, h: 1 }, shapes: [rect(3, 6, 5, 16, 2), rect(9.5, 6, 5, 16, 2), rect(16, 6, 5, 16, 2), rect(2, 10, 20, 3)] },
  "flare-gun": { fp: { w: 2, h: 2 }, shapes: [rect(6, 10, 26, 13, 4), rect(30, 12, 14, 9, 2), poly(10, 23, 22, 23, 22, 42, 10, 42), cut(circle(37, 16.5, 2.5))] },
  "bear-trap": { fp: { w: 2, h: 2 }, shapes: [circle(24, 24, 18), cut(circle(24, 24, 13)), poly(11, 24, 15, 20, 17, 24, 21, 20, 23, 24, 27, 20, 29, 24, 33, 20, 37, 24), rect(22, 22, 4, 4)] },
  ammo: { fp: { w: 1, h: 1 }, shapes: [rect(4, 9, 5, 12, 1), poly(4, 9, 6.5, 3, 9, 9), rect(9.5, 9, 5, 12, 1), poly(9.5, 9, 12, 3, 14.5, 9), rect(15, 9, 5, 12, 1), poly(15, 9, 17.5, 3, 20, 9)] },
  plank: { fp: { w: 4, h: 1 }, shapes: [rect(2, 7, 92, 10, 1), cut(rect(20, 10, 18, 1.5)), cut(rect(56, 13, 22, 1.5))] },
  scrap: { fp: { w: 1, h: 1 }, shapes: [poly(3, 15, 10, 4, 16, 9, 21, 6, 20, 18, 9, 21), cut(circle(12, 13, 2.5))] },
  chem: { fp: { w: 1, h: 1 }, shapes: [rect(9, 2, 6, 5, 1), poly(8, 7, 16, 7, 20, 13, 20, 22, 4, 22, 4, 13)] },
  battery: { fp: { w: 1, h: 1 }, shapes: [rect(6, 5, 12, 17, 2), rect(9.5, 2, 5, 4, 1), cut(rect(9, 11, 6, 2)), cut(rect(11, 9, 2, 6))] },
  key: { fp: { w: 1, h: 1 }, shapes: [circle(7, 12, 5), cut(circle(7, 12, 2)), rect(11, 10.5, 11, 3), rect(17, 13, 2.5, 4), rect(20, 13, 2, 3)] },
  fuel: { fp: { w: 2, h: 2 }, shapes: [poly(6, 12, 14, 6, 42, 6, 42, 44, 6, 44), rect(10, 1, 9, 6, 1.5), cut(poly(17, 16, 35, 34, 31, 37, 13, 19))] },
  toolbox: { fp: { w: 3, h: 2 }, shapes: [rect(4, 16, 64, 28, 3), rect(26, 6, 20, 4, 2), rect(26, 6, 4, 11), rect(42, 6, 4, 11), cut(rect(4, 26, 64, 2))] },
  "car-battery": { fp: { w: 2, h: 2 }, shapes: [rect(4, 12, 40, 32, 3), rect(9, 6, 8, 7, 1), rect(31, 6, 8, 7, 1), cut(rect(10, 22, 6, 2)), cut(rect(32, 22, 6, 2)), cut(rect(34, 20, 2, 6))] },
  "pressure-tank": { fp: { w: 2, h: 2 }, shapes: [rect(6, 10, 36, 32, 14), rect(20, 3, 8, 8, 1), circle(24, 3, 3)] },
  "bolt-cutters": { fp: { w: 3, h: 1 }, shapes: [poly(2, 6, 40, 10, 40, 12, 2, 9), poly(2, 18, 40, 13, 40, 15, 2, 15), poly(40, 9, 70, 10, 70, 14, 40, 16)] },
}

const FALLBACK: Icon = { fp: { w: 1, h: 1 }, shapes: [rect(4, 4, 16, 16, 3)] }

/** Cells an item takes on a grid, long side across. */
export function footprint(item: string): Footprint {
  return (ICONS[item] ?? FALLBACK).fp
}

/** The item's silhouette as inline SVG at its footprint, optionally turned a quarter (long side down). */
export function itemIconSvg(item: string, opts: { rotate?: boolean; title?: string } = {}): string {
  const icon = ICONS[item] ?? FALLBACK
  const w = icon.fp.w * U
  const h = icon.fp.h * U
  const body = icon.shapes.join("")
  const title = opts.title ? `<title>${opts.title.replace(/[<&"]/g, "")}</title>` : ""
  if (!opts.rotate) return `<svg class="inv-icon" viewBox="0 0 ${w} ${h}" fill="currentColor" aria-hidden="${title ? "false" : "true"}">${title}${body}</svg>`
  return `<svg class="inv-icon" viewBox="0 0 ${h} ${w}" fill="currentColor" aria-hidden="${title ? "false" : "true"}">${title}<g transform="translate(${h} 0) rotate(90)">${body}</g></svg>`
}

/** Every item with a drawn silhouette (tests check the catalog against it). */
export const ICON_ITEMS: readonly string[] = Object.keys(ICONS)
