import type { Camera } from "@arcade/kit/client/camera"
import { LIGHT_FLOATS, MAX_LIGHTS } from "@arcade/kit/limits"
import type { Batch, Renderer } from "@arcade/kit/gpu/renderer"
import { randomRoomCode } from "@arcade/kit/sim/matchmaking"
import type { SurvivorSlot } from "../shared/coop-sim"
import type { FlashlightTuning } from "../shared/flashlight"
import { flashlightColor } from "../shared/flashlight"
import { clampSurvivorVariant, DEFAULT_LOADOUT, type LoadoutId, type SurvivorVariant } from "../shared/loadout"
import type { Town } from "../shared/map"
import type { LocalSession } from "../shared/session"
import { supportHeight } from "../shared/terrain"
import type { Vision } from "../shared/vision"
import { CoopHud, coopBasePath, copyInviteLink, inviteLink, playerName, type NameTag } from "./coop-hud"
import type { HudRemote } from "./hud"
import { OutbreakLobby, shouldShowStartScreen } from "./lobby/lobby-ui"
import { NetSession, remoteLift, SURVIVOR_COLOURS, type NetSessionFeatures } from "./net-session"
import { beamPose } from "./flashlight-beam"
import { resolveBeamColor } from "./look/world"
import { Survivor, type SurvivorAimTuning } from "./survivor"

type LightSettings =
  | (Pick<FlashlightTuning, "flashlightRange" | "flashlightCone" | "flashlightIntensity" | "flashlightWarmth"> & {
      practicalWarmth: number
      beamPoolDistance: number
    })
  | {
      flashlight: Pick<FlashlightTuning, "flashlightRange" | "flashlightCone" | "flashlightIntensity" | "flashlightWarmth"> & {
        beamPoolDistance: number
      }
      lighting: { practicalWarmth: number }
      look?: { beamWarmth: number; beamTightness?: number }
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
  readonly lobby: OutbreakLobby | null
  net: NetSession | null
  room: string | null
  soloVariant: SurvivorVariant = 0
  soloLoadout: LoadoutId = DEFAULT_LOADOUT
  soloName = ""
  /** Notifies `main.ts` when switching between Solo and Co-op or changing the Solo starting kit. */
  onSessionChange?: () => void
  private avatars = new Map<number, { variant: number; avatar: Survivor }>()
  /** Remote survivors' foot contacts, for positional footsteps. */
  onFootfall?: (x: number, y: number, speed: number) => void
  /**
   * Extra survivors in an offline session, drawn exactly like remote ones. Only automation adds them (the HUD proof
   * stages a teammate this way); normal offline play has none.
   */
  companions: () => readonly SurvivorSlot[] = () => []

  constructor(
    private readonly renderer: Renderer,
    net: NetSession | null,
    room: string | null,
    /** Offline automation (`?bench`) captures stay free of the Host button. */
    menu = true,
    private readonly features?: NetSessionFeatures,
  ) {
    this.net = net
    this.room = room
    this.hud = new CoopHud(net, room, {
      onOpenLobby: () => this.lobby?.openStart(),
      onLeaveRoom: () => this.leaveRoom(),
    })
    this.hud.root.hidden = !menu && !net
    this.lobby =
      menu || net
        ? new OutbreakLobby(document.body, {
            onStartSolo: (variant, loadout, name) => {
              this.soloVariant = variant
              this.soloLoadout = loadout
              this.soloName = name
              this.onSessionChange?.()
            },
            onHostCoop: (variant, loadout, name) => {
              this.soloName = name
              const code = randomRoomCode(undefined, Math.random, 5)
              const link = inviteLink(code)
              void copyInviteLink(code).then((copied) => {
                if (copied && this.room === code) this.hud.flash("Invite link copied. Send it to up to three friends.")
              })
              history.replaceState(null, "", link)
              this.connectRoom(code, name, variant, loadout, true)
            },
            onJoinCoop: (code, variant, loadout, name) => {
              this.soloName = name
              history.replaceState(null, "", inviteLink(code))
              this.connectRoom(code, name, variant, loadout, true)
            },
            onLeaveCoop: () => this.leaveRoom(),
            onPickChange: (patch) => {
              if (patch.variant !== undefined) this.soloVariant = patch.variant
              if (patch.loadout !== undefined) this.soloLoadout = patch.loadout
              if (patch.name !== undefined) this.soloName = patch.name
              if (this.net) {
                this.net.pick(patch)
              } else if (patch.loadout !== undefined) {
                this.onSessionChange?.()
              }
            },
          })
        : null
    if (this.lobby) {
      this.soloVariant = this.lobby.variant
      this.soloLoadout = this.lobby.loadout
      this.soloName = this.lobby.name
    }
  }

  /** True while the Start/Loadout screen or pre-game Co-op Lobby is open. */
  get paused(): boolean {
    return Boolean(this.lobby?.isOpen)
  }

  /** Applies the chosen Solo starting kit to an offline `LocalSession`. */
  applySoloLoadout(session: LocalSession): LocalSession {
    if (!this.net && this.soloLoadout !== DEFAULT_LOADOUT) {
      session.sim.progression.setLoadout(session.slot, this.soloLoadout)
    }
    return session
  }

  private connectRoom(
    room: string,
    name: string,
    variant: SurvivorVariant,
    loadout: LoadoutId,
    useLobby: boolean,
  ): NetSession {
    this.net?.close()
    this.avatars.clear()
    this.hud.nameTags([])
    const dir = coopBasePath()
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${dir}ws/${room}`
    const net = new NetSession({
      url,
      room,
      name,
      variant,
      loadout,
      lobby: useLobby,
      onLobbyChange: () => this.lobby?.sync(this.net),
      storage: sessionStorage,
      features: this.features!,
      onReload: (reason) => {
        const last = Number(sessionStorage.getItem("outbreak.coop.reloadAt") ?? 0)
        if (reason !== "restart" && Date.now() - last < 60_000) return
        sessionStorage.setItem("outbreak.coop.reloadAt", String(Date.now()))
        location.reload()
      },
    })
    this.net = net
    this.room = room
    this.hud.bind(net, room)
    this.hud.root.hidden = false
    if (useLobby) this.lobby?.openCoop(net)
    this.onSessionChange?.()
    return net
  }

  leaveRoom(): void {
    this.net?.leave()
    this.net = null
    this.room = null
    this.avatars.clear()
    this.hud.nameTags([])
    history.replaceState(null, "", coopBasePath())
    this.hud.bind(null, null)
    this.lobby?.openStart()
    this.onSessionChange?.()
  }

  /** `?room=<code>` joins that room; anything else plays offline (opening the start screen on normal visits). */
  static fromUrl(renderer: Renderer, params: URLSearchParams, features: NetSessionFeatures): CoopView {
    const room = params.get("room")?.toLowerCase().replace(/[^a-z0-9]/g, "") || null
    const view = new CoopView(renderer, null, null, !params.has("bench"), features)
    view.soloName = playerName(params)
    if (!room) {
      if (shouldShowStartScreen(location.search)) view.lobby?.openStart()
      return view
    }
    const autoStart = params.has("peaceful") || params.get("autostart") === "1" || params.get("lobby") === "0"
    view.connectRoom(room, view.soloName, view.soloVariant, view.soloLoadout, !autoStart)
    return view
  }

  /** Seat/survivor palette for the local survivor (variant 0 is the default offline look). */
  get localPalette(): { torso: number; legs: number } | null {
    const variant = this.net?.id ? this.net.variant : this.soloVariant
    if (variant === 0) return null
    return SURVIVOR_COLOURS[variant % SURVIVOR_COLOURS.length]!
  }

  /** Seat / character variant index for the local survivor (0 offline default, or lobby-picked variant). */
  get localVariant(): number {
    return this.net?.id ? this.net.variant : this.soloVariant
  }

  /** Callsign for the local survivor (from the co-op roster or lobby callsign field). */
  get localName(): string {
    if (this.net?.id) return this.net.nameOf(this.net.index)
    return this.soloName || this.lobby?.name || "Survivor"
  }

  /** The local survivor's drawn pose: predicted state plus the decaying reconciliation offset. */
  pose<P extends { x: number; y: number }>(p: P): P {
    const s = this.net?.smoother
    return s && (s.x || s.y) ? { ...p, x: p.x + s.x, y: p.y + s.y } : p
  }

  /** Whether a survivor is out of sight in a closet (D-19 verbs): their body is not drawn. */
  hidden: (id: string) => boolean = () => false

  /** Other survivors: the room's remote seats, or offline companions. */
  get others(): readonly SurvivorSlot[] {
    return this.net ? this.net.remotes : this.companions()
  }

  /** Plan positions of the other survivors (round casters for the local flashlight). */
  otherPositions(): [number, number][] {
    return this.others.map((slot) => [slot.survivor.x, slot.survivor.y])
  }

  /**
   * Packs remote flashlights after the local one, from each remote body's posed pistol or hand (call after `bodies`).
   * Returns the new light count.
   */
  flashlights(
    lights: Float32Array,
    count: number,
    town: Town,
    settings: LightSettings,
    occluders: number,
    blockers: readonly (readonly [number, number, number, number])[],
  ): number {
    const others = this.others
    if (!others.length) return count
    const flash = "flashlight" in settings ? settings.flashlight : settings
    const practicalWarmth = "lighting" in settings ? settings.lighting.practicalWarmth : settings.practicalWarmth
    const beamWarmth = "look" in settings && settings.look ? settings.look.beamWarmth : 1
    const beamTightness = "look" in settings && settings.look ? (settings.look.beamTightness ?? 0) : 0
    const tightShare = Math.max(0, Math.min(1, beamTightness))
    const rgb = resolveBeamColor(flashlightColor(flash.flashlightWarmth), beamWarmth)
    const effCone = flash.flashlightCone * (1 - 0.28 * tightShare)
    const cosHalf = Math.cos((effCone * Math.PI) / 360)
    const directScale = practicalWarmth > 0.6 ? 0.28 + 0.24 * tightShare : 1.0
    for (const slot of others) {
      const p = slot.survivor
      if (count >= MAX_LIGHTS - 2 || p.flashlightOutput <= 0.001 || !p.flashlightOn) continue
      const inside = town.buildings.some((b) => p.x > b.rect[0] - 0.1 && p.x < b.rect[2] + 0.1 && p.y > b.rect[1] - 0.1 && p.y < b.rect[3] + 0.1)
      const power = p.flashlightOutput * flash.flashlightIntensity * directScale
      const range = Math.min(flash.flashlightRange, (inside ? 5.2 : 6.4) + 1.8 * tightShare)
      const ground = supportHeight(town, p.x, p.y)
      const avatar = this.avatars.get(slot.index)?.avatar
      const rig = avatar?.light ?? { p: [p.x + Math.cos(p.aim) * 0.25, ground + 1.18, p.y + Math.sin(p.aim) * 0.25] as const, d: [Math.cos(p.aim), 0, Math.sin(p.aim)] as const, mounted: false }
      const beam = beamPose(rig, p.x, p.y, p.aim, ground, flash.beamPoolDistance, blockers)
      lights.set(
        [beam.x, beam.h, beam.y, range, rgb[0], rgb[1], rgb[2], power, Math.cos(beam.yaw), Math.sin(beam.yaw), cosHalf, 1, 0, occluders, 0.06, -1],
        count++ * LIGHT_FLOATS,
      )
    }
    return count
  }

  /** Bodies of remote survivors you can see. */
  bodies(dt: number, time: number, town: Town, vision: Vision, aimTuning?: Partial<SurvivorAimTuning>): Batch[] {
    const others = this.others
    if (!others.length && !this.avatars.size) return []
    const out: Batch[] = []
    const live = new Set<number>()
    for (const slot of others) {
      live.add(slot.index)
      const variant = this.net ? this.net.variantOfSeat(slot.index) : clampSurvivorVariant(slot.index)
      let entry = this.avatars.get(slot.index)
      if (!entry || entry.variant !== variant) {
        const avatar = new Survivor(this.renderer, SURVIVOR_COLOURS[variant % SURVIVOR_COLOURS.length]!, variant)
        avatar.onFootfall = (x, y, speed) => this.onFootfall?.(x, y, speed)
        entry = { variant, avatar }
        this.avatars.set(slot.index, entry)
      }
      const p = slot.survivor
      const lift = remoteLift.get(slot) ?? 0
      const sink = p.vehicleId ? 0.48 : 0
      // Keep animating out of sight so the gait is continuous when they step into view.
      const batches = entry.avatar.draw(
        p.vehicleId ? { ...p, vx: 0, vy: 0 } : p,
        dt,
        time,
        (x, z) => supportHeight(town, x, z) + lift * 0.58 - sink,
        aimTuning,
      )
      if (actorVisibility(vision, p.x, p.y) > 0.05 && !this.hidden(slot.id)) out.push(...batches)
    }
    for (const index of this.avatars.keys()) if (!live.has(index)) this.avatars.delete(index)
    return out
  }

  /** Menu, roster and name tags; call after the camera is updated. */
  overlay(cam: Camera, w: number, h: number, town: Town, vision: Vision, localPlayer?: { x: number; y: number }): void {
    this.hud.update()
    this.lobby?.sync(this.net)
    if (this.paused) {
      this.hud.nameTags([])
      return
    }
    const net = this.net
    const others = this.others
    if (!net && !this.lobby && !others.length) {
      this.hud.nameTags([])
      return
    }
    const tags: NameTag[] = []
    if (localPlayer && (net || this.lobby)) {
      const proj = cam.project(localPlayer.x, supportHeight(town, localPlayer.x, localPlayer.y) + 2.05, localPlayer.y, w, h)
      const localId = net ? net.local.id : "local"
      tags.push({
        index: -1,
        variant: this.localVariant,
        name: this.localName,
        x: proj.x,
        y: proj.y,
        visible: proj.ok && !this.hidden(localId),
      })
    }
    for (const slot of others) {
      const p = slot.survivor
      const lift = remoteLift.get(slot) ?? 0
      const proj = cam.project(p.x, supportHeight(town, p.x, p.y) + lift * 0.58 + 2.05, p.y, w, h)
      const name = net ? net.nameOf(slot.index) : slot.id
      const variant = net ? net.variantOfSeat(slot.index) : clampSurvivorVariant(slot.index)
      tags.push({
        index: slot.index,
        variant,
        name,
        x: proj.x,
        y: proj.y,
        visible: proj.ok && actorVisibility(vision, p.x, p.y) > 0.05 && !this.hidden(slot.id),
      })
    }
    this.hud.nameTags(tags)
  }

  /** Other survivors as the character HUD reads them: replicated state, ground height and visibility. */
  hudRemotes(town: Town, vision: Vision): HudRemote[] {
    return this.others.map((slot) => {
      const p = slot.survivor
      const lift = remoteLift.get(slot) ?? 0
      return {
        id: `seat:${slot.index}`,
        survivor: p,
        ground: supportHeight(town, p.x, p.y) + lift * 0.58,
        visible: actorVisibility(vision, p.x, p.y) > 0.05,
      }
    })
  }

  /** Automation view of the room for proofs and smoke tests. */
  inspect() {
    const net = this.net
    if (!net) {
      return this.lobby
        ? {
            name: this.localName,
            variant: this.soloVariant,
            loadout: this.soloLoadout,
            lobby: this.lobby.inspect(),
          }
        : null
    }
    return {
      id: net.id,
      index: net.index,
      name: this.localName,
      variant: net.variant,
      loadout: net.loadout,
      phase: net.phase,
      hostId: net.hostId,
      isHost: net.isHost,
      ready: net.ready,
      connected: net.connected,
      status: net.status,
      roster: net.roster,
      lobby: this.lobby?.inspect() ?? null,
      rtt: net.rtt,
      bytesIn: net.bytesIn,
      bytesOut: net.bytesOut,
      snapshots: net.snapshotCount,
      ack: net.lastAck,
      pending: net.predictor.unacked.length,
      local: {
        x: net.view.player.x,
        y: net.view.player.y,
        magAmmo: net.view.player.magAmmo,
        health: net.view.player.health,
        vehicleId: net.view.player.vehicleId ?? null,
        seatIndex: net.view.player.seatIndex ?? 0,
      },
      remotes: net.remotes.map((s) => ({
        index: s.index,
        x: s.survivor.x,
        y: s.survivor.y,
        flashlightOn: s.survivor.flashlightOn,
        vehicleId: s.survivor.vehicleId ?? null,
        seatIndex: s.survivor.seatIndex ?? 0,
      })),
      vehicles: net.view.vehicles.map((v) => ({
        id: v.id,
        kind: v.kind,
        x: v.x,
        y: v.y,
        h: v.h,
        hp: v.hp,
        fuel: v.fuel,
        engineOn: v.engineOn,
        seats: [...v.seats],
      })),
      doors: net.sim.town.doors.map((d) => ({ id: d.id, open: d.open })),
      zombies: net.view.zombies.length,
      shots: net.view.shots.map((s) => s.id),
    }
  }
}
