import type { Camera } from "@arcade/kit/client/camera"
import { Input } from "@arcade/kit/client/input"
import type { FrameClock } from "../../shared/clock"
import { HOLD_DURATION } from "../../shared/interact"
import { LocalSession, type Command } from "../../shared/session"
import type { BotsLabController } from "../bots-lab"
import { CROUCH_CTRL, crouchCodes, mapCodes, type ControlSettings } from "../controls/settings"
import { CRAFT_KEY } from "../crafting/settings"
import type { InventoryHud } from "../inventory-hud"
import { inventoryPresenter } from "../inventory/hooks"
import { BOARD_UP } from "../prompt-clarity/board"
import type { OutbreakMap } from "../map/map"
import type { NetSession } from "../net-session"
import { INTERACT_MENU_RADIAL, type RadialSettings } from "../radial/settings"
import { radialInteract, radialOptions } from "../radial/state"
import type { OutbreakSettings } from "../settings"
import { applyVehicleStunt } from "../vehicle-lab"

/** A hand slot's number picks it; pressing the number of the slot already in hand holsters to bare hands (slot 1). */
export function holsterToggle(slot: number, selected: number): number {
  return slot === selected && slot !== 0 ? 0 : slot
}

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
 * `session.update`, while routing HUD/map shortcuts (`Digit1`–`Digit9`, `Tab`, `Escape`, `KeyM` map, `KeyC`
 * recipes, `KeyQ` ping). Crouch and map keys follow Backquote › Controls (`controls/settings.ts`).
 */
export class OutbreakInputController {
  readonly input: Input
  private pendingHotbarSlot: number | undefined
  private pendingHotbarDelta = 0
  private pendingBarricade = false
  private pendingVerbs: Partial<Command> = {}
  /** E went down on a target with a radial: the input's tap edge is the radial's, not an interaction. */
  private swallowInteract = false
  // KeyG is tap-or-hold: the tap fires on release, the hold once it has lasted HOLD_DURATION.
  private readonly holds = new Map<string, { at: number; fired: boolean }>()

  constructor(private readonly host: OutbreakInputHost) {
    const { canvas, inventoryHud, map, cam } = host
    this.input = new Input(canvas, ["KeyE"])
    this.input.enabled = true
    // With Today's Ctrl crouch, keep the browser's Ctrl shortcuts (save, bookmark, find) from firing while sneaking.
    // Ctrl+W, Ctrl+T and Ctrl+N never reach the page, which is why crouch moved to Z.
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null
      if (
        this.keys().crouchKey === CROUCH_CTRL &&
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
      // The open radial takes its numbers and Esc.
      if (radialInteract.isOpen && (digit >= 0 || code === "Escape")) {
        if (code === "Escape") radialInteract.cancel()
        else this.sendRadial(radialInteract.choose(digit))
        return
      }
      // Shift+E is the target's alternative, as Today: no radial for it.
      if (code === "KeyE" && this.radialOn() && !this.input.sprinting) {
        const p = session.view.player
        const target = cam.unproject(this.input.mouse.x, this.input.mouse.y, innerWidth, innerHeight)
        const options = p.vehicleId ? [] : radialOptions(session.view, session.view.prompt)
        const aim = Math.atan2(target.y - p.y, target.x - p.x)
        if (radialInteract.press(performance.now(), options, session.view.prompt?.id ?? "", this.input.mouse, aim)) {
          this.swallowInteract = true
          return
        }
      }
      if (digit >= 0) {
        const meant = inventoryHud.digit(digit, session.view)
        if (meant.hotbarSlot !== undefined) this.pendingHotbarSlot = holsterToggle(meant.hotbarSlot, session.view.inventory.selectedSlot)
        else if (meant.pick) this.pendingVerbs.pick = meant.pick
      }
      if (code === "KeyB") {
        this.pendingBarricade = true
        const prompt = session.view.prompt
        if (prompt && (prompt.kind === "door" || prompt.kind === "window")) inventoryHud.noteAction(prompt.kind, BOARD_UP)
      }
      if (code === "KeyE") {
        const prompt = session.view.prompt
        inventoryHud.noteUse(prompt, this.input.held("ShiftLeft") || this.input.held("ShiftRight"))
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
      if (mapCodes(this.keys()).includes(code)) map.toggle()
      else if (code === "Escape") map.close()
      else map.key(code)
      // The open bag (AR-94) takes G for what the cursor is over, before G's drop-held and bundle.
      if (inventoryPresenter()?.key(code, session.view)) return
      if (code === "KeyG") this.holds.set(code, { at: performance.now(), fired: false })
    }
    this.input.onWheel = (delta) => {
      if (delta !== 0) this.pendingHotbarDelta += Math.sign(delta)
    }
    window.addEventListener("blur", () => this.release())
    window.addEventListener("outbreak-menu-open", () => this.release())
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.release()
    })
    window.addEventListener("keyup", (e) => {
      if (e.code === "MetaLeft" || e.code === "MetaRight") this.release()
    })
  }

  private keys(): ControlSettings {
    return this.host.settings.hud as unknown as ControlSettings
  }

  private radialOn(): boolean {
    return (this.host.settings.hud as unknown as RadialSettings).interactMenu === INTERACT_MENU_RADIAL
  }

  /** A radial choice becomes this tick's interaction, with the HUD's notes and the workbench's recipe board as E does. */
  private sendRadial(send: Partial<Command> | null): void {
    if (!send) return
    const { inventoryHud } = this.host
    const prompt = this.host.session().view.prompt
    if (send.interactAction === "barricade") {
      this.pendingBarricade = true
      if (prompt && (prompt.kind === "door" || prompt.kind === "window")) inventoryHud.noteAction(prompt.kind, BOARD_UP)
      return
    }
    inventoryHud.noteUse(prompt, send.interactAction !== undefined && send.interactAction === prompt?.alt?.id)
    if (prompt?.kind === "bench" && (send.interactAction ?? prompt.primary.id) === "board" && prompt.primary.id === "board") {
      if (inventoryHud.craftOpen) inventoryHud.close()
      else inventoryHud.openBench()
    }
    Object.assign(this.pendingVerbs, send)
  }

  liveMove(): { mx: number; my: number; sprint: boolean } {
    return { ...this.input.move(), sprint: this.input.sprinting }
  }

  release(): void {
    this.input.release()
    this.holds.clear()
    this.pendingVerbs = {}
    this.pendingHotbarSlot = undefined
    this.pendingHotbarDelta = 0
    this.pendingBarricade = false
    this.swallowInteract = false
    radialInteract.reset()
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
    if (radialInteract.busy && !this.radialOn()) radialInteract.reset()
    // The release that closes the radial resets it below; this tick's aim and trigger still belong to it.
    const wasBusy = radialInteract.busy
    this.sendRadial(
      radialInteract.frame(
        wallNow,
        this.input.interactHeld,
        this.input.mouse,
        this.host.session().view.prompt?.id,
        (this.host.settings.hud as unknown as RadialSettings).radialDelay,
      ),
    )
    const substeps = clock.frame(
      wallNow,
      this.liveMove(),
      () => {
        const edge = this.input.takeEnter()
        if (!this.swallowInteract) return edge
        this.swallowInteract = false
        return false
      },
      () => this.input.takeSecondary(),
      () => this.input.takeJump(),
      () => this.input.interactHeld && !radialInteract.busy,
    )
    if (!substeps.length) return 0
    const { cam, settings, botsLab } = this.host
    const session = this.host.session()
    const target = cam.unproject(this.input.mouse.x, this.input.mouse.y, innerWidth, innerHeight)
    const hotbarSlot = this.pendingHotbarSlot
    const hotbarDelta = this.pendingHotbarDelta
    let fireEdge = this.input.takeFirePress()
    // While the radial is up a click picks the wedge under the cursor, the aim holds and nothing fires.
    const radialBusy = wasBusy || radialInteract.busy
    if (radialBusy && fireEdge) {
      if (radialInteract.isOpen) this.sendRadial(radialInteract.choose(radialInteract.hover))
      fireEdge = false
      // The click was a pick: holding the button on afterwards must not start firing.
      this.input.firing = false
    }
    const reloadEdge = this.input.takeReload()
    const meleeEdge = this.input.takeMelee()
    const seatEdge = this.input.takeSeat()
    const hornHeld = this.input.held("KeyH")
    const crouchHeld = this.input.enabled && crouchCodes(this.keys()).some((code) => this.input.held(code))
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
        aim: radialBusy ? radialInteract.aim : Math.atan2(target.y - p.y, target.x - p.x),
        interact: step.interact,
        flashlight: step.flashlight,
        jump: step.jump,
        interactHeld: step.interactHeld,
        fire: idx === 0 ? fireEdge : false,
        fireHeld: this.input.firing && !radialBusy,
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
      const shaped = inventoryPresenter()?.shape(rawCommand, idx === 0) ?? rawCommand
      const effectiveCommand = applyVehicleStunt(
        step.dt,
        session instanceof LocalSession ? botsLab.stepBeforeSessionUpdate(step.dt, session, shaped) : shaped,
      )
      session.update(step.dt, effectiveCommand, settings.dayCycle.timeScale, settings)
      stepped += step.dt
      this.host.incrementFrames(1)
    }
    return stepped
  }
}
