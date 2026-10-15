import { stepBody as sharedStep, type Body } from "@arcade/kit/sim/move"
import { ACCEL, PLAYER_RADIUS } from "../config"
import type { Rect } from "../geom"

export type { Body }

/** One tick of movement toward (mx, my) at up to `speed` (`@arcade/kit/sim/move`), shared by the server and client prediction. */
export function stepBody(b: Body, mx: number, my: number, speed: number, solids: readonly Rect[], dt: number): void {
  sharedStep(b, mx, my, speed, solids, dt, PLAYER_RADIUS, ACCEL)
}
