import { PISTOL_RELOAD_TIME } from "../../shared/combat"
import type { Survivor } from "../../shared/session"
import type { FeedbackActor } from "./actor-feedback"
import type { VitalsInput } from "./vitals"

/**
 * The fields a co-op snapshot carries for another survivor (see docs/outbreak-coop.md, "Wire format"). Ammo,
 * stamina, battery and channels are private to their owner, so the HUD never reads them for remote survivors.
 */
export type RemoteSurvivorView = Pick<
  Survivor,
  "x" | "y" | "aim" | "health" | "maxHealth" | "sprinting" | "exhausted" | "equippedItem" | "reloadRemaining" | "flashlightOn" | "flashlightOutput"
>

/** A survivor other than the local one, as the HUD needs it each frame. */
export type HudRemote = {
  /** Stable per seat, e.g. "seat:2". */
  id: string
  survivor: RemoteSurvivorView
  /** Ground height under the survivor plus any vault lift, in metres. */
  ground: number
  /** Inside the local survivor's line of sight; hidden survivors show nothing. */
  visible: boolean
}

/**
 * Turns a remote survivor's replicated flags into the shapes `ActorFeedback` and `ActorVitals` read. The snapshot
 * only says whether a reload is happening, so progress is timed locally from when the flag rose.
 */
export class RemoteAdapter {
  private reloadStart: number | null = null
  private readonly actor: FeedbackActor = {
    health: 100,
    equippedItem: "hands",
    magAmmo: 0,
    magCapacity: 0,
    reserveAmmo: 0,
    planks: 0,
    reloadRemaining: 0,
    shoveAnim: 0,
    channel: null,
    lootMessage: null,
    lootMessageUntil: 0,
    flashlightOn: false,
    battery: 1,
    batteryDepleted: false,
    exhausted: false,
    peekingWindowId: null,
    vault: null,
  }

  /** Estimated 0..1 reload progress, or null when not reloading. */
  reload: number | null = null

  update(s: RemoteSurvivorView, now: number): void {
    if (s.reloadRemaining > 0) {
      if (this.reloadStart === null) this.reloadStart = now
      this.reload = Math.min(0.98, (now - this.reloadStart) / PISTOL_RELOAD_TIME)
    } else {
      this.reloadStart = null
      this.reload = null
    }
  }

  feedback(s: RemoteSurvivorView): FeedbackActor {
    const a = this.actor
    a.health = s.health
    a.equippedItem = s.equippedItem
    a.reloadRemaining = this.reload === null ? 0 : PISTOL_RELOAD_TIME * (1 - this.reload)
    a.flashlightOn = s.flashlightOn
    a.exhausted = s.exhausted
    return a
  }

  vitals(s: RemoteSurvivorView): VitalsInput {
    return {
      health: s.health,
      maxHealth: s.maxHealth || 100,
      stamina: null,
      sprinting: s.sprinting,
      exhausted: s.exhausted,
      reload: this.reload,
      pistol: s.equippedItem === "pistol",
      magAmmo: null,
      reserveAmmo: null,
      flashlightOn: s.flashlightOn,
      battery: null,
      batteryDepleted: false,
      flashlightOutput: s.flashlightOutput,
    }
  }
}
