/**
 * Movement and combat numbers, in tiles (1 tile ≈ 0.75 m of archer) and seconds. The Lab binds these as knobs for
 * local play; rooms always use DEFAULT_TUNING so every peer simulates the same game.
 */
export type Tuning = {
  /** Run speed (tiles/s), ground and air acceleration and ground braking (tiles/s²). */
  runSpeed: number
  groundAccel: number
  groundBrake: number
  airAccel: number
  /** Gravity, the softer gravity near the apex while jump is held, and the fall speed caps. */
  gravity: number
  apexGravity: number
  apexBand: number
  maxFall: number
  fastFall: number
  /** Jump take-off speed; releasing early multiplies upward speed by jumpCut. */
  jumpSpeed: number
  jumpCut: number
  coyote: number
  jumpBuffer: number
  /** Wall slide cap, wall jump push and how long it overrides your steering. */
  wallSlide: number
  wallJumpX: number
  wallJumpY: number
  wallJumpLock: number
  /** How far below a ledge's lip your head can be and still catch it. */
  ledgeReach: number
  /** Dodge: speed, duration, cooldown after it ends, and the opening window that catches arrows. */
  dodgeSpeed: number
  dodgeTime: number
  dodgeCooldown: number
  catchWindow: number
  catchRadius: number
  /** Arrows: launch speed, gravity, and how hard they bend toward a target in front (rad/s). */
  arrowSpeed: number
  arrowGravity: number
  arrowHoming: number
  /** Stomp: the bounce off a head. */
  stompBounce: number
  /** Wings: flap speed and the glide fall cap. */
  flapSpeed: number
  glideFall: number
}

export const DEFAULT_TUNING: Readonly<Tuning> = Object.freeze({
  runSpeed: 7.2,
  groundAccel: 95,
  groundBrake: 120,
  airAccel: 55,
  gravity: 52,
  apexGravity: 30,
  apexBand: 3.5,
  maxFall: 15,
  fastFall: 22,
  jumpSpeed: 18.4,
  jumpCut: 0.45,
  coyote: 0.1,
  jumpBuffer: 0.11,
  wallSlide: 4,
  wallJumpX: 8.5,
  wallJumpY: 16.5,
  wallJumpLock: 0.14,
  ledgeReach: 0.5,
  dodgeSpeed: 17,
  dodgeTime: 0.2,
  dodgeCooldown: 0.32,
  catchWindow: 0.14,
  catchRadius: 0.95,
  arrowSpeed: 24,
  arrowGravity: 11,
  arrowHoming: 1.6,
  stompBounce: 14,
  flapSpeed: 11.5,
  glideFall: 5,
})

export const tuning = (over?: Partial<Tuning>): Tuning => ({ ...DEFAULT_TUNING, ...over })
