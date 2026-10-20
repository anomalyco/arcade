import type { Camera } from "@arcade/kit/client/camera"
import { keyLabel, onKeyLayoutChange } from "@arcade/kit/client/controls"
import { WEATHER_PRESETS } from "@arcade/kit/weather"
import { MELEE_WEAPONS } from "../../shared/combat"
import { clockText } from "../../shared/day-cycle"
import { LocalSession, type SessionView } from "../../shared/session"
import { supportHeight } from "../../shared/terrain"
import type { OutbreakVehicle } from "../../shared/vehicles"
import type { Vision } from "../../shared/vision"
import type { BotsLabController } from "../bots-lab"
import type { CoopView } from "../coop-view"
import { InventoryHud } from "../inventory-hud"
import { gameMapFrame } from "../map/game"
import { OutbreakMap } from "../map/map"
import { type NetSession, SURVIVOR_COLOURS } from "../net-session"
import type { OutbreakSettings } from "../settings"
import type { OutbreakVehicleRenderer } from "../vehicles"
import { OutbreakHud } from "./index"
import { giveTarget } from "../../shared/progression/give"

function safeLocalStorage(): Storage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

export interface OutbreakFrameUiUpdateContext {
  readonly dt: number
  readonly session: LocalSession | NetSession
  readonly coop: CoopView
  readonly vision: Vision
  readonly cam: Camera
  readonly w: number
  readonly h: number
  readonly playerGroundY: number
  readonly visChanged: boolean
  readonly windowMoved: boolean
  readonly localVehicle: OutbreakVehicle | undefined
  readonly vehicleRenderer: OutbreakVehicleRenderer
  readonly botsLab: BotsLabController
}

/**
 * Owns Outbreak's DOM status bar, stamina/battery meters, character HUD (`OutbreakHud`),
 * inventory HUD (`InventoryHud`), and map overlay (`OutbreakMap`), syncing them once per rendered frame.
 */
export class OutbreakFrameUi {
  readonly statusEl: HTMLElement
  readonly promptEl: HTMLElement | null
  private readonly staminaEl: HTMLElement | null
  private readonly staminaFill: HTMLElement | null
  private readonly batteryEl: HTMLElement | null
  private readonly batteryFill: HTMLElement | null
  readonly hud: OutbreakHud
  readonly map: OutbreakMap
  readonly inventoryHud: InventoryHud
  private lastNotice: { text: string; until: number } | null = null

  constructor(private readonly settings: OutbreakSettings) {
    this.statusEl = document.querySelector<HTMLElement>("#status")!
    this.promptEl = document.querySelector<HTMLElement>("#prompt")
    this.staminaEl = document.querySelector<HTMLElement>("#stamina")
    this.staminaFill = document.querySelector<HTMLElement>("#stamina-fill")
    this.batteryEl = document.querySelector<HTMLElement>("#battery")
    this.batteryFill = document.querySelector<HTMLElement>("#battery-fill")
    this.hud = new OutbreakHud(document.body, settings.hud)
    this.hud.avoid(this.promptEl)
    this.map = new OutbreakMap(document.body, settings.map, safeLocalStorage())
    this.inventoryHud = new InventoryHud(
      {
        prompt: this.promptEl,
        hotbar: document.querySelector<HTMLElement>("#hotbar"),
        belt: document.querySelector<HTMLElement>("#belt"),
        pack: document.querySelector<HTMLElement>("#pack"),
        craft: document.querySelector<HTMLElement>("#craft"),
        markers: document.querySelector<HTMLElement>("#markers"),
      },
      (index) => SURVIVOR_COLOURS[index % SURVIVOR_COLOURS.length]!.css,
      () => settings.discovery,
      settings.hud,
      () => settings.crafting,
    )
  }

  installKeyLayoutListener(session: () => LocalSession | NetSession, cam: Camera): void {
    onKeyLayoutChange(() => {
      const s = session()
      this.syncStatus(s.view)
      this.inventoryHud.sync(s.view, cam, innerWidth, innerHeight)
    })
  }

  reset(): void {
    this.hud.reset()
    this.map.reset()
  }

  private formatStatus(view: SessionView): string {
    const { player: p, hour, time, prompt, zombies } = view
    const primaryKey = keyLabel("KeyE")
    const reloadKey = keyLabel("KeyR")
    let promptText = ""
    if (p.channel) {
      const pct = Math.min(100, Math.round((p.channel.elapsed / Math.max(0.1, p.channel.duration)) * 100))
      promptText = ` · ${p.channel.label} (${pct}%)`
    } else if (prompt) {
      const second = prompt.secondary ? `  ·  Hold ${primaryKey} ${prompt.secondary.label}` : ""
      promptText = ` · ${primaryKey} ${prompt.primary.label}${second}`
    }
    const weaponText =
      p.reloadRemaining > 0
        ? ` · Reloading…`
        : p.equippedItem === "pistol"
          ? ` · 9mm ${p.magAmmo}/${p.magCapacity} (+${p.reserveAmmo}${p.magAmmo === 0 && p.reserveAmmo > 0 ? ` ${reloadKey}` : ""})`
          : p.meleeWeapon
            ? ` · ${MELEE_WEAPONS[p.meleeWeapon].shortLabel} ${p.meleeDurability}/${p.meleeMaxDurability}`
            : ""
    const plankText = p.planks > 0 ? ` · ${p.planks}🪵` : ""
    const alerted = zombies.filter((z) => z.state === "chase" || z.state === "alert" || z.state === "bash").length
    const alertText = alerted > 0 ? ` · ${alerted} pursuing` : ""
    const notice = view.notices.splice(0).at(-1)
    if (notice) this.lastNotice = { text: notice.text, until: time + 3 }
    const lootText =
      p.lootMessage && time < p.lootMessageUntil
        ? ` · ${p.lootMessage}`
        : this.lastNotice && time < this.lastNotice.until
          ? ` · ${this.lastNotice.text}`
          : ""
    const weatherText =
      this.settings.weather.weatherEnabled && this.settings.weather.weatherPreset !== "clear"
        ? ` · ${WEATHER_PRESETS[this.settings.weather.weatherPreset]?.label ?? this.settings.weather.weatherPreset}`
        : ""
    return `${clockText(hour)}${weatherText}${weaponText}${plankText}${p.exhausted ? " · Exhausted" : ""}${alertText}${promptText}${lootText}`
  }

  syncStatus(view: SessionView): void {
    if (this.hud.logMode) {
      this.statusEl.textContent = this.formatStatus(view)
    } else {
      const weather =
        this.settings.weather.weatherEnabled && this.settings.weather.weatherPreset !== "clear"
          ? (WEATHER_PRESETS[this.settings.weather.weatherPreset]?.label ?? this.settings.weather.weatherPreset)
          : ""
      const summary = this.hud.summary(view, weather)
      if (summary !== null) this.statusEl.textContent = summary
    }
  }

  updateFrame(ctx: OutbreakFrameUiUpdateContext): void {
    const {
      dt,
      session,
      coop,
      vision,
      cam,
      w,
      h,
      playerGroundY,
      visChanged,
      windowMoved,
      localVehicle,
      vehicleRenderer,
      botsLab,
    } = ctx
    const { player: p, town } = session.view
    this.hud.giveTo = giveToName(session, coop)
    this.hud.update(
      dt,
      session.view,
      cam,
      w,
      h,
      this.settings.flashlight.flashlightFlicker,
      coop.net?.id || "player",
      coop.hudRemotes(town, vision),
    )
    if (this.staminaEl && this.staminaFill) {
      const pct = Math.max(0, Math.min(100, p.stamina * 100))
      const width = `${pct.toFixed(1)}%`
      const active = String(p.sprinting || p.exhausted || p.stamina < 0.999)
      const exhausted = String(p.exhausted)
      if (this.staminaFill.style.width !== width) this.staminaFill.style.width = width
      if (this.staminaEl.dataset.active !== active) this.staminaEl.dataset.active = active
      if (this.staminaEl.dataset.exhausted !== exhausted) this.staminaEl.dataset.exhausted = exhausted
    }
    if (this.batteryEl && this.batteryFill) {
      const pct = Math.max(0, Math.min(100, p.battery * 100))
      const width = `${pct.toFixed(1)}%`
      const active = String(p.flashlightOn || p.batteryDepleted || p.battery < 0.999)
      const low = String(p.battery > 0 && p.battery < this.settings.flashlight.flashlightFlicker)
      const depleted = String(p.batteryDepleted)
      const opacity =
        p.flashlightOn && p.battery < this.settings.flashlight.flashlightFlicker
          ? String(0.45 + 0.5 * p.flashlightOutput)
          : ""
      if (this.batteryFill.style.width !== width) this.batteryFill.style.width = width
      if (this.batteryEl.dataset.active !== active) this.batteryEl.dataset.active = active
      if (this.batteryEl.dataset.low !== low) this.batteryEl.dataset.low = low
      if (this.batteryEl.dataset.depleted !== depleted) this.batteryEl.dataset.depleted = depleted
      if (this.batteryEl.style.opacity !== opacity) this.batteryEl.style.opacity = opacity
    }
    vehicleRenderer.syncHud(localVehicle, p.seatIndex ?? 0)
    this.syncStatus(session.view)
    coop.overlay(cam, w, h, town, vision, coop.pose(p))
    this.map.update(
      gameMapFrame({
        session,
        coop,
        vision,
        cam,
        w,
        h,
        ground: playerGroundY,
        visionChanged: visChanged,
        windowChanged: windowMoved,
      }),
    )
    this.inventoryHud.sync(session.view, cam, w, h)
    if (session instanceof LocalSession) {
      botsLab.renderOverlay(session, cam, (x, z) => supportHeight(town, x, z), w, h)
    }
  }
}

/** The teammate G would hand the held item (or the ammo bundle) to, by name, or nothing. */
function giveToName(session: LocalSession | NetSession, coop: CoopView): string | undefined {
  const me = "local" in session ? session.local : session.slot
  const held = session.view.inventory.slots[session.view.inventory.selectedSlot]
  const ledger = session.view.progression.ledger
  const bundle = ledger.count(session.view.actorId, "ammo") + ledger.count(session.view.actorId, "plank") > 0
  if ((!held || held.kind === "fists") && !bundle) return undefined
  const mate = giveTarget(me, session.sim.slots)
  if (!mate) return undefined
  return coop.net ? coop.net.nameOf(mate.index) : `Survivor ${mate.index + 1}`
}
