/// <reference types="vite/client" />
// In-match controller: networking, snapshot interpolation, client-side prediction, camera, HUD, effects.
import { Color, Quaternion, Vector3 } from "three"
import "../style.css"
import type { SceneHost } from "../render/scene"
import type { GameAudio } from "../audio"
import { createAircraftView, type AircraftView } from "../render/aircraft"
import { createHud, setScoreboard, TEAM_COLORS, TEAM_NAMES, type HudFrame, type HudWeapon } from "../render/hud"
import { Input } from "../input"
import { getNet, type Connection } from "./net-adapter"
import { createSpawnScreen } from "./spawn"
import { createPauseMenu } from "./pause"
import { toast, type StartRequest } from "./lobby"
import { onSettings, settings } from "./settings"
import { cloneFlight, flightReadout, forward, stepFlight } from "../sim/flight"
import { AIRBASES, deckVelocity, posedFleet, posedShip, setFleetState, worldQuery as baseWorldQuery } from "../sim/geography"
import { AA_RANGE, SHIP_SPECS, SPAWN_PROTECTION, shipToWorld, worldToShip, type Ship } from "../sim/fleet"
import type { WorldQuery } from "../sim/types"
import { VEHICLES, WEAPONS } from "../sim/vehicles"
import { TICK_DT } from "../sim/types"
import type { FlightInput, FlightState, GameEvent, PlayerInfo, Quat, SeatIndex, SeatInput, TeamId, Vec3, VehicleEntity } from "../sim/types"
import type { RoomConfig, ServerMessage, Snapshot } from "../sim/protocol"

const INTERP_DELAY = 0.1
/** Jet throttle slew (per second) used to turn wheel notches into throttle-axis pulses (mirrors flight.ts). */
const THROTTLE_RATE: Partial<Record<VehicleEntity["kind"], number>> = { fighter: 0.6, warthog: 0.5, blackbird: 0.45 }
const MAX_HISTORY = 360
const SNAP_ERROR = 40

export interface GameHandle {
  leave(): void
  /** Dev/diagnostics snapshot of the local player's state. */
  debug(): Record<string, unknown>
}

export interface GameDeps {
  host: SceneHost
  audio: GameAudio | null
  req: StartRequest
  name: string
  onExit(reason?: string): void
}

interface SnapEntry { snap: Snapshot; byId: Map<string, VehicleEntity> }

interface Visual {
  id: string
  kind: VehicleEntity["kind"]
  team: TeamId
  view: AircraftView
  render: VehicleEntity
  flight: FlightState
  pos: Vec3
  quat: Quat
  local?: boolean
}

interface Prediction {
  vehicleId: string
  state: FlightState
  history: { seq: number; input: FlightInput }[]
  errPos: Vector3
  errQuat: Quaternion
  /** Pose before the latest predicted tick: the own aircraft renders blended prev→state by the tick
   *  accumulator fraction, so motion is smooth at any display rate (120/144 Hz) instead of stepping. */
  prevPos: Vec3
  prevQuat: Quat
}

const _q1 = new Quaternion()
const _q2 = new Quaternion()
const _q3 = new Quaternion()
const _v1 = new Vector3()
const _v2 = new Vector3()
/** Prediction world: includes the moving carrier decks (same wrapping as the room engine). */
const worldQuery: WorldQuery = baseWorldQuery.deckVelocity ? baseWorldQuery : { ...baseWorldQuery, deckVelocity }

/** Smoothed ship turret aim (drives the world's turret pivots). */
interface TurretAim { ship: Ship; turret: string; offset: Vec3; yaw: number; pitch: number; tYaw: number; tPitch: number; firedAt: number }
const UP = new Vector3(0, 1, 0)

function lerp(a: number, b: number, t: number) { return a + (b - a) * t }

export async function startGame(deps: GameDeps): Promise<GameHandle> {
  const { host, audio } = deps
  const net = await getNet()
  let code = ""
  const offline = deps.req.mode === "offline"
  if (deps.req.mode === "quick") code = await net.quickPlay()
  else if (deps.req.mode === "join") code = deps.req.code
  else if (deps.req.mode === "create") code = await net.createRoom(deps.req.config)

  const session = new GameSession(deps, offline)
  await session.connect(net, code, deps.req.mode === "offline" ? deps.req.config : null)
  return session
}

class GameSession implements GameHandle {
  private conn: Connection | null = null
  private playerId = ""
  private room = ""
  private config!: RoomConfig
  private snaps: SnapEntry[] = []
  private latest: Snapshot | null = null
  private latestById = new Map<string, VehicleEntity>()
  private players = new Map<string, PlayerInfo>()
  private me: PlayerInfo | null = null
  private timeOffset = 0
  private haveOffset = false
  private visuals = new Map<string, Visual>()
  private renderList: VehicleEntity[] = []
  private pred: Prediction | null = null
  private tickAcc = 0
  private pendingThrottle = 0
  private lastSeat: SeatInput | null = null
  private seq = 0
  private sentFlight: FlightInput = { aim: null, throttle: 0, roll: 0, yaw: 0, pitch: 0, boost: false, brake: false }
  private flightBuf: FlightInput = { aim: null, throttle: 0, roll: 0, yaw: 0, pitch: 0, boost: false, brake: false }
  private seatBuf: SeatInput = { aim: null, firePrimary: false, fireSecondary: false, flares: false, ability: false }
  private aim: Vec3 = [0, 0, -1]
  private look: Vec3 = [0, 0, -1]
  private lookV = new Vector3()
  private state: "spawn" | "flying" | "dead" = "spawn"
  private paused = false
  private deathAt = 0
  private deathPos: Vec3 = [0, 0, 0]
  private lastOwnPos: Vec3 = [0, 0, 0]
  private voluntaryLeave = false
  private view: "chase" | "cockpit" = "chase"
  private rtt = 0
  private pingTimer = 0
  private input: Input
  private hud
  private spawn
  private pause
  private hudFrame: HudFrame
  private weaponsBuf: HudWeapon[] = [
    { id: "cannon20", ammo: 0, cap: 0, ready: 1, regen: false, lock: 0, locked: false },
    { id: "cannon20", ammo: 0, cap: 0, ready: 1, regen: false, lock: 0, locked: false },
  ]
  private tracerColors = TEAM_COLORS.map(c => new Color(c).lerp(new Color("#fff4d6"), 0.78))
  private offSettings: () => void
  private ended = false
  private scoreboardShown = false
  private uiRoot: HTMLElement
  private reconnecting = false
  private corrStats = { n: 0, sum: 0, max: 0, replay: 0 }
  private welcomeResolve: (() => void) | null = null
  private welcomeReject: ((e: Error) => void) | null = null

  constructor(private deps: GameDeps, private offline: boolean) {
    const host = deps.host
    this.uiRoot = document.createElement("div")
    this.uiRoot.className = "game-ui"
    document.body.appendChild(this.uiRoot)
    this.input = new Input(host.renderer.domElement)
    this.hud = createHud(this.uiRoot)
    const click = () => deps.audio?.ui("click")
    this.spawn = createSpawnScreen(this.uiRoot, {
      spawn: kind => { this.input.requestLock(); this.send({ type: "spawn", kind }); deps.audio?.ui("confirm") },
      board: (vehicle, seat) => { this.input.requestLock(); this.send({ type: "board", vehicle, seat }); deps.audio?.ui("confirm") },
      team: team => this.send({ type: "team", team }),
      invite: () => this.copyInvite(),
      leave: () => this.leave(),
      click,
      thumb: (kind, team) => host.thumbnail(kind, team),
    })
    this.pause = createPauseMenu(this.uiRoot, {
      resume: () => this.resume(),
      changeVehicle: () => {
        this.voluntaryLeave = true
        this.send({ type: "leave-vehicle" })
        this.pause.hide()
        this.paused = false
        this.enterSpawn()
      },
      invite: () => this.copyInvite(),
      leave: () => this.leave(),
      quality: q => host.setQuality(q),
      click,
    })
    this.hudFrame = {
      camera: host.camera, time: 0, myId: "", me: null, vehicle: null, seat: null, aimPoint: null, borePoint: null,
      vehicles: this.renderList, players: this.players, speed: 0, altitude: 0, heading: 0, throttle: 0, boost: false,
      protected: false, missileWarning: false, lockTarget: null, lockProgress: 0, lead: null, weapons: [], scores: [],
      teams: 2, remaining: null, intermission: false, freeLook: false, ping: 0, direct: false,
      seekerCone: 0, seekerCenter: null, scanner: false, scannerCone: 0, scannerRange: null, guide: null, hint: null,
    }
    this.offSettings = onSettings(s => {
      deps.audio?.setMuted(s.muted)
      deps.audio?.setVolume(s.volume)
    })
    window.addEventListener("keydown", this.onKeyDown)
    // Thunder: delay = strike distance / speed of sound. Prefer the world's strike position; the direction-only
    // onLightning hook carries no distance, so assume a mid-range strike (bolts land 2.2–7.2 km out).
    type LW = { lightningSource?: () => { intensity: number; position: Vec3 | { x: number; y: number; z: number } } | null; onLightning?: (cb: (i: number) => void) => () => void }
    const lw = host.world as unknown as LW
    this.offLightning = lw.onLightning?.(intensity => {
      const src = lw.lightningSource?.()
      const c = host.camera.position
      let dist = 4700
      if (src) {
        const p = src.position
        const [x, y, z] = Array.isArray(p) ? p : [(p as { x: number }).x, (p as { y: number }).y, (p as { z: number }).z]
        dist = Math.hypot(x - c.x, y - c.y, z - c.z)
      }
      this.deps.audio?.thunder(dist / 343, src?.intensity ?? intensity)
    }) ?? null
    deps.audio?.setStorm({ enabled: true, rain: 1, cockpit: false })
  }

  async connect(net: Awaited<ReturnType<typeof getNet>>, code: string, offlineConfig: RoomConfig | null): Promise<void> {
    const handlers = {
      onMessage: (m: ServerMessage) => this.onMessage(m),
      onStatus: (s: string) => {
        if (this.ended) return
        if (s === "closed") {
          if (this.welcomeReject) this.welcomeReject(new Error("Connection closed"))
          else if (!this.offline) { this.reconnecting = true; toast("Connection lost — reconnecting…", true) }
          else this.exit("Practice room closed")
        } else if (s === "open" && this.reconnecting) {
          this.reconnecting = false
          toast("Reconnected")
        }
      },
    }
    const welcome = new Promise<void>((resolve, reject) => {
      this.welcomeResolve = resolve
      this.welcomeReject = reject
      setTimeout(() => reject(new Error("The room did not answer")), 10_000)
    })
    this.conn = offlineConfig ? net.createLocalRoom(offlineConfig, this.deps.name, handlers) : net.connectRoom(code, this.deps.name, handlers)
    try {
      await welcome
    } catch (e) {
      this.ended = true
      this.conn?.close()
      this.dispose()
      throw e
    }
    this.welcomeResolve = this.welcomeReject = null
    this.deps.host.setFrame((dt, time) => this.frame(dt, time))
    this.enterSpawn()
    if (!this.offline) this.pingTimer = window.setInterval(() => { if (!this.rtt) this.send({ type: "ping", t: performance.now() }) }, 2000)
    if (!this.offline) history.replaceState(null, "", `${import.meta.env.BASE_URL}?join=${encodeURIComponent(this.room)}`)
  }

  leave(): void {
    this.exit()
  }

  debug(): Record<string, unknown> {
    const v = this.myVehicle()
    const vis = v ? this.visuals.get(v.id) : undefined
    return {
      state: this.state, seat: this.me?.seat ?? null, team: this.me?.team ?? null, vehicles: this.latest?.vehicles.length ?? 0,
      pos: vis?.pos.map(Math.round), speed: v ? Math.round(flightReadout(this.pred?.state ?? v.flight).speed) : 0,
      hp: v?.hp, projectiles: this.latest?.projectiles.length ?? 0, missiles: this.latest?.missiles.length ?? 0,
      predErr: this.pred ? +this.pred.errPos.length().toFixed(2) : null, history: this.pred?.history.length ?? 0,
      rtt: Math.round(this.rtt), lockFailed: this.input.lockFailed,
      corr: { n: this.corrStats.n, avg: +(this.corrStats.sum / Math.max(1, this.corrStats.n)).toFixed(2), max: +this.corrStats.max.toFixed(2), replay: +(this.corrStats.replay / Math.max(1, this.corrStats.n)).toFixed(1) },
      others: this.renderList.filter(o => o.id !== v?.id).map(o => ({ id: o.id, team: o.team, kind: o.kind, alive: o.alive, hp: o.hp, pos: this.visuals.get(o.id)?.pos.map(Math.round) })),
      att: v ? (() => { const r = flightReadout(this.pred?.state ?? v.flight); return { pitch: Math.round(r.pitch), roll: Math.round(r.roll), hdg: Math.round(r.heading), thr: +r.throttle.toFixed(2) } })() : null,
      steer: [+this.input.steerPitch.toFixed(2), +this.input.steerYaw.toFixed(2), +this.input.steerRoll.toFixed(2)], seq: this.seq,
      // Unrounded own-aircraft render position and camera position (jitter measurements).
      ownRaw: vis ? [vis.pos[0], vis.pos[1], vis.pos[2]] : null,
      camRaw: [this.deps.host.camera.position.x, this.deps.host.camera.position.y, this.deps.host.camera.position.z],
      aim: [+this.input.aimYaw.toFixed(3), +this.input.aimPitch.toFixed(3)], fwd: vis ? forward(vis.quat).map(n => +n.toFixed(2)) : null,
    }
  }

  // ---------------------------------------------------------------- networking

  private send(m: Parameters<Connection["send"]>[0]): void {
    this.conn?.send(m)
  }

  private onMessage(m: ServerMessage): void {
    switch (m.type) {
      case "welcome":
        if (this.playerId && this.playerId !== m.playerId) {
          this.pred = null
          this.snaps = []
          this.latest = null
          if (this.state !== "spawn") this.enterSpawn()
        }
        this.playerId = m.playerId
        this.room = m.room
        this.config = m.config
        this.hudFrame.myId = m.playerId
        this.hudFrame.teams = m.config.teams
        ;(this.deps.audio as { setLocalPlayer?(id: string | null): void } | null)?.setLocalPlayer?.(m.playerId)
        this.welcomeResolve?.()
        break
      case "snapshot":
        this.onSnapshot(m)
        break
      case "events":
        this.onEvents(m.events)
        break
      case "error":
        toast(m.message, true)
        break
      case "pong":
        this.rtt = this.rtt ? lerp(this.rtt, performance.now() - m.t, 0.3) : performance.now() - m.t
        break
    }
  }

  private onSnapshot(s: Snapshot): void {
    if (!this.config) return
    const now = performance.now() / 1000
    const sample = s.time - now
    if (!this.haveOffset) { this.timeOffset = sample; this.haveOffset = true }
    else this.timeOffset += (sample - this.timeOffset) * (sample > this.timeOffset ? 0.3 : 0.03)
    if (Math.abs(sample - this.timeOffset) > 1) this.timeOffset = sample

    const byId = new Map<string, VehicleEntity>()
    for (const v of s.vehicles) byId.set(v.id, v)
    if (this.latest && s.time <= this.latest.time) return
    this.snaps.push({ snap: s, byId })
    while (this.snaps.length > 2 && this.snaps[1].snap.time < s.time - 1.5) this.snaps.shift()
    this.latest = s
    this.latestById = byId

    this.players.clear()
    for (const p of s.players) this.players.set(p.id, p)
    this.me = this.players.get(this.playerId) ?? null
    this.reconcile(s)
    this.updateLifeState()
  }

  private myVehicle(): VehicleEntity | null {
    const id = this.me?.vehicleId
    return id ? this.latestById.get(id) ?? null : null
  }

  private reconcile(s: Snapshot): void {
    const me = this.me
    const sv = this.myVehicle()
    if (!me || !sv || !sv.alive || me.seat !== 0) { this.pred = null; return }
    const p = this.pred
    if (!p || p.vehicleId !== sv.id) {
      const st = cloneFlight(sv.flight)
      this.pred = { vehicleId: sv.id, state: st, history: [], errPos: new Vector3(), errQuat: new Quaternion(),
        prevPos: [st.position[0], st.position[1], st.position[2]], prevQuat: [st.orientation[0], st.orientation[1], st.orientation[2], st.orientation[3]] }
      return
    }
    const h = p.history
    let drop = 0
    while (drop < h.length && h[drop].seq <= s.ack) drop++
    if (drop) h.splice(0, drop)
    const old = p.state
    const next = cloneFlight(sv.flight)
    for (const e of h) stepFlight(next, e.input, TICK_DT, worldQuery)
    const dx = old.position[0] - next.position[0], dy = old.position[1] - next.position[1], dz = old.position[2] - next.position[2]
    const corr = Math.hypot(dx, dy, dz)
    this.corrStats.n++
    this.corrStats.sum += corr
    this.corrStats.max = Math.max(this.corrStats.max, corr)
    this.corrStats.replay += h.length
    if (Math.hypot(dx, dy, dz) > SNAP_ERROR) {
      p.errPos.set(0, 0, 0)
      p.errQuat.identity()
      p.prevPos[0] = next.position[0]; p.prevPos[1] = next.position[1]; p.prevPos[2] = next.position[2]
      p.prevQuat[0] = next.orientation[0]; p.prevQuat[1] = next.orientation[1]; p.prevQuat[2] = next.orientation[2]; p.prevQuat[3] = next.orientation[3]
    } else {
      // Keep the render blend continuous: move the previous pose into the corrected timeline too.
      p.prevPos[0] -= dx; p.prevPos[1] -= dy; p.prevPos[2] -= dz
      _q3.set(next.orientation[0], next.orientation[1], next.orientation[2], next.orientation[3])
        .multiply(_q2.set(old.orientation[0], old.orientation[1], old.orientation[2], old.orientation[3]).invert())
        .multiply(_q1.set(p.prevQuat[0], p.prevQuat[1], p.prevQuat[2], p.prevQuat[3])).normalize()
      p.prevQuat[0] = _q3.x; p.prevQuat[1] = _q3.y; p.prevQuat[2] = _q3.z; p.prevQuat[3] = _q3.w
      p.errPos.x += dx; p.errPos.y += dy; p.errPos.z += dz
      // errQ' = errQ * oldQ * inv(newQ)
      _q1.set(old.orientation[0], old.orientation[1], old.orientation[2], old.orientation[3])
      _q2.set(next.orientation[0], next.orientation[1], next.orientation[2], next.orientation[3]).invert()
      p.errQuat.multiply(_q1).multiply(_q2).normalize()
    }
    p.state = next
  }

  private updateLifeState(): void {
    const v = this.myVehicle()
    const flying = !!v && v.alive
    if (flying && this.state !== "flying") {
      this.state = "flying"
      this.voluntaryLeave = false
      this.spawn.hide()
      this.hud.setVisible(true)
      this.input.setEnabled(true)
      this.input.setAim(forward(v!.flight.orientation))
      this.deps.host.rig.resetFollow()
      this.deps.host.world.setHighlightTeam(null)
      this.deps.host.rig.setMode(this.me?.seat === 1 ? "gunner" : this.view)
      if (!this.input.locked) this.input.requestLock()
    } else if (!flying && this.state === "flying") {
      if (this.voluntaryLeave) this.enterSpawn()
      else {
        this.state = "dead"
        this.deathAt = performance.now() / 1000
        this.deathPos = [...this.lastOwnPos]
        this.hud.setVisible(false)
        this.input.setEnabled(false)
        this.input.releaseLock()
        this.pause.hide()
        this.paused = false
        this.deps.host.rig.setMode("death")
      }
    }
  }

  private enterSpawn(): void {
    this.state = "spawn"
    this.hud.setVisible(false)
    this.input.setEnabled(false)
    this.input.releaseLock()
    this.spawn.show()
    this.deps.host.rig.setMode("orbit")
    if (this.me) this.deps.host.world.setHighlightTeam(this.me.team)
  }

  private resume(): void {
    this.pause.hide()
    this.paused = false
    if (this.state === "flying") {
      this.input.setEnabled(true)
      this.input.requestLock()
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.paused && !this.input.locked) {
      e.preventDefault()
      this.resume()
    }
  }

  private copyInvite(): void {
    if (this.offline) { toast("Offline practice rooms can't be shared — create an online lobby to invite friends."); return }
    const url = `${location.origin}${import.meta.env.BASE_URL}?join=${encodeURIComponent(this.room)}`
    navigator.clipboard?.writeText(url).then(() => toast(`Invite link copied — room ${this.room}`), () => toast(url))
  }

  private exit(reason?: string): void {
    if (this.ended) return
    console.info("[wings] leaving match", reason ?? "")
    this.ended = true
    this.conn?.close()
    this.dispose()
    if (!this.offline) history.replaceState(null, "", import.meta.env.BASE_URL)
    this.deps.onExit(reason)
  }

  private dispose(): void {
    clearInterval(this.pingTimer)
    this.offLightning?.()
    window.removeEventListener("keydown", this.onKeyDown)
    this.offSettings()
    this.input.dispose()
    for (const v of this.visuals.values()) this.removeVisual(v)
    this.visuals.clear()
    const fx = this.deps.host.effects
    fx.setTracers(0, () => {})
    fx.setMissiles(0, () => {})
    this.deps.host.world.setHighlightTeam(null)
    this.deps.host.setFrame(null)
    this.uiRoot.remove()
    this.deps.audio?.updateVehicles([], null)
  }

  // ---------------------------------------------------------------- events

  private nameOf(id: string | null): { name: string; team: TeamId | null } {
    if (!id) return { name: "?", team: null }
    const p = this.players.get(id)
    if (p) return { name: p.name, team: p.team }
    const v = this.latestById.get(id)
    if (v) {
      const pilot = v.seats[0] ? this.players.get(v.seats[0]) : null
      return { name: pilot?.name ?? VEHICLES[v.kind].name, team: v.team }
    }
    return { name: id, team: null }
  }

  private turretAims = new Map<string, TurretAim>()
  private offLightning: (() => void) | null = null
  private stormCockpit = false
  private flakAims: { p: Vec3; t: number }[] = []
  private aaFiredAt = -Infinity
  private spawnedAt = 0
  private spawnedVeh: string | null = null

  private aimTurret(shipId: string, turretId: string, aim: Vec3, now: number): void {
    const key = `${shipId}:${turretId}`
    let t = this.turretAims.get(key)
    if (!t) {
      const ship = posedShip(shipId)
      const spec = ship ? SHIP_SPECS[ship.kind].turrets.find(x => x.id === turretId) : undefined
      if (!ship || !spec) return
      t = { ship, turret: turretId, offset: spec.offset, yaw: 0, pitch: 0, tYaw: 0, tPitch: 0, firedAt: 0 }
      this.turretAims.set(key, t)
    }
    const l = worldToShip(t.ship, aim)
    const lx = l[0] - t.offset[0], ly = l[1] - t.offset[1], lz = l[2] - t.offset[2]
    t.tYaw = Math.atan2(-lx, -lz)
    t.tPitch = Math.atan2(ly, Math.hypot(lx, lz))
    t.firedAt = now
  }

  /** Slew turrets toward their last aim while firing; idle ones drift back to rest. */
  private updateTurrets(dt: number, now: number): void {
    const world = this.deps.host.world as unknown as { getShipTurret?: (s: string, t: string) => { yaw: { rotation: { y: number } }; pitch: { rotation: { x: number } } } | null }
    if (!world.getShipTurret) return
    for (const t of this.turretAims.values()) {
      const idle = now - t.firedAt > 2.5
      const ty = idle ? 0 : t.tYaw, tp = idle ? 0 : t.tPitch
      const rate = idle ? 0.6 : 3.5
      let dy = ty - t.yaw
      dy = Math.atan2(Math.sin(dy), Math.cos(dy))
      t.yaw += Math.sign(dy) * Math.min(Math.abs(dy), rate * dt)
      t.pitch += Math.sign(tp - t.pitch) * Math.min(Math.abs(tp - t.pitch), rate * 0.7 * dt)
      const h = world.getShipTurret(t.ship.id, t.turret)
      if (h) { h.yaw.rotation.y = t.yaw; h.pitch.rotation.x = t.pitch }
      if (idle && Math.abs(t.yaw) < 1e-3 && Math.abs(t.pitch) < 1e-3) this.turretAims.delete(`${t.ship.id}:${t.turret}`)
    }
  }

  /**
   * Pose the moving fleets at the estimated server time, from the latest snapshot's match clock (the same
   * clock the room engine uses, so offline the in-browser engine and the renderer agree).
   */
  private syncFleet(est: number): void {
    const s = this.latest
    if (!s || !this.config) return
    const started = s.matchStartedAt ?? 0
    setFleetState(s.intermission ? 0 : Math.max(0, est - started), this.config.teams)
  }

  private posOfVehicle(id: string): Vec3 | null {
    const vis = this.visuals.get(id)
    if (vis) return vis.pos
    const v = this.latestById.get(id)
    return v ? v.flight.position : null
  }

  private onEvents(events: GameEvent[]): void {
    const fx = this.deps.host.effects
    const audio = this.deps.audio
    const myVeh = this.me?.vehicleId ?? null
    const cam = this.deps.host.camera.position
    const now = performance.now() / 1000
    for (const e of events) {
      let pos: Vec3 | null = null
      let local = false
      switch (e.type) {
        case "fire": {
          pos = this.posOfVehicle(e.vehicle)
          local = e.vehicle === myVeh
          const vis = this.visuals.get(e.vehicle)
          if (vis && pos && WEAPONS[e.weapon].kind === "gun") {
            const a = vis.render.aim[e.seat]
            const d = e.seat === 0 || !a ? forward(vis.quat) : a
            const anchor = vis.view.anchors?.get(e.seat === 0 ? "gun" : "turret_chin_barrel") ?? vis.view.anchors?.get("gun")
            if (anchor) {
              anchor.getWorldPosition(_v1)
              fx.muzzle([_v1.x, _v1.y, _v1.z], d)
            } else {
              const r = VEHICLES[vis.kind].radius * 0.6
              fx.muzzle([pos[0] + d[0] * r, pos[1] + d[1] * r, pos[2] + d[2] * r], d)
            }
          }
          break
        }
        case "aa": {
          pos = e.position
          fx.aa(e.position, e.aim, e.kind)
          this.aimTurret(e.ship, e.turret, e.aim, now)
          if (e.kind === "gun") { this.flakAims.push({ p: e.aim, t: now }); if (this.flakAims.length > 24) this.flakAims.shift() }
          if (e.target === myVeh) this.aaFiredAt = now
          audio?.event(e, e.position, false)
          continue
        }
        case "hit":
          pos = e.position
          fx.hit(e.position)
          if (e.target === myVeh) {
            const atk = e.by ? this.players.get(e.by)?.vehicleId : null
            const ship = e.by ? posedShip(e.by) ?? undefined : undefined
            this.hud.damage(ship ? shipToWorld(ship, [0, 30, 0]) : atk ? this.posOfVehicle(atk) : null)
            this.deps.host.rig.shake(0.5)
            local = true
          }
          if (e.by === this.playerId) this.hud.hitmarker()
          break
        case "kill": {
          pos = e.position
          fx.explosion(e.position, 16)
          const aaKill = e.weapon === "aa"
          const fleetTeam = (e.killerTeam ?? 0) as TeamId
          const killer = aaKill ? { name: `${TEAM_NAMES[fleetTeam]} fleet`, team: fleetTeam } : e.killer ? this.nameOf(e.killer) : null
          const victim = this.nameOf(e.victim)
          const weapon = e.weapon === "crash" ? "crashed" : e.weapon === "aa" ? "anti-air" : WEAPONS[e.weapon]?.name ?? e.weapon
          const mine = e.killer === this.playerId || e.victim === this.playerId || e.victim === myVeh
          this.hud.killfeed(killer?.name ?? null, killer?.team ?? null, victim.name, e.victimTeam, weapon, mine,
            { killer: !!(e.killer && this.players.get(e.killer)?.bot), victim: !!this.players.get(e.victim)?.bot })
          if (e.killer === this.playerId && e.victim !== this.playerId) {
            this.hud.hitmarker(true)
            this.hud.banner("SPLASH ONE", `${victim.name} is going down`, 1800)
          }
          if (e.victim === this.playerId || (myVeh && e.victim === myVeh)) {
            const kv = e.killer && e.killer !== this.playerId ? this.players.get(e.killer)?.vehicleId : null
            const kp = kv ? this.posOfVehicle(kv) : null
            const lp = this.lastOwnPos
            const dist = kp ? Math.hypot(kp[0] - lp[0], kp[1] - lp[1], kp[2] - lp[2]) : null
            const byOther = killer && (aaKill || e.killer !== this.playerId) && e.weapon !== "crash"
            this.hud.deathCard(byOther ? killer.name : null, byOther ? killer.team : null, weapon, dist)
          }
          local = e.killer === this.playerId
          break
        }
        case "explosion": {
          pos = e.position
          // Flak: a burst near a recent 5-inch shell's aim point renders as a gray flak puff.
          const fl = this.flakAims.findIndex(a => now - a.t < 5 && Math.hypot(a.p[0] - e.position[0], a.p[1] - e.position[1], a.p[2] - e.position[2]) < 160)
          if (fl >= 0) { this.flakAims.splice(fl, 1); fx.flak(e.position) }
          else fx.explosion(e.position, e.size)
          if (_v1.set(e.position[0], e.position[1], e.position[2]).distanceTo(cam) < 300) this.deps.host.rig.shake(0.8)
          break
        }
        case "flares":
          pos = this.posOfVehicle(e.vehicle)
          local = e.vehicle === myVeh
          break
        case "lock":
          local = e.vehicle === myVeh
          pos = this.posOfVehicle(e.vehicle)
          break
        case "pulse":
          pos = e.position
          fx.pulse(e.position, e.radius, e.team === this.me?.team ? "#7dffd0" : "#c27dff")
          local = e.vehicle === myVeh
          if (e.team !== this.me?.team && this.me && myVeh && this.posOfVehicle(myVeh)) {
            const p = this.posOfVehicle(myVeh)!
            if (Math.hypot(p[0] - e.position[0], p[1] - e.position[1], p[2] - e.position[2]) < e.radius) this.hud.banner("YOU HAVE BEEN SEEN", "enemy radar painted your aircraft", 2200)
          }
          break
        case "spotted": {
          if (e.team !== this.me?.team) break
          const by = this.nameOf(e.by), tgt = this.nameOf(e.target)
          const mine = e.by === myVeh
          this.hud.spotted(by.name, e.team, tgt.name, (tgt.team ?? 0) as TeamId, mine)
          break
        }
        case "chat": {
          const n = this.nameOf(e.player)
          this.hud.chat(n.name, n.team, e.text)
          break
        }
        case "score":
          break
        case "match-end":
          this.hud.banner(e.winner === null ? "STALEMATE" : `${TEAM_NAMES[e.winner].toUpperCase()} PREVAILS`,
            e.winner !== null && e.winner === this.me?.team ? "Your banner holds the sky" : "The sky remembers", 6500)
          break
      }
      audio?.event(e, pos, local)
    }
  }

  // ---------------------------------------------------------------- frame

  private frame(dt: number, time: number): void {
    const host = this.deps.host
    const input = this.input
    const latest = this.latest
    const now = performance.now() / 1000

    for (const a of input.takeActions()) this.onAction(a)
    this.syncFleet(now + this.timeOffset)
    if (input.scoreboard !== this.scoreboardShown) { this.scoreboardShown = input.scoreboard; setScoreboard(this.hud, input.scoreboard) }

    const me = this.me
    const myVehicle = this.myVehicle()
    const flying = this.state === "flying" && !!myVehicle && myVehicle.alive && !this.paused
    const seat = me?.seat ?? null
    const heli = myVehicle ? VEHICLES[myVehicle.kind].flight === "heli" : false

    // Mouse role: gunners always aim the turret; pilots use the chosen control style.
    const mode = seat === 1 || settings.controlStyle === "aim" ? "aim" : "direct"
    if (mode !== input.mouseMode) {
      if (mode === "aim") {
        const c = this.deps.host.camera
        _v1.set(0, 0, -1).applyQuaternion(c.quaternion)
        input.setAim([_v1.x, _v1.y, _v1.z])
      }
      input.mouseMode = mode
    }
    input.aimDir(this.aim)
    input.lookDir(this.look)
    this.lookV.set(this.look[0], this.look[1], this.look[2])
    const direct = seat === 0 && mode === "direct"
    if (flying && direct) input.sampleSteering(dt, heli)

    // Wheel: gunner zoom, pilot fine throttle (jets).
    const wheel = input.takeWheel()
    if (wheel && seat === 0 && !heli) this.pendingThrottle = Math.max(-1, Math.min(1, this.pendingThrottle - wheel * 0.0005))
    if (wheel && seat === 1) this.deps.host.rig.gunZoom = Math.max(1, Math.min(8, this.deps.host.rig.gunZoom * Math.pow(1.25, -wheel / 100)))

    _v1.set(0, 0, -1).applyQuaternion(this.deps.host.camera.quaternion)
    const camFwd: Vec3 = [_v1.x, _v1.y, _v1.z]
    // Exactly one input per 60 Hz simulation tick; the same input drives local prediction.
    this.tickAcc += dt
    if (this.tickAcc > 0.25) this.tickAcc = 0.25
    const p = this.pred
    const rate = myVehicle && !heli ? THROTTLE_RATE[myVehicle.kind] ?? 0.5 : 0
    while (this.tickAcc >= TICK_DT) {
      this.tickAcc -= TICK_DT
      if (this.state !== "flying" || !myVehicle) continue
      const seq = ++this.seq
      const aim: Vec3 = [this.aim[0], this.aim[1], this.aim[2]]
      // Direct-steering pilots have no aim cursor: their seat aim is where the camera looks (incl. free-look),
      // which drives recon look-to-spot.
      const seatAim: Vec3 = seat === 0 && direct ? camFwd : aim
      let fi: FlightInput | null = null
      if (seat === 0) {
        let tAxis: number | null = null
        if (rate > 0 && Math.abs(this.pendingThrottle) > 1e-4) {
          tAxis = Math.max(-1, Math.min(1, this.pendingThrottle / (rate * TICK_DT)))
          this.pendingThrottle -= tAxis * rate * TICK_DT
        }
        fi = flying ? { ...input.flightInput(aim, heli, tAxis, this.flightBuf) }
          : { aim: direct ? null : aim, throttle: 0, roll: 0, yaw: 0, pitch: 0, boost: false, brake: false }
        this.sentFlight = fi
      }
      const seatIn = flying ? { ...input.seatInput(seatAim, this.seatBuf) } : { aim: seatAim, firePrimary: false, fireSecondary: false, flares: false, ability: false }
      this.lastSeat = seatIn
      this.send(fi ? { type: "input", seq, flight: fi, seat: seatIn } : { type: "input", seq, seat: seatIn })
      if (p && fi) {
        const ps = p.state
        p.prevPos[0] = ps.position[0]; p.prevPos[1] = ps.position[1]; p.prevPos[2] = ps.position[2]
        p.prevQuat[0] = ps.orientation[0]; p.prevQuat[1] = ps.orientation[1]; p.prevQuat[2] = ps.orientation[2]; p.prevQuat[3] = ps.orientation[3]
        stepFlight(p.state, fi, TICK_DT, worldQuery)
        p.history.push({ seq, input: fi })
      }
    }
    if (p) {
      if (p.history.length > MAX_HISTORY) p.history.splice(0, p.history.length - MAX_HISTORY)
      // Corrections along the flight path (server timeline shifts of a tick or two ≈ v·dt) bleed out
      // slowly so they read as an imperceptible speed change, not a lurch; cross-track ones stay quick.
      const sv = p.state.velocity, sp = Math.hypot(sv[0], sv[1], sv[2])
      if (sp > 1) {
        const ux = sv[0] / sp, uy = sv[1] / sp, uz = sv[2] / sp
        const along = p.errPos.x * ux + p.errPos.y * uy + p.errPos.z * uz
        const keepAlong = Math.exp(-dt * 1.5), keepCross = Math.exp(-dt * 7)
        p.errPos.x = (p.errPos.x - along * ux) * keepCross + along * keepAlong * ux
        p.errPos.y = (p.errPos.y - along * uy) * keepCross + along * keepAlong * uy
        p.errPos.z = (p.errPos.z - along * uz) * keepCross + along * keepAlong * uz
      } else p.errPos.multiplyScalar(Math.exp(-dt * 7))
      p.errQuat.slerp(_q3.identity(), 1 - Math.exp(-dt * 10))
    }

    // Interpolated entities
    const est = now + this.timeOffset
    const rt = est - INTERP_DELAY
    this.buildRenderList(rt, dt)

    // Aircraft views (before the camera so attachment anchors are current)
    const ownVis = myVehicle ? this.visuals.get(myVehicle.id) : undefined
    const players = latest ? latest.players : []
    const firing = flying ? this.lastSeat : null
    for (const v of this.visuals.values()) {
      v.view.root.visible = v.render.alive
      const isLocal = v === ownVis
      if (v.local !== isLocal) { v.local = isLocal; v.view.setLocal?.(isLocal) }
      if (!v.render.alive) continue
      if (v === ownVis && seat !== null) {
        v.view.setFiring?.(seat, 0, !!firing?.firePrimary)
        v.view.setFiring?.(seat, 1, !!firing?.fireSecondary)
        if (seat === 0) v.view.setBoost?.(this.sentFlight.boost)
      }
      v.view.setSpotted?.(!!me && v.render.team !== me.team && v.render.spottedUntil > (latest?.time ?? 0))
      v.view.update(v.render, players, dt, host.camera)
    }
    this.updateTurrets(dt, now)

    // Camera
    const rig = host.rig
    if (this.state === "flying" && ownVis) {
      this.lastOwnPos[0] = ownVis.pos[0]; this.lastOwnPos[1] = ownVis.pos[1]; this.lastOwnPos[2] = ownVis.pos[2]
      if (seat === 1) {
        rig.setMode("gunner")
        const z = input.zoomHeld ? Math.max(rig.gunZoom, 4) : rig.gunZoom
        const saved = rig.gunZoom
        rig.gunZoom = z
        const anchor = ownVis.view.anchors?.get(ownVis.kind === "apache" ? "turret_chin_barrel" : "targeting_pod_head")
        rig.gunner(dt, ownVis.kind, ownVis.pos, ownVis.quat, this.lookV, anchor ? anchor.getWorldPosition(_v2) : null)
        rig.gunZoom = saved
      } else if (direct) {
        rig.setMode(this.view)
        if (this.view === "cockpit") rig.cockpitBody(dt, ownVis.kind, ownVis.pos, ownVis.quat, input.lookYaw, input.lookPitch)
        else rig.chaseBody(dt, ownVis.kind, ownVis.pos, ownVis.flight.velocity, ownVis.quat, input.lookYaw, input.lookPitch, host.groundAt)
      } else {
        rig.setMode(this.view)
        if (this.view === "cockpit") rig.cockpit(dt, ownVis.kind, ownVis.pos, ownVis.quat, this.lookV)
        else rig.chase(dt, ownVis.kind, ownVis.pos, ownVis.flight.velocity, this.lookV, host.groundAt)
      }
    } else if (this.state === "dead" && now - this.deathAt < 3.5) {
      rig.setMode("death")
      rig.death(dt, this.deathPos, now - this.deathAt, host.groundAt)
    } else {
      if (this.state === "dead") this.enterSpawn()
      rig.setMode("orbit")
      const team = me?.team ?? 0
      const b = AIRBASES[team]
      rig.orbit(dt, b.center, 650, 170, 0.06)
    }
    rig.apply(dt)
    const cockpitNow = this.state === "flying" && seat === 0 && this.view === "cockpit"
    if (cockpitNow !== this.stormCockpit) { this.stormCockpit = cockpitNow; this.deps.audio?.setStorm({ enabled: true, rain: 1, cockpit: cockpitNow }) }

    if (latest) this.updateProjectiles(latest, est, dt)

    // Audio
    const audio = this.deps.audio
    if (audio) {
      const c = host.camera
      _v1.set(0, 0, -1).applyQuaternion(c.quaternion)
      _v2.set(0, 1, 0).applyQuaternion(c.quaternion)
      audio.setListener([c.position.x, c.position.y, c.position.z], [_v1.x, _v1.y, _v1.z], [_v2.x, _v2.y, _v2.z])
      audio.updateVehicles(this.renderList, myVehicle?.alive ? myVehicle.id : null)
    }

    // HUD + spawn screen
    if (latest) {
      this.updateHud(latest, ownVis, est)
      if (this.spawn.visible()) {
        this.spawn.update({ me, players: this.players, vehicles: latest.vehicles, time: latest.time, config: this.config, room: this.offline ? "OFFLINE" : this.room, dead: this.me ? this.me.deaths > 0 : false })
      }
    }
  }

  private onAction(a: ReturnType<Input["takeActions"]>[number]): void {
    switch (a) {
      case "seat1": this.send({ type: "switch-seat", seat: 0 }); break
      case "seat2": this.send({ type: "switch-seat", seat: 1 }); break
      case "view":
        this.view = this.view === "chase" ? "cockpit" : "chase"
        if (this.view === "chase" && this.deps.host.rig.zoom < 0.6) this.deps.host.rig.zoom = 1
        break
      case "chat":
        if (!this.hud.chatOpen()) this.hud.openChat(t => { if (t) this.send({ type: "chat", text: t }) })
        break
      case "menu":
        if (this.state === "flying" && !this.paused && !this.hud.chatOpen()) {
          this.paused = true
          this.input.setEnabled(false)
          const mv = this.myVehicle()
          this.pause.show(!!mv && VEHICLES[mv.kind].flight === "heli")
        }
        break
      default: break
    }
  }

  private buildRenderList(rt: number, dt: number): void {
    const list = this.renderList
    list.length = 0
    const latest = this.latest
    if (!latest) return
    const snaps = this.snaps
    let a: SnapEntry | null = null
    let b: SnapEntry | null = null
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].snap.time <= rt) { a = snaps[i]; b = snaps[i + 1] ?? null; break }
    }
    if (!a) a = snaps[0]
    const alpha = b ? Math.max(0, Math.min(1, (rt - a.snap.time) / Math.max(1e-6, b.snap.time - a.snap.time))) : 0
    const extra = b ? 0 : Math.max(0, Math.min(0.25, rt - a.snap.time))
    const myVeh = this.me?.vehicleId
    const mySeat = this.me?.seat

    for (const lv of latest.vehicles) {
      let vis = this.visuals.get(lv.id)
      if (!vis || vis.kind !== lv.kind || vis.team !== lv.team) {
        if (vis) this.removeVisual(vis)
        vis = this.addVisual(lv)
      }
      const r = vis.render
      Object.assign(r, lv)
      Object.assign(vis.flight, lv.flight)
      r.flight = vis.flight
      vis.flight.position = vis.pos
      vis.flight.orientation = vis.quat
      r.aim = [lv.aim[0], lv.aim[1]]

      const pr = this.pred
      if (pr && pr.vehicleId === lv.id) {
        const s = pr.state
        const tickAlpha = Math.min(1, Math.max(0, this.tickAcc / TICK_DT))
        const pp = pr.prevPos, pq = pr.prevQuat
        vis.pos[0] = pp[0] + (s.position[0] - pp[0]) * tickAlpha + pr.errPos.x
        vis.pos[1] = pp[1] + (s.position[1] - pp[1]) * tickAlpha + pr.errPos.y
        vis.pos[2] = pp[2] + (s.position[2] - pp[2]) * tickAlpha + pr.errPos.z
        _q1.set(pq[0], pq[1], pq[2], pq[3]).slerp(_q2.set(s.orientation[0], s.orientation[1], s.orientation[2], s.orientation[3]), tickAlpha).premultiply(pr.errQuat)
        vis.quat[0] = _q1.x; vis.quat[1] = _q1.y; vis.quat[2] = _q1.z; vis.quat[3] = _q1.w
        vis.flight.velocity = s.velocity
        vis.flight.angularVelocity = s.angularVelocity
        vis.flight.throttle = s.throttle
        vis.flight.onGround = s.onGround
        vis.flight.gearDown = s.gearDown
      } else {
        const va = a.byId.get(lv.id)
        const vb = b?.byId.get(lv.id)
        if (va && vb) {
          const pa = va.flight.position, pb = vb.flight.position
          vis.pos[0] = lerp(pa[0], pb[0], alpha); vis.pos[1] = lerp(pa[1], pb[1], alpha); vis.pos[2] = lerp(pa[2], pb[2], alpha)
          _q1.set(va.flight.orientation[0], va.flight.orientation[1], va.flight.orientation[2], va.flight.orientation[3])
          _q2.set(vb.flight.orientation[0], vb.flight.orientation[1], vb.flight.orientation[2], vb.flight.orientation[3])
          _q1.slerp(_q2, alpha)
          vis.quat[0] = _q1.x; vis.quat[1] = _q1.y; vis.quat[2] = _q1.z; vis.quat[3] = _q1.w
        } else {
          const src = va ?? lv
          const t = va ? extra : 0
          const pp = src.flight.position, vv = src.flight.velocity
          vis.pos[0] = pp[0] + vv[0] * t; vis.pos[1] = pp[1] + vv[1] * t; vis.pos[2] = pp[2] + vv[2] * t
          const o = src.flight.orientation
          vis.quat[0] = o[0]; vis.quat[1] = o[1]; vis.quat[2] = o[2]; vis.quat[3] = o[3]
        }
      }
      if (lv.id === myVeh && mySeat !== null && mySeat !== undefined && this.state === "flying") {
        r.aim[mySeat] = [this.aim[0], this.aim[1], this.aim[2]]
      }
      list.push(r)
    }
    for (const [id, vis] of this.visuals) if (!this.latestById.has(id)) { this.removeVisual(vis); this.visuals.delete(id) }
  }

  private addVisual(lv: VehicleEntity): Visual {
    const host = this.deps.host
    const view = createAircraftView(lv.kind, lv.team, host.quality)
    view.root.name = `vehicle-${lv.id}`
    host.scene.add(view.root)
    const flight = { ...lv.flight }
    const vis: Visual = {
      id: lv.id, kind: lv.kind, team: lv.team, view,
      render: { ...lv, flight }, flight,
      pos: [...lv.flight.position], quat: [...lv.flight.orientation],
    }
    this.visuals.set(lv.id, vis)
    return vis
  }

  private removeVisual(v: Visual): void {
    this.deps.host.scene.remove(v.view.root)
    v.view.dispose()
  }

  private updateProjectiles(s: Snapshot, est: number, dt: number): void {
    const fx = this.deps.host.effects
    const myVeh = this.me?.vehicleId
    const rtRemote = est - INTERP_DELAY - s.time
    const rtOwn = est + this.rtt / 1000 - s.time
    const proj = s.projectiles
    const colors = this.tracerColors
    fx.setTracers(proj.length, (i, pos, dir, col) => {
      const pr = proj[i]
      const t = Math.max(-0.2, pr.vehicle === myVeh ? rtOwn : rtRemote)
      const v = pr.velocity
      const sp = Math.hypot(v[0], v[1], v[2]) || 1
      const len = Math.min(45, sp * 0.04) / sp
      const age = Math.max(0, pr.age + t)
      const short = Math.min(1, age * 20)
      pos[i * 3] = pr.position[0] + v[0] * t
      pos[i * 3 + 1] = pr.position[1] + v[1] * t
      pos[i * 3 + 2] = pr.position[2] + v[2] * t
      dir[i * 3] = v[0] * len * short; dir[i * 3 + 1] = v[1] * len * short; dir[i * 3 + 2] = v[2] * len * short
      const c = colors[pr.team] ?? colors[0]
      col[i * 3] = c.r * 1.6; col[i * 3 + 1] = c.g * 1.6; col[i * 3 + 2] = c.b * 1.6
    })
    const ms = s.missiles
    const mp: Vec3 = [0, 0, 0]
    fx.setMissiles(ms.length, (i, m) => {
      const mi = ms[i]
      const t = Math.max(-0.2, mi.vehicle === myVeh ? rtOwn : rtRemote)
      mp[0] = mi.position[0] + mi.velocity[0] * t
      mp[1] = mi.position[1] + mi.velocity[1] * t
      mp[2] = mi.position[2] + mi.velocity[2] * t
      _v1.set(mp[0], mp[1], mp[2])
      _v2.set(mp[0] - mi.velocity[0], mp[1] - mi.velocity[1], mp[2] - mi.velocity[2])
      m.lookAt(_v2, _v1, UP)
      m.setPosition(_v1)
      fx.trail(mi.id, mp, WEAPONS[mi.weapon].kind !== "rockets")
    })
    for (const f of s.flares) {
      const t = Math.max(-0.2, rtRemote)
      mp[0] = f.position[0] + f.velocity[0] * t
      mp[1] = f.position[1] + f.velocity[1] * t
      mp[2] = f.position[2] + f.velocity[2] * t
      fx.flare(mp, dt)
    }
    // Damage smoke from burning airframes
    for (const v of this.renderList) {
      if (!v.alive) continue
      const vis = this.visuals.get(v.id)!
      const hp = v.hp / v.maxHp
      if (hp < 0.45) fx.damageSmoke(vis.pos, v.flight.velocity, 1 - hp / 0.45, dt)
    }
  }

  /** Radar officer scanner: range to the target under the reticle + semi-active guidance status. */
  private updateScanner(f: HudFrame, s: Snapshot, v: VehicleEntity, pos: Vec3, spec: (typeof WEAPONS)[keyof typeof WEAPONS]): void {
    const aim = this.aim
    const cone = spec.lockCone ?? 0.12
    let best = Infinity
    for (const o of this.renderList) {
      if (!o.alive || o.team === v.team) continue
      const op = this.posOfVehicle(o.id) ?? o.flight.position
      const dx = op[0] - pos[0], dy = op[1] - pos[1], dz = op[2] - pos[2]
      const d = Math.hypot(dx, dy, dz)
      if (d < 1) continue
      const c = (dx * aim[0] + dy * aim[1] + dz * aim[2]) / d
      if (c > Math.cos(cone * 2) && d < best) best = d
    }
    f.scannerRange = Number.isFinite(best) ? best : null
    for (const m of s.missiles) {
      if (m.vehicle !== v.id || WEAPONS[m.weapon].kind !== "missile_scanner") continue
      const speed = Math.hypot(m.velocity[0], m.velocity[1], m.velocity[2]) || spec.speed
      const tp = m.target ? this.posOfVehicle(m.target) : null
      let onTarget = false
      let tti: number | null = null
      if (tp) {
        const dx = tp[0] - pos[0], dy = tp[1] - pos[1], dz = tp[2] - pos[2]
        const d = Math.hypot(dx, dy, dz) || 1
        onTarget = (dx * aim[0] + dy * aim[1] + dz * aim[2]) / d >= Math.cos(cone)
        tti = Math.hypot(tp[0] - m.position[0], tp[1] - m.position[1], tp[2] - m.position[2]) / speed
      }
      f.guide = { missile: [m.position[0], m.position[1], m.position[2]], tti, lost: !onTarget }
      break
    }
  }

  private updateHud(s: Snapshot, ownVis: Visual | undefined, est: number): void {
    const f = this.hudFrame
    const me = this.me
    const v = ownVis && ownVis.render.alive && this.state === "flying" ? ownVis.render : null
    const seat = (me?.seat ?? null) as SeatIndex | null
    f.time = s.time
    f.me = me
    f.vehicle = v
    f.seat = seat
    f.scores = s.scores
    f.remaining = typeof s.matchEndsAt === "number" ? Math.max(0, s.matchEndsAt - s.time) : null
    f.intermission = !!s.intermission
    f.freeLook = this.input.freeLook
    f.ping = this.offline ? 0 : this.rtt
    f.lead = null
    f.lockTarget = null
    f.lockProgress = 0
    f.missileWarning = false
    f.weapons.length = 0
    f.seekerCone = 0
    f.seekerCenter = null
    f.scanner = false
    f.scannerRange = null
    f.guide = null
    f.hint = null
    f.cockpit = this.view === "cockpit" && seat === 0
    f.zoom = this.input.zoomHeld ? Math.max(this.deps.host.rig.gunZoom, 4) : this.deps.host.rig.gunZoom
    if (!v || !ownVis || seat === null) { this.deps.host.setSpeedFx(0, false); this.hud.update(f); return }

    const pos = ownVis.pos
    const ro = flightReadout(this.pred?.state ?? v.flight)
    f.speed = ro.speed
    f.altitude = pos[1]
    const fwd = forward(ownVis.quat)
    f.heading = ((Math.atan2(fwd[0], -fwd[2]) * 180) / Math.PI + 360) % 360
    f.throttle = (this.pred?.state ?? v.flight).throttle
    f.boost = this.sentFlight.boost
    if (this.spawnedVeh !== v.id) { this.spawnedVeh = v.id; this.spawnedAt = v.spawnedAt ?? s.time }
    const protLeft = SPAWN_PROTECTION - (s.time - (v.spawnedAt ?? this.spawnedAt))
    f.protected = protLeft > 0
    f.protectedLeft = Math.max(0, protLeft)
    // Enemy fleet anti-air umbrella: nearest enemy ship, and whether its guns are on us right now.
    let nearShip = Infinity
    for (const sh of posedFleet()) {
      if (sh.team === v.team) continue
      const d = Math.hypot(pos[0] - sh.position[0], pos[1] - sh.position[1], pos[2] - sh.position[2])
      if (d < nearShip) nearShip = d
    }
    f.aaDist = nearShip < AA_RANGE * 1.1 ? nearShip : null
    f.aaFire = performance.now() / 1000 - this.aaFiredAt < 0.6
    const aimDist = 1500
    f.direct = seat === 0 && this.input.mouseMode === "direct"
    f.aimPoint = f.direct ? null : [pos[0] + this.aim[0] * aimDist, pos[1] + this.aim[1] * aimDist, pos[2] + this.aim[2] * aimDist]
    const boreDir = seat === 0 ? fwd : (v.aim[1] ?? this.aim)
    let boreDist = aimDist

    // Weapons readout
    const kinds = VEHICLES[v.kind].seatWeapons[seat]
    const runtime = v.weapons[seat] ?? []
    const dup = kinds[0] !== null && kinds[0] === kinds[1]
    let n = 0
    for (let i = 0; i < 2; i++) {
      const id = kinds[i]
      if (!id || (dup && i === 1)) continue
      const spec = WEAPONS[id]
      const w = this.weaponsBuf[n++]
      const rtw = runtime[i]
      w.id = id
      w.keys = spec.kind === "pulse" ? (i === 1 ? "RMB · R" : "LMB · R") : dup ? "LMB RMB" : i === 0 ? "LMB" : "RMB"
      w.cap = spec.ammo
      w.ammo = rtw ? rtw.ammo : spec.ammo
      const reload = spec.kind === "gun" || spec.kind === "rockets" ? 0 : 1 / spec.rate
      w.ready = !rtw || reload <= 0 ? 1 : Math.max(0, Math.min(1, 1 - (rtw.readyAt - s.time) / reload))
      const lastShot = rtw ? rtw.readyAt - 1 / spec.rate : -Infinity
      w.regen = spec.ammo > 0 && w.ammo < spec.ammo && s.time - lastShot > spec.refillDelay
      w.lock = rtw?.lock ?? 0
      w.locked = w.lock >= 1
      if (spec.kind === "pulse") w.ready = Math.max(0, Math.min(1, 1 - (v.abilityReadyAt - s.time) / (1 / spec.rate)))
      f.weapons.push(w)
      if (rtw?.lockTarget && rtw.lock > f.lockProgress) {
        const tp = this.posOfVehicle(rtw.lockTarget)
        if (tp) { f.lockTarget = tp; f.lockProgress = rtw.lock }
      }
      // Seeker cone (lock-on missiles) around the boresight / seat aim.
      if (spec.kind === "missile_lock" && spec.lockCone && w.ammo !== 0) f.seekerCone = spec.lockCone
      if (spec.kind === "missile_scanner") {
        f.scanner = true
        f.scannerCone = spec.lockCone ?? 0.12
        this.updateScanner(f, s, v, pos, spec)
      }
    }
    if (n === 0) f.hint = "look at enemies to spot them for your team"
    const audio = this.deps.audio
    if (f.lockProgress >= 1) audio?.ui("locked")
    else if (f.lockProgress > 0) audio?.ui("lock-tone")

    // Gun lead on the best target near the boresight
    const gunId = kinds.find(k => k && WEAPONS[k].kind === "gun") ?? null
    const gun = gunId ? WEAPONS[gunId] : null
    if (gun) {
      let best: VehicleEntity | null = null
      let bestScore = Math.cos(0.4)
      let bestDist = 0
      for (const o of this.renderList) {
        if (!o.alive || o.team === v.team) continue
        const op = o.flight.position
        const dx = op[0] - pos[0], dy = op[1] - pos[1], dz = op[2] - pos[2]
        const d = Math.hypot(dx, dy, dz)
        if (d > 2200 || d < 20) continue
        const c = (dx * boreDir[0] + dy * boreDir[1] + dz * boreDir[2]) / d
        if (c > bestScore) { bestScore = c; best = o; bestDist = d }
      }
      if (best) {
        const own = (this.pred?.state ?? v.flight).velocity
        const tv = best.flight.velocity
        const tp = best.flight.position
        let t = bestDist / gun.speed
        const lead: Vec3 = [0, 0, 0]
        for (let k = 0; k < 2; k++) {
          lead[0] = tp[0] + (tv[0] - own[0]) * t
          lead[1] = tp[1] + (tv[1] - own[1]) * t
          lead[2] = tp[2] + (tv[2] - own[2]) * t
          t = Math.hypot(lead[0] - pos[0], lead[1] - pos[1], lead[2] - pos[2]) / gun.speed
        }
        f.lead = lead
        boreDist = bestDist
      }
    }
    f.borePoint = [pos[0] + boreDir[0] * boreDist, pos[1] + boreDir[1] * boreDist, pos[2] + boreDir[2] * boreDist]
    f.seekerCenter = f.seekerCone > 0 ? (seat === 0 ? [pos[0] + fwd[0] * 1500, pos[1] + fwd[1] * 1500, pos[2] + fwd[2] * 1500] : f.aimPoint) : null

    for (const m of s.missiles) if (m.target === v.id && m.team !== v.team) { f.missileWarning = true; break }
    if (f.missileWarning) audio?.ui("warning")

    this.deps.host.setSpeedFx(seat === 0 ? f.speed * 3.6 : 0, seat === 0 && f.boost)
    this.deps.host.setFocus(pos)
    this.hud.update(f)
  }
}
