import type { ClueKind } from "../../shared/way-out/clues"
import type { DestinationKind } from "../../shared/way-out/plan"

/**
 * The Way Out's drawings (AR-64): drawings first, a few words under them, in the spirit of the found pages (D-19).
 * Pencil-and-ink SVG, stroke only, so they sit on the noir HUD like marks on paper.
 */

const svg = (body: string, w = 120, h = 84) =>
  `<svg class="owo-art" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

/** Each place in a few strokes: the boat, the barrier, the plane, the wall. */
const PLACE: Readonly<Record<DestinationKind, string>> = {
  ferry:
    '<path d="M14 52 L106 52 L96 66 L24 66 Z"/><path d="M34 52 V38 H82 V52"/><path d="M44 38 V30 H70 V38"/><path d="M60 30 V20 M60 20 l9 4"/><path d="M8 72 q8 -5 16 0 t16 0 t16 0 t16 0 t16 0 t16 0"/><circle cx="46" cy="45" r="2"/><circle cx="58" cy="45" r="2"/><circle cx="70" cy="45" r="2"/>',
  checkpoint:
    '<path d="M18 66 V30"/><path d="M14 66 H24"/><path d="M18 36 H104" stroke-width="4"/><path d="M34 36 v-4 M50 36 v-4 M66 36 v-4 M82 36 v-4 M98 36 v-4"/><path d="M18 30 L18 12 L34 17 L18 22"/><path d="M62 66 q4 -8 12 -8 q8 0 12 8 M78 66 q4 -8 12 -8 q8 0 12 8 M70 58 q4 -7 12 -7 q8 0 12 7"/>',
  airfield:
    '<path d="M60 12 V70"/><path d="M60 34 L14 48 L14 54 L60 46 L106 54 L106 48 Z"/><path d="M60 64 L44 72 M60 64 L76 72"/><path d="M10 78 H110" stroke-dasharray="6 6"/>',
  dam:
    '<path d="M10 22 Q60 34 110 22"/><path d="M14 22 L22 70 H98 L106 22"/><path d="M40 70 V40 M60 70 V42 M80 70 V40"/><path d="M8 16 q10 -4 20 0 t20 0 t20 0 t20 0 t20 0"/><path d="M50 78 q5 -4 10 0 t10 0"/>',
}

const RADIO =
  '<rect x="30" y="34" width="60" height="36" rx="5"/><circle cx="48" cy="52" r="9"/><path d="M66 46 H80 M66 52 H80 M66 58 H80"/><path d="M40 34 L56 14"/><path d="M84 20 q8 8 0 16 M92 14 q14 14 0 28"/>'

const ARROW = '<path d="M30 42 H86 M72 30 L88 42 L72 54"/>'

const X_MARK = (x: number, y: number) => `<path d="M${x - 6} ${y - 6} l12 12 M${x + 6} ${y - 6} l-12 12"/>`

/** A clue's drawing: the place itself for the rumours, the map, the sign and the orders for the direction. */
export function clueArt(kind: ClueKind | "signal" | "escaped" | "missed" | "left", place: DestinationKind, bearing = 0): string {
  switch (kind) {
    case "radio":
      return svg(RADIO)
    case "note":
      return svg(`<g transform="translate(6 4) scale(.9)" stroke-dasharray="1 0">${PLACE[place]}</g><path d="M10 78 q20 -6 40 -1 t40 0 t28 -3" stroke-width="1.6"/>`)
    case "flyer":
      return svg(`<rect x="22" y="6" width="76" height="74" rx="2" stroke-width="1.8"/><g transform="translate(29 14) scale(.52)">${PLACE[place]}</g><path d="M34 62 H86 M40 70 H80" stroke-width="3"/>`)
    case "police": {
      const dx = Math.cos(bearing) * 26
      const dy = Math.sin(bearing) * 18
      return svg(
        `<path d="M14 10 L104 8 L100 30 L108 52 L98 76 L18 78 L22 54 L12 34 Z" stroke-width="1.8"/><path d="M60 12 V74 M16 44 H104" stroke-width="1" stroke-dasharray="3 4"/><circle cx="60" cy="44" r="3"/><path d="M60 44 L${(60 + dx).toFixed(1)} ${(44 + dy).toFixed(1)}" stroke-width="3"/>${X_MARK(60 + dx * 1.18, 44 + dy * 1.18)}`,
      )
    }
    case "sign":
      return svg(`<path d="M60 80 V46"/><path d="M16 14 H96 L108 30 L96 46 H16 Z"/><g transform="translate(22 17) scale(.22)">${PLACE[place]}</g><path d="M62 30 H90 M82 24 L90 30 L82 36"/>`)
    case "soldier":
      return svg(`<rect x="18" y="8" width="62" height="70" rx="2" stroke-width="1.8"/><path d="M28 22 H70 M28 32 H64 M28 42 H70 M28 52 H58" stroke-width="1.6"/><path d="M86 30 q10 2 12 12 q-2 10 -12 12 q-8 -2 -8 -12 q0 -10 8 -12 Z"/><path d="M92 54 V74"/>`)
    case "arrive":
    case "signal":
      return svg(`<path d="M56 78 L60 40 L64 78"/><path d="M60 40 q-12 -12 -4 -26 q2 10 8 10 q6 -6 2 -16 q14 10 6 28 q-4 6 -12 4"/><path d="M28 30 l-8 -6 M92 30 l8 -6 M24 50 h-10 M96 50 h10"/>`)
    case "escaped":
      return svg(PLACE[place])
    case "missed":
    case "left":
      return svg(`${PLACE[place]}<path d="M14 14 L106 74" stroke-width="3"/>`)
  }
}

export const placeArt = (place: DestinationKind) => svg(PLACE[place])
