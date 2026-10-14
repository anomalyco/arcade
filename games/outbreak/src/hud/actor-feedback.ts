import type { NoiseEvent } from "../../shared/ai"
import { PISTOL_RELOAD_TIME, type CombatChannel } from "../../shared/combat"
import type { InteractTarget } from "../../shared/interact"
import type { InventoryState } from "../../shared/inventory"
import type { Town } from "../../shared/map"
import type { CalloutKind, CalloutOptions } from "./callouts"

/** The survivor fields feedback reads. Remote co-op players can pass their snapshot of the same shape. */
export type FeedbackActor = {
  health: number
  equippedItem: "pistol" | "hands"
  magAmmo: number
  magCapacity: number
  reserveAmmo: number
  planks: number
  reloadRemaining: number
  shoveAnim: number
  channel: CombatChannel | null
  lootMessage: string | null
  lootMessageUntil: number
  flashlightOn: boolean
  battery: number
  batteryDepleted: boolean
  exhausted: boolean
  peekingWindowId: string | null
  vault: { windowId: string } | null
}

export type FeedbackContext = {
  /** Session time in seconds; loot messages are keyed by it. */
  time: number
  town?: Town
  /** The actor's current interaction target, used to name door and window results. Local player only. */
  prompt?: InteractTarget | undefined
  inventory?: InventoryState
  noises?: readonly NoiseEvent[]
  /** Noise events from this source id count as the actor's own noise. */
  noiseSource?: string
  /** Zombies currently chasing or attacking this actor. */
  pursuing?: number
  /** Battery fraction below which the flashlight flickers. */
  lowBattery?: number
  /** Layout-aware label for the reload key. */
  reloadKey?: string
}

export type CalloutSink = (text: string, kind: CalloutKind, options?: CalloutOptions) => void

/** Noise radius (m) at or above which an action gets a noise callout. Walking, searching and shoves stay quiet. */
export const NOISE_CALLOUT_RADIUS = 9
/** Footsteps and sprinting are continuous; the player already knows they are running. */
const CONTINUOUS_NOISE = new Set(["footstep", "sprint"])

type PortalState = { id: string; kind: "door" | "window"; open: boolean; locked: boolean }

/**
 * Diffs one actor's state each frame and reports what changed as short callouts. It reads state only, so the shared
 * simulation stays unchanged and the same class works on network snapshots.
 */
export class ActorFeedback {
  private prev: FeedbackActor | null = null
  private prevSlot = -1
  private portal: PortalState | null = null
  private lastNoiseId = -1
  private prevPursuing = 0
  private hurt = 0
  private hurtAt = -Infinity

  constructor(private readonly emit: CalloutSink) {}

  reset(): void {
    this.prev = null
    this.prevSlot = -1
    this.portal = null
    this.lastNoiseId = -1
    this.prevPursuing = 0
    this.hurt = 0
  }

  observe(a: FeedbackActor, ctx: FeedbackContext): void {
    const p = this.prev
    const emit = this.emit
    if (!p) {
      this.prev = snapshot(a)
      this.prevSlot = ctx.inventory?.selectedSlot ?? -1
      this.portal = portalState(ctx)
      this.prevPursuing = ctx.pursuing ?? 0
      this.lastNoiseId = ctx.noises?.reduce((m, n) => Math.max(m, n.id), -1) ?? -1
      return
    }

    // Actions in progress: one keyed progress callout each, refreshed every frame until the action ends.
    if (a.reloadRemaining > 0) {
      emit("Reloading", "progress", { key: "reload", progress: 1 - a.reloadRemaining / PISTOL_RELOAD_TIME })
    } else if (p.reloadRemaining > 0 && a.magAmmo > p.magAmmo) {
      emit(`Reloaded ${a.magAmmo}/${a.magCapacity}`, "result", { key: "reload" })
    }
    if (a.channel) {
      emit(a.channel.label.replace(/…$/, ""), "progress", {
        key: "channel",
        progress: a.channel.elapsed / Math.max(0.01, a.channel.duration),
      })
    }

    const loot = a.lootMessage && a.lootMessageUntil !== p.lootMessageUntil ? a.lootMessage : null
    if (p.channel && !a.channel && !loot) emit("Stopped", "info", { key: "channel" })
    if (loot) {
      const callout = lootCallout(loot)
      // Item pops replace a successful search, so its ring fades out at once.
      if (!callout && p.channel) emit(p.channel.label.replace(/…$/, ""), "progress", { key: "channel", progress: 1, duration: 0 })
      if (callout) emit(callout.text, callout.kind, { key: p.channel ? "channel" : (callout.key ?? `loot:${callout.text}`) })
    }

    if (a.reserveAmmo > p.reserveAmmo) emit(`+${a.reserveAmmo - p.reserveAmmo} 9mm`, "result")
    const planks = a.planks - p.planks
    if (planks > 0) emit(`+${planks} plank${planks > 1 ? "s" : ""}`, "result")

    if (a.equippedItem === "pistol" && p.magAmmo > 0 && a.magAmmo === 0) {
      if (a.reserveAmmo > 0) emit(ctx.reloadKey ? `Empty, ${ctx.reloadKey} to reload` : "Empty", "warning", { key: "ammo" })
      else emit("Out of ammo", "warning", { key: "ammo" })
    }

    if (a.shoveAnim > p.shoveAnim + 1e-4) emit("Shove", "info")

    if (a.flashlightOn !== p.flashlightOn) emit(a.flashlightOn ? "Flashlight on" : "Flashlight off", "info", { key: "flashlight" })
    if (a.batteryDepleted && !p.batteryDepleted) emit("Battery dead", "warning", { key: "flashlight" })
    const low = ctx.lowBattery ?? 0
    if (a.flashlightOn && !a.batteryDepleted && a.battery < low && p.battery >= low) emit("Battery low", "warning", { key: "flashlight" })

    if (a.exhausted && !p.exhausted) emit("Exhausted", "warning", { key: "stamina" })
    else if (!a.exhausted && p.exhausted) emit("Breath back", "info", { key: "stamina" })

    if (a.vault && !p.vault) {
      const win = ctx.town?.windows.some((w) => w.id === a.vault!.windowId)
      emit(win ? "Climbing through" : "Vaulting", "info")
    }
    if (a.peekingWindowId && !p.peekingWindowId) emit("Peeking", "info", { key: "peek" })

    if (a.health < p.health) {
      if (ctx.time - this.hurtAt > 0.6) this.hurt = 0
      this.hurt += p.health - a.health
      this.hurtAt = ctx.time
      emit(`\u2212${Math.round(this.hurt)} HP`, "danger", { key: "hurt" })
    }

    const slot = ctx.inventory?.selectedSlot ?? -1
    if (ctx.inventory && slot !== this.prevSlot && this.prevSlot >= 0) {
      const item = ctx.inventory.slots[slot]
      emit(item ? item.label : `Slot ${slot + 1} empty`, "info", { key: "slot" })
    }
    this.prevSlot = slot

    // Door and window results, named from the target the actor was facing last frame.
    const watched = this.portal
    if (watched && ctx.town) {
      const now = lookupPortal(ctx.town, watched.id, watched.kind)
      if (now) {
        if (watched.kind === "door") {
          if (now.locked !== watched.locked) emit(now.locked ? "Door locked" : "Door unlocked", "result", { key: "portal" })
          else if (now.open !== watched.open) emit(now.open ? "Door opened" : "Door closed", "result", { key: "portal" })
        } else if (now.open !== watched.open) {
          emit(now.open ? "Window opened" : "Window closed", "result", { key: "portal" })
        }
      }
    }
    this.portal = portalState(ctx)

    if (ctx.noises && ctx.noiseSource !== undefined) {
      let loudest: NoiseEvent | null = null
      for (const n of ctx.noises) {
        if (n.id <= this.lastNoiseId) continue
        this.lastNoiseId = Math.max(this.lastNoiseId, n.id)
        if (n.sourceId !== ctx.noiseSource || n.radius < NOISE_CALLOUT_RADIUS || CONTINUOUS_NOISE.has(n.kind)) continue
        if (!loudest || n.radius > loudest.radius) loudest = n
      }
      if (loudest) emit(`Noise ${Math.round(loudest.radius)} m`, "noise", { key: "noise" })
    }

    const pursuing = ctx.pursuing ?? 0
    if (pursuing > this.prevPursuing) emit(pursuing > 1 ? `Spotted by ${pursuing}` : "Spotted", "danger", { key: "spotted" })
    this.prevPursuing = pursuing

    this.prev = snapshot(a)
  }
}

/** Maps the simulation's loot/status sentences to short callouts. "Found …" is skipped: item pops come from diffs. */
export function lootCallout(message: string): { text: string; kind: CalloutKind; key?: string } | null {
  let m: RegExpMatchArray | null
  if (message.startsWith("Found ")) return null
  if (/^Searched .*: empty$/.test(message)) return { text: "Nothing here", kind: "info" }
  if (message.startsWith("Out of 9mm")) return { text: "Out of ammo", kind: "warning", key: "ammo" }
  if (message.startsWith("Need wooden planks")) return { text: "No planks", kind: "warning" }
  if ((m = message.match(/^Barricaded \((\d)\/3/))) return { text: `Boarded ${m[1]}/3`, kind: "result" }
  if (message.startsWith("Already fully barricaded")) return { text: "Fully boarded", kind: "info" }
  if ((m = message.match(/^Blocked by barricade \((\d)\/3/))) return { text: `Boarded up ${m[1]}/3`, kind: "warning" }
  return { text: message, kind: "info" }
}

function snapshot(a: FeedbackActor): FeedbackActor {
  return {
    health: a.health,
    equippedItem: a.equippedItem,
    magAmmo: a.magAmmo,
    magCapacity: a.magCapacity,
    reserveAmmo: a.reserveAmmo,
    planks: a.planks,
    reloadRemaining: a.reloadRemaining,
    shoveAnim: a.shoveAnim,
    channel: a.channel,
    lootMessage: a.lootMessage,
    lootMessageUntil: a.lootMessageUntil,
    flashlightOn: a.flashlightOn,
    battery: a.battery,
    batteryDepleted: a.batteryDepleted,
    exhausted: a.exhausted,
    peekingWindowId: a.peekingWindowId,
    vault: a.vault,
  }
}

function lookupPortal(town: Town, id: string, kind: "door" | "window"): { open: boolean; locked: boolean } | null {
  if (kind === "door") {
    const d = town.doors.find((item) => item.id === id)
    return d ? { open: d.open, locked: Boolean(d.locked) } : null
  }
  const w = town.windows.find((item) => item.id === id)
  return w ? { open: w.open, locked: false } : null
}

function portalState(ctx: FeedbackContext): PortalState | null {
  const t = ctx.prompt
  if (!t || !ctx.town || (t.kind !== "door" && t.kind !== "window")) return null
  const kind = t.kind === "door" ? "door" : "window"
  const s = lookupPortal(ctx.town, t.id, kind)
  return s ? { id: t.id, kind, ...s } : null
}
