/**
 * The blocky 5×7 on-screen-display font of an '80s camcorder (date/time stamp, PLAY), and the stamp text itself.
 * Pure: no DOM, so the layout and glyph coverage are testable; `CameraFilter` paints it into its overlay texture.
 */
const ROWS: Record<string, string> = {
  "0": ".###.#...##..###.#.###..##...#.###.",
  "1": "..#...##....#....#....#....#...###.",
  "2": ".###.#...#....#...#...#...#...#####",
  "3": "#####...#...#.....#.....##...#.###.",
  "4": "...#...##..#.#.#..#.#####...#....#.",
  "5": "######....####.....#....##...#.###.",
  "6": "..##..#...#....####.#...##...#.###.",
  "7": "#####....#...#...#...#....#....#...",
  "8": ".###.#...##...#.###.#...##...#.###.",
  "9": ".###.#...##...#.####....#...#..##..",
  A: ".###.#...##...#######...##...##...#",
  B: "####.#...##...#####.#...##...#####.",
  C: ".###.#...##....#....#....#...#.###.",
  D: "###..#..#.#...##...##...##..#.###..",
  E: "######....#....####.#....#....#####",
  F: "######....#....####.#....#....#....",
  G: ".###.#...##....#.####...##...#.####",
  J: "..###...#....#....#....#.#..#..##..",
  L: "#....#....#....#....#....#....#####",
  M: "#...###.###.#.##.#.##...##...##...#",
  N: "#...##...###..##.#.##..###...##...#",
  O: ".###.#...##...##...##...##...#.###.",
  P: "####.#...##...#####.#....#....#....",
  R: "####.#...##...#####.#.#..#..#.#...#",
  S: ".#####....#.....###.....#....#####.",
  T: "#####..#....#....#....#....#....#..",
  U: "#...##...##...##...##...##...#.###.",
  V: "#...##...##...##...##...#.#.#...#..",
  Y: "#...##...#.#.#...#....#....#....#..",
  ":": "......##...##........##...##.......",
  ".": "..........................##...##..",
  "-": "...............#####...............",
  "/": "....#...#....#...#...#....#...#....",
  "▶": "#....##...###..####.###..##...#....",
  " ": "...................................",
}

export const GLYPH_W = 5
export const GLYPH_H = 7
/** Columns from one glyph's left edge to the next (one blank column between glyphs). */
export const GLYPH_ADVANCE = 6

export function hasGlyph(ch: string): boolean {
  return ch in ROWS
}

/** Lit pixels of one glyph as [column, row] pairs; unknown characters draw nothing. */
export function glyphPixels(ch: string): [number, number][] {
  const rows = ROWS[ch]
  if (!rows) return []
  const out: [number, number][] = []
  for (let i = 0; i < rows.length; i++) if (rows[i] === "#") out.push([i % GLYPH_W, Math.floor(i / GLYPH_W)])
  return out
}

export function textWidth(text: string, scale: number): number {
  return text.length ? (([...text].length - 1) * GLYPH_ADVANCE + GLYPH_W) * scale : 0
}

/** Calls `rect` for every lit block of `text`, left edge at x, top at y, each font pixel `scale` units square. */
export function layoutText(text: string, x: number, y: number, scale: number, rect: (x: number, y: number, w: number, h: number) => void): void {
  let pen = x
  for (const ch of text) {
    for (const [cx, cy] of glyphPixels(ch)) rect(pen + cx * scale, y + cy * scale, scale, scale)
    pen += GLYPH_ADVANCE * scale
  }
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
const two = (n: number) => String(n).padStart(2, "0")

/** The camcorder stamp: "PM 11:47" over "OCT.21 1987". `year` 0 keeps the date's own year. */
export function vhsStamp(date: Date, year = 0): { time: string; date: string } {
  const h = date.getHours()
  return {
    time: `${h < 12 ? "AM" : "PM"} ${String(h % 12 || 12).padStart(2, " ")}:${two(date.getMinutes())}`,
    date: `${MONTHS[date.getMonth()]}.${two(date.getDate())} ${year > 0 ? year : date.getFullYear()}`,
  }
}

/** A phone recording timer: 00:01:23. */
export function phoneTimecode(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`
}

/** A body camera's burned-in lines: UTC time "2026-10-21 T23:47:12Z" and an unbranded unit id from the seed. */
export function bodycamStamp(date: Date, seed = 0): { time: string; unit: string } {
  const d = date
  const time = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}Z`
  const id = String(Math.abs(Math.imul(seed | 0, 2654435761)) % 100000).padStart(5, "0")
  return { time, unit: `BODY CAM X1  D${two(seed % 89 + 10)}-${id}` }
}
