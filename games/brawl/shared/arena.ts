import type { Rect } from "@arcade/kit/sim/geom"
import type { PropKindDef } from "@arcade/kit/sim/props"
import type { Rng } from "@arcade/kit/sim/rng"

/** The stage: a raised square ring with ropes, a few pillars and low cover, and props to shove around. */
export const STAGE: Rect = [2, 2, 30, 22]
export const STAGE_SIZE = [32, 24] as const
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
  { rect: [8.4, 7.4, 9.6, 8.6], h: 2.2 },
  { rect: [22.4, 7.4, 23.6, 8.6], h: 2.2 },
  { rect: [8.4, 15.4, 9.6, 16.6], h: 2.2 },
  { rect: [22.4, 15.4, 23.6, 16.6], h: 2.2 },
  { rect: [14, 5.6, 18, 6.2], h: 0.9 },
  { rect: [14, 17.8, 18, 18.4], h: 0.9 },
]
export const SOLIDS: Rect[] = BLOCKS.map((b) => b.rect)

export const PROP_KINDS: Record<string, PropKindDef> = {
  crate: { hl: 0.45, hw: 0.45, height: 0.9, mass: 35, friction: 7, hp: 40 },
  barrel: { hl: 0.32, hw: 0.32, height: 1, mass: 30, friction: 5, hp: 14, explode: { radius: 2.7, impulse: 14 } },
  cart: { hl: 0.55, hw: 0.36, height: 1, mass: 22, friction: 2.2, hp: 0 },
  car: { hl: 1.9, hw: 0.88, height: 1.35, mass: 900, friction: 6, hp: 0, heavy: true },
}

export const SPAWNS = [
  { x: 6, y: 5.5 }, { x: 26, y: 18.5 }, { x: 26, y: 5.5 }, { x: 6, y: 18.5 },
  { x: 16, y: 4 }, { x: 16, y: 20 }, { x: 4.5, y: 12 }, { x: 27.5, y: 12 },
]

/** Where props start each round, jittered by the round's seed. */
export function propLayout(rng: Rng): { kind: string; x: number; y: number; h: number }[] {
  const j = () => (rng.next() - 0.5) * 0.6
  return [
    { kind: "car", x: 16 + j(), y: 12 + j(), h: 0.15 + j() * 0.3 },
    { kind: "crate", x: 11 + j(), y: 10 + j(), h: j() },
    { kind: "crate", x: 11.9 + j(), y: 10.4 + j(), h: j() },
    { kind: "crate", x: 21 + j(), y: 14 + j(), h: j() },
    { kind: "crate", x: 20.1 + j(), y: 13.6 + j(), h: j() },
    { kind: "crate", x: 5 + j(), y: 9 + j(), h: j() },
    { kind: "crate", x: 27 + j(), y: 15 + j(), h: j() },
    { kind: "barrel", x: 12 + j(), y: 15 + j(), h: 0 },
    { kind: "barrel", x: 20 + j(), y: 9 + j(), h: 0 },
    { kind: "barrel", x: 4 + j(), y: 15.5 + j(), h: 0 },
    { kind: "barrel", x: 28 + j(), y: 8.5 + j(), h: 0 },
    { kind: "cart", x: 7 + j(), y: 12 + j(), h: 1.4 + j() },
    { kind: "cart", x: 25 + j(), y: 12 + j(), h: -1.6 + j() },
  ]
}

export const onStage = (x: number, y: number, pad = 0) => x >= STAGE[0] - pad && x <= STAGE[2] + pad && y >= STAGE[1] - pad && y <= STAGE[3] + pad
