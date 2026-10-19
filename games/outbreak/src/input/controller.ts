import type { Camera } from "@arcade/kit/client/camera"
import { Input } from "@arcade/kit/client/input"
import type { FrameClock } from "../../shared/clock"
import { HOLD_DURATION } from "../../shared/interact"
import { LocalSession, type Command } from "../../shared/session"
import type { BotsLabController } from "../bots-lab"
import { CRAFT_KEY } from "../crafting/settings"
import type { InventoryHud } from "../inventory-hud"
import { MAP_KEY, type OutbreakMap } from "../map/map"
import type { NetSession } from "../net-session"
import type { OutbreakSettings } from "../settings"
import { applyVehicleStunt } from "../vehicle-lab"

export interface OutbreakInputHost {
  readonly canvas: HTMLCanvasElement
  readonly session: () => LocalSession | NetSession
  readonly cam: Camera
  readonly settings: OutbreakSettings
  readonly inventoryHud: InventoryHud
  readonly map: OutbreakMap
  readonly botsLab: BotsLabController
  readonly incrementFrames: (count?: number) => void
}

/**
 * Translates keyboard, mouse, wheel, and tap-vs-hold (`KeyG`) input into fixed-tick `Command` substeps for
 * `session.update`, while routing HUD/map shortcuts (`Digit1`–`Digit9`, `Tab`, `Escape`, `KeyN`, `KeyC` recipes,
 * `KeyQ` ping).
 */
export class OutbreakInputController {
  readonly input: Input
  private pendingHotbarSlot: number | undefined
  private pendingHotbarDelta = 0
  private pendingFlashlightToggle = false
  private pendingBarricade = false
  private pendingVerbs: Partial<Command> = {}
  // KeyG is tap-or-hold: the tap fires on release, the hold once it has lasted HOLD_DURATION.
  private readonly holds = new Map<string, { at: number; fired: boolean }>()

  constructor(private readonly host: OutbreakInputHost) {
    const { canvas, inventoryHud, map } = host
    this.input = new Input(canvas, ["KeyE"])
    this.input.enabled = true
    // Ctrl is crouch: keep the browser's Ctrl shortcuts (save, bookmark, find) from firing while sneaking.
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null
      if (
        e.ctrlKey &&
        !e.metaKey &&
        /^(Key[A-Z]|Digit\d|Space)$/.test(e.code) &&
        !t?.closest?.("input, textarea, select, [contenteditable]")
      ) {
        e.preventDefault()
      }
    })
    this.input.mouse.y = innerHeight / 2 - 150
    this.input.onKey = (code) => {
      const session = this.host.session()
      const digit = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9"].indexOf(code)
      if (digit >= 0) {
        const meant = inventoryHud.digit(digit, session.view)
        if (meant.hotbarSlot !== undefined) {
          if (meant.hotbarSlot === 0 && session.view.inventory.selectedSlot === 0) this.pendingFlashlightToggle = true
          this.pendingHotbarSlot = meant.hotbarSlot
        } else if (meant.pick) this.pendingVerbs.pick = meant.pick
      }
      if (code === "KeyB") this.pendingBarricade = true
      if (code === "KeyE") {
        const prompt = session.view.prompt
        inventoryHud.noteUse(prompt)
        // The workbench's E opens its recipe board (the sim has nothing to do for it).
        if (prompt?.kind === "bench" && prompt.primary.id === "board") {
          if (inventoryHud.craftOpen) inventoryHud.close()
          else inventoryHud.openBench()
        }
      }
      // C is the recipe panel on foot; in a vehicle it changes seat (`Input.takeSeat`).
      if (code === CRAFT_KEY && !session.view.player.vehicleId) inventoryHud.toggleCraft()
      if (code === "KeyQ") this.pendingVerbs.ping = true
      if (code === "Tab") inventoryHud.togglePack()
      if (code === "Escape") inventoryHud.close()
      if (code === MAP_KEY) map.toggle()
      else if (code === "Escape") map.close()
      else map.key(code)
      if (code === "KeyG") this.holds.set(code, { at: performance.now(), fired: false })
    }
    this.input.onWheel = (delta) => {
      if (delta !== 0) this.pendingHotbarDelta += Math.sign(delta)
    }
  }

  liveMove(): { mx: number; my: number; sprint: boolean } {
    return { ...this.input.move(), sprint: this.input.sprinting }
  }

  release(): void {
    this.input.release()
  }

  private pollHolds(now: number): void {
    for (const [code, h] of this.holds) {
      const down = this.input.held(code)
      if (down && !h.fired && now - h.at >= HOLD_DURATION * 1000) {
        h.fired = true
        this.pendingVerbs.bundle = true
      } else if (!down) {
        if (!h.fired) this.pendingVerbs.drop = true
        this.holds.delete(code)
      }
    }
  }

  /** Steps all due fixed-tick simulation substeps for `wallNow` and returns the total stepped `dt` in seconds. */
  stepSubsteps(wallNow: number, clock: FrameClock): number {
    const substeps = clock.frame(
      wallNow,
      this.liveMove(),
      () => this.input.takeEnter(),
      () => {
        const f = this.input.takeSecondary() || this.pendingFlashlightToggle
        this.pendingFlashlightToggle = false
        return f
      },
      () => this.input.takeJump(),
      () => this.input.interactHeld,
    )
    if (!substeps.length) return 0
    const { cam, settings, botsLab } = this.host
    const session = this.host.session()
    const target = cam.unproject(this.input.mouse.x, this.input.mouse.y, innerWidth, innerHeight)
    const hotbarSlot = this.pendingHotbarSlot
    const hotbarDelta = this.pendingHotbarDelta
    const fireEdge = this.input.takeFirePress()
    const reloadEdge = this.input.takeReload()
    const meleeEdge = this.input.takeMelee()
    const seatEdge = this.input.takeSeat()
    const hornHeld = this.input.held("KeyH")
    const crouchHeld = this.input.enabled && (this.input.held("ControlLeft") || this.input.held("ControlRight"))
    const spaceHeld = Boolean(session.view.player.vehicleId) && this.input.held("Space")
    const barricadeEdge = this.pendingBarricade
    this.pollHolds(wallNow)
    const verbs = this.pendingVerbs
    this.pendingVerbs = {}
    this.pendingHotbarSlot = undefined
    this.pendingHotbarDelta = 0
    this.pendingBarricade = false
    let stepped = 0
    for (const [idx, step] of substeps.entries()) {
      const p = session.view.player
      const rawCommand: Command = {
        mx: step.mx,
        my: step.my,
        sprint: step.sprint || spaceHeld,
        aim: Math.atan2(target.y - p.y, target.x - p.x),
        interact: step.interact,
        flashlight: step.flashlight,
        jump: step.jump,
        interactHeld: step.interactHeld,
        fire: idx === 0 ? fireEdge : false,
        fireHeld: this.input.firing,
        reload: idx === 0 ? reloadEdge : false,
        melee: idx === 0 ? meleeEdge : false,
        barricade: idx === 0 ? barricadeEdge : false,
        ...(idx === 0 && seatEdge ? { seat: true } : {}),
        ...(hornHeld ? { horn: true } : {}),
        ...(crouchHeld ? { crouch: true } : {}),
        ...(idx === 0 ? verbs : {}),
        ...(idx === 0 && hotbarSlot !== undefined ? { hotbarSlot } : {}),
        ...(idx === 0 && hotbarDelta !== 0 ? { hotbarDelta } : {}),
      }
      const effectiveCommand = applyVehicleStunt(
        step.dt,
        session instanceof LocalSession ? botsLab.stepBeforeSessionUpdate(step.dt, session, rawCommand) : rawCommand,
      )
      session.update(step.dt, effectiveCommand, settings.dayCycle.timeScale, settings)
      stepped += step.dt
      this.host.incrementFrames(1)
    }
    return stepped
  }
}
