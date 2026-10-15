import type { Rect } from "@arcade/kit/sim/geom"
import type { PropKindDef } from "@arcade/kit/sim/props"
import type { Rng } from "@arcade/kit/sim/rng"

/** The stage: a raised square ring with ropes, a few pillars and low cover, and props to shove around. */
export const STAGE: Rect = [2, 2, 26, 19]
export const STAGE_SIZE = [28, 21] as const
export const CENTER = { x: (STAGE[0] + STAGE[2]) / 2, y: (STAGE[1] + STAGE[3]) / 2 }
export const ROPE_HEIGHT = 0.55

/** Ropes around the edge: walking fighters stop at them, launched ones fly over. */
export const ROPES: Rect[] = [
  [STAGE[0] - 0.2, STAGE[1] - 0.2, STAGE[2] + 0.2, STAGE[1]],
  [STAGE[0] - 0.2, STAGE[3], STAGE[2] + 0.2, STAGE[3] + 0.2],
  [STAGE[0] - 0.2, STAGE[1], STAGE[0], STAGE[3]],
  [STAGE[2], STAGE[1], STAGE[2] + 0.2, STAGE[3]],
]

/** Solid at any height: pillars and the low cover walls (height for shadows and drawing). */
export const BLOCKS: { rect: Rect; h: number }[] = [
  { rect: [7.4, 6.5, 8.6, 7.7], h: 2.2 },
  { rect: [19.4, 6.5, 20.6, 7.7], h: 2.2 },
  { rect: [7.4, 13.3, 8.6, 14.5], h: 2.2 },
  { rect: [19.4, 13.3, 20.6, 14.5], h: 2.2 },
  { rect: [12.3, 5, 15.7, 5.6], h: 0.9 },
  { rect: [12.3, 15.4, 15.7, 16], h: 0.9 },
]
export const SOLIDS: Rect[] = BLOCKS.map((b) => b.rect)

export const PROP_KINDS: Record<string, PropKindDef> = {
  crate: { hl: 0.45, hw: 0.45, height: 0.9, mass: 35, friction: 7, hp: 40 },
  barrel: { hl: 0.32, hw: 0.32, height: 1, mass: 30, friction: 5, hp: 14, explode: { radius: 2.7, impulse: 14 } },
  cart: { hl: 0.55, hw: 0.36, height: 1, mass: 22, friction: 2.2, hp: 0 },
  car: { hl: 1.9, hw: 0.88, height: 1.35, mass: 900, friction: 6, hp: 0, heavy: true },
}

export const SPAWNS = [
  { x: 6.5, y: 6.0 }, { x: 21.5, y: 15.0 }, { x: 21.5, y: 6.0 }, { x: 6.5, y: 15.0 },
  { x: 14, y: 5.2 }, { x: 14, y: 15.8 }, { x: 5.5, y: 10.5 }, { x: 22.5, y: 10.5 },
]

/** Where props start each round, jittered by the round's seed. */
export function propLayout(rng: Rng): { kind: string; x: number; y: number; h: number }[] {
  const j = () => (rng.next() - 0.5) * 0.6
  return [
    { kind: "car", x: 14 + j(), y: 10.5 + j(), h: 0.15 + j() * 0.3 },
    { kind: "crate", x: 9.7 + j(), y: 8.8 + j(), h: j() },
    { kind: "crate", x: 10.6 + j(), y: 9.2 + j(), h: j() },
    { kind: "crate", x: 18.3 + j(), y: 12.2 + j(), h: j() },
    { kind: "crate", x: 17.4 + j(), y: 11.8 + j(), h: j() },
    { kind: "crate", x: 4.6 + j(), y: 8 + j(), h: j() },
    { kind: "crate", x: 23.4 + j(), y: 13.1 + j(), h: j() },
    { kind: "barrel", x: 10.6 + j(), y: 13.1 + j(), h: 0 },
    { kind: "barrel", x: 17.4 + j(), y: 8 + j(), h: 0 },
    { kind: "barrel", x: 3.7 + j(), y: 13.5 + j(), h: 0 },
    { kind: "barrel", x: 24.3 + j(), y: 7.5 + j(), h: 0 },
    { kind: "cart", x: 6.3 + j(), y: 10.5 + j(), h: 1.4 + j() },
    { kind: "cart", x: 21.7 + j(), y: 10.5 + j(), h: -1.6 + j() },
  ]
}

export const onStage = (x: number, y: number, pad = 0) => x >= STAGE[0] - pad && x <= STAGE[2] + pad && y >= STAGE[1] - pad && y <= STAGE[3] + pad
