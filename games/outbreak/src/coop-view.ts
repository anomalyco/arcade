import type { Camera } from "@arcade/kit/client/camera"
import { LIGHT_FLOATS, MAX_LIGHTS } from "@arcade/kit/gpu/limits"
import type { Batch, Renderer } from "@arcade/kit/gpu/renderer"
import type { FlashlightTuning } from "../shared/flashlight"
import { flashlightColor } from "../shared/flashlight"
import type { Town } from "../shared/map"
import { supportHeight } from "../shared/terrain"
import type { Vision } from "../shared/vision"
import { CoopHud, playerName } from "./coop-hud"
import { NetSession, remoteLift, SURVIVOR_COLOURS } from "./net-session"
import { Survivor } from "./survivor"

type LightSettings = Pick<FlashlightTuning, "flashlightRange" | "flashlightCone" | "flashlightIntensity" | "flashlightWarmth"> & {
  practicalWarmth: number
}

/** Visibility of an actor to the local survivor: the fog/vision module's soft actor test when present. */
function actorVisibility(vision: Vision, x: number, y: number): number {
  const soft = (vision as Vision & { actorVisible?: (x: number, y: number) => number }).actorVisible
  return soft ? soft.call(vision, x, y) : vision.visible(x, y) ? 1 : 0
}

/**
 * Presentation of a co-op room in `main.ts`: the room session, the menu, remote survivors' bodies (only inside your
 * line of sight), their flashlights (always: they light your world too) and name tags.
 */
export class CoopView {
  readonly hud: CoopHud
  private avatars = new Map<number, Survivor>()

  constructor(
    private readonly renderer: Renderer,
    readonly net: NetSession | null,
    room: string | null,
  ) {
    this.hud = new CoopHud(net, room)
  }

  /** `?room=<code>` joins that room; anything else plays offline. */
  static fromUrl(renderer: Renderer, params: URLSearchParams): CoopView {
    const room = params.get("room")?.toLowerCase().replace(/[^a-z0-9]/g, "") || null
    if (!room) return new CoopView(renderer, null, null)
    const dir = location.pathname.replace(/[^/]*$/, "")
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${dir}ws/${room}`
    const net = new NetSession({
      url,
      room,
      name: playerName(params),
      storage: sessionStorage,
      onReload: () => {
        // Reload once into the same room; a second mismatch within a minute means the rollout is still under way.
        const last = Number(sessionStorage.getItem("outbreak.coop.reloadAt") ?? 0)
        if (Date.now() - last < 60_000) return
        sessionStorage.setItem("outbreak.coop.reloadAt", String(Date.now()))
        location.reload()
      },
    })
    return new CoopView(renderer, net, room)
  }

  /** Seat palette for the local survivor once the room has assigned a seat (index 0 is the offline look). */
  get localPalette(): { torso: number; legs: number } | null {
    if (!this.net?.id || this.net.index === 0) return null
    return SURVIVOR_COLOURS[this.net.index % SURVIVOR_COLOURS.length]!
  }

  /** The local survivor's drawn pose: predicted state plus the decaying reconciliation offset. */
  pose<P extends { x: number; y: number }>(p: P): P {
    const s = this.net?.smoother
    return s && (s.x || s.y) ? { ...p, x: p.x + s.x, y: p.y + s.y } : p
  }

  /** Packs remote flashlights after the local one. Returns the new light count. */
  flashlights(lights: Float32Array, count: number, town: Town, settings: LightSettings, occluders: number): number {
    if (!this.net) return count
    const rgb = flashlightColor(settings.flashlightWarmth)
    const cosHalf = Math.cos((settings.flashlightCone * Math.PI) / 360)
    const directScale = settings.practicalWarmth > 0.6 ? 0.28 : 1.0
    for (const slot of this.net.remotes) {
      const p = slot.survivor
      if (count >= MAX_LIGHTS - 2 || p.flashlightOutput <= 0.001 || !p.flashlightOn) continue
      const inside = town.buildings.some((b) => p.x > b.rect[0] - 0.1 && p.x < b.rect[2] + 0.1 && p.y > b.rect[1] - 0.1 && p.y < b.rect[3] + 0.1)
      const power = p.flashlightOutput * settings.flashlightIntensity * directScale
      const range = Math.min(settings.flashlightRange, inside ? 5.2 : 6.4)
      const ground = supportHeight(town, p.x, p.y)
      lights.set(
        [p.x + Math.cos(p.aim) * 0.25, 1.18 + ground, p.y + Math.sin(p.aim) * 0.25, range, rgb[0], rgb[1], rgb[2], power, Math.cos(p.aim), Math.sin(p.aim), cosHalf, 1, 0, occluders, 0.06, -1],
        count++ * LIGHT_FLOATS,
      )
    }
    return count
  }

  /** Bodies of remote survivors you can see. */
  bodies(dt: number, time: number, town: Town, vision: Vision): Batch[] {
    if (!this.net) return []
    const out: Batch[] = []
    const live = new Set<number>()
    for (const slot of this.net.remotes) {
      live.add(slot.index)
      let avatar = this.avatars.get(slot.index)
      if (!avatar) {
        avatar = new Survivor(this.renderer, SURVIVOR_COLOURS[slot.index % SURVIVOR_COLOURS.length]!)
        this.avatars.set(slot.index, avatar)
      }
      const p = slot.survivor
      const lift = remoteLift.get(slot) ?? 0
      // Keep animating out of sight so the gait is continuous when they step into view.
      const batches = avatar.draw(p, dt, time, (x, z) => supportHeight(town, x, z) + lift * 0.58)
      if (actorVisibility(vision, p.x, p.y) > 0.05) out.push(...batches)
    }
    for (const index of this.avatars.keys()) if (!live.has(index)) this.avatars.delete(index)
    return out
  }

  /** Menu, roster and name tags; call after the camera is updated. */
  overlay(cam: Camera, w: number, h: number, town: Town, vision: Vision): void {
    this.hud.update()
    const net = this.net
    if (!net) return
    this.hud.nameTags(
      net.remotes.map((slot) => {
        const p = slot.survivor
        const proj = cam.project(p.x, supportHeight(town, p.x, p.y) + 2.05, p.y, w, h)
        return { index: slot.index, name: net.nameOf(slot.index), x: proj.x, y: proj.y, visible: proj.ok && actorVisibility(vision, p.x, p.y) > 0.05 }
      }),
    )
  }

  /** Automation view of the room for proofs and smoke tests. */
  inspect() {
    const net = this.net
    if (!net) return null
    return {
      id: net.id,
      index: net.index,
      connected: net.connected,
      status: net.status,
      roster: net.roster,
      rtt: net.rtt,
      bytesIn: net.bytesIn,
      bytesOut: net.bytesOut,
      snapshots: net.snapshotCount,
      ack: net.lastAck,
      pending: net.predictor.unacked.length,
      local: { x: net.view.player.x, y: net.view.player.y, magAmmo: net.view.player.magAmmo, health: net.view.player.health },
      remotes: net.remotes.map((s) => ({ index: s.index, x: s.survivor.x, y: s.survivor.y, flashlightOn: s.survivor.flashlightOn })),
      doors: net.sim.town.doors.map((d) => ({ id: d.id, open: d.open })),
      zombies: net.view.zombies.length,
      shots: net.view.shots.map((s) => s.id),
    }
  }
}
