/** One tick of one archer's controls, packed into a byte: what's held. Presses and releases come from the change. */
export const BTN = { left: 1, right: 2, up: 4, down: 8, jump: 16, shoot: 32, dodge: 64 } as const
export type Buttons = number

/** Diagonal unit component, written out so every engine computes the same aim. */
export const DIAG = 0.7071067811865476

export const held = (b: Buttons, k: number) => (b & k) !== 0

/** The 8-way direction the buttons point (0, 0 when none), already unit length. */
export function dirOf(b: Buttons): [number, number] {
  const x = (held(b, BTN.right) ? 1 : 0) - (held(b, BTN.left) ? 1 : 0)
  const y = (held(b, BTN.up) ? 1 : 0) - (held(b, BTN.down) ? 1 : 0)
  return x && y ? [x * DIAG, y * DIAG] : [x, y]
}

/** Packs a stick or keys into buttons; `deadzone` applies to analog axes (y up). */
export function packButtons(x: number, y: number, jump: boolean, shoot: boolean, dodge: boolean, deadzone = 0.38): Buttons {
  let b = 0
  // 8-way with even sectors: an axis counts when it is past the deadzone and at least tan(22.5°) of the other.
  const ax = Math.abs(x), ay = Math.abs(y)
  const mag = Math.max(ax, ay)
  if (mag > deadzone) {
    if (ax >= ay * 0.4142) b |= x > 0 ? BTN.right : BTN.left
    if (ay >= ax * 0.4142) b |= y > 0 ? BTN.up : BTN.down
  }
  if (jump) b |= BTN.jump
  if (shoot) b |= BTN.shoot
  if (dodge) b |= BTN.dodge
  return b
}
