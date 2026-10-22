import { KeyStateTracker } from "@arcade/kit/client/controls"
import { BTN, type Buttons, packButtons } from "../../shared/input"

/**
 * Couch input. One keyboard player gets every binding (WASD or arrows, with J/K/L, Z/X/C or Space/Shift/E); a second
 * keyboard player splits it into a left cluster (WASD, Space jump, Shift shoot, E dodge) and a right cluster (IJKL,
 * M jump, Semicolon shoot, O dodge). Gamepads use the standard mapping: stick or d-pad, A jump, X/Y shoot, B or any
 * shoulder dodge.
 */
export type Device = "kb" | "kbL" | "kbR" | `pad${number}`

type KeySet = { left: string[]; right: string[]; up: string[]; down: string[]; jump: string[]; shoot: string[]; dodge: string[] }

const LEFT: KeySet = { left: ["KeyA"], right: ["KeyD"], up: ["KeyW"], down: ["KeyS"], jump: ["Space"], shoot: ["ShiftLeft"], dodge: ["KeyE"] }
const RIGHT: KeySet = { left: ["KeyJ"], right: ["KeyL"], up: ["KeyI"], down: ["KeyK"], jump: ["KeyM"], shoot: ["Semicolon"], dodge: ["KeyO"] }
const SOLO: KeySet = {
  left: ["KeyA", "ArrowLeft"], right: ["KeyD", "ArrowRight"], up: ["KeyW", "ArrowUp"], down: ["KeyS", "ArrowDown"],
  jump: ["Space", "KeyJ", "KeyZ"], shoot: ["ShiftLeft", "KeyK", "KeyX"], dodge: ["KeyE", "KeyL", "KeyC"],
}
export const KEYSETS: Record<"kb" | "kbL" | "kbR", KeySet> = { kb: SOLO, kbL: LEFT, kbR: RIGHT }

const PAD_JUMP = [0]
const PAD_SHOOT = [2, 3]
const PAD_DODGE = [1, 4, 5, 6, 7]

export class Controls {
  // Off (the title or menu up), Space and the arrows go to the page: Space presses a focused menu button.
  readonly keys = new KeyStateTracker({ shouldPreventDefault: (c) => this.enabled && (c.startsWith("Arrow") || c === "Space") })
  enabled = true

  /** Lets go of every held key (pausing mustn't leave a player running when play comes back). */
  release(): void {
    this.keys.release()
  }

  buttons(d: Device): Buttons {
    if (!this.enabled) return 0
    if (d.startsWith("pad")) return this.pad(Number(d.slice(3)))
    const k = KEYSETS[d as keyof typeof KEYSETS]
    const any = (codes: string[]) => this.keys.any(...codes)
    let b = 0
    if (any(k.left)) b |= BTN.left
    if (any(k.right)) b |= BTN.right
    if (any(k.up)) b |= BTN.up
    if (any(k.down)) b |= BTN.down
    if ((b & (BTN.left | BTN.right)) === (BTN.left | BTN.right)) b &= ~(BTN.left | BTN.right)
    if ((b & (BTN.up | BTN.down)) === (BTN.up | BTN.down)) b &= ~(BTN.up | BTN.down)
    if (any(k.jump)) b |= BTN.jump
    if (any(k.shoot)) b |= BTN.shoot
    if (any(k.dodge)) b |= BTN.dodge
    return b
  }

  private pad(i: number): Buttons {
    const p = navigator.getGamepads?.()[i]
    if (!p || !p.connected) return 0
    const on = (ids: number[]) => ids.some((j) => p.buttons[j]?.pressed)
    let x = p.axes[0] ?? 0, y = -(p.axes[1] ?? 0)
    if (p.buttons[14]?.pressed) x = -1
    if (p.buttons[15]?.pressed) x = 1
    if (p.buttons[12]?.pressed) y = 1
    if (p.buttons[13]?.pressed) y = -1
    return packButtons(x, y, on(PAD_JUMP), on(PAD_SHOOT), on(PAD_DODGE))
  }

  /** Gamepads whose A or Start went down this frame (to join). */
  padJoins(known: ReadonlySet<string>): Device[] {
    const out: Device[] = []
    for (const p of navigator.getGamepads?.() ?? []) {
      if (!p?.connected) continue
      const d: Device = `pad${p.index}`
      if (known.has(d)) continue
      if (p.buttons[0]?.pressed || p.buttons[9]?.pressed) out.push(d)
    }
    return out
  }

  pressed(...codes: string[]): boolean {
    return this.keys.pressed(...codes)
  }

  endFrame(): void {
    this.keys.clearDowns()
  }
}
