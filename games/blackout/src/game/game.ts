import { CLAYMORE, DT, EQUIP_LOCK, FRAG, GUNS, SPEED, SPRINT_SPEED, SPRINT_TO_FIRE, type Equip, type Gun, type Weapon } from "../../shared/config"
import { type Rect, raycast } from "../../shared/geom"
import { type MapDef, getMap } from "../../shared/maps"
import { type Obstacles, obstaclesOf } from "../../shared/sim/gear"
import { type Body, stepBody } from "../../shared/sim/move"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import { type Intent, type SimEvent, bulletSpread } from "../../shared/sim/world"
import type { Sound } from "../audio/sound"
import type { Camera } from "../render/camera"
import { bakeBounce, buildLevel, type FloorMap } from "../render/level-mesh"
import { AMBIENT, type Caster, type DynLight, LightCuller } from "../render/lighting"
import { MAT, Mesh } from "../render/mesh"
import { PAL, deskMonitorLights, hex } from "../render/models"
import { cameraShakeSettings, juiceSettings, lookMask, type Juice } from "../ui/debug-overlay"
import { gearModels } from "../render/gear"
import { HOLD, MUZZLE, SHOULDER, personModels } from "../render/person"
import { wizardModels } from "../render/wizard"
import { castleMap } from "../render/castle"
import { type Avatar, EV, type PartModels, type PushPart, animate, fire as shoot, glow, gunPoints, hit, newAvatar, pose, swing, useGear } from "./anim"
import { type Corpse, type DeathStyle, type Debris, deathStyle, ragdoll } from "./ragdoll"
import { type Batch, type FrameInput, INST_FLOATS, type Renderer, SPRITE_FLOATS } from "../render/renderer"
import { MotionKeys, type MotionKey } from "../render/motion"
import { FRAME_FLOATS } from "../render/shaders"
import type { Input, MuxState } from "./input"
import type { Session } from "./session"
import { Smoothed } from "./smooth"
import { Predictor } from "@arcade/kit/net/prediction"
import { Glide, type RemoteSample, pushSnapshot, remoteBuffer, sampleRemote, soldierAt } from "./remote"
import { TEAM_COLORS, canUse, modeSprites, teamOf } from "./mode-fx"
import { objectiveBanner } from "./objective-fx"
import { type Kit, gunKit, kitSprints } from "../../shared/sim/kit"
import { MELEE } from "../../shared/sim/melee"
import { MODES } from "../../shared/sim/modes"
import { INF_COLORS, eyes, infected } from "./rules-fx"
import { carries, slowCarrier } from "../../shared/sim/modes-objective"
import { forwardSpeed, lateralSpeed } from "../../shared/sim/vehicle"
import { VehicleSound } from "../audio/vehicle-sound"
import { FLOOR } from "../render/vehicle-mesh"
import { type FxFn, type VehDraw, VehicleFx, carry } from "./vehicles"
import { mapFires } from "./map-fx"
import { SmokeVolumes, type Wall } from "@arcade/kit/fx/volume"
import { Particles } from "@arcade/kit/fx/particles"
import {
  EXPLOSION_PRESETS,
  explosionFlashLight,
  spawnExplosion,
  type ExplosionPresetId,
} from "@arcade/kit/fx/explosion"
import { blackoutEffects as fxSettings } from "../lab/settings"
import { Splatter, type SplatterImpact, type SplatterSettings } from "@arcade/kit/fx/splatter"
import { blackoutSplatterSurfaces, bloodSplatterSettings } from "./splatter"
import { castleHall } from "../../shared/maps/castle-hall"
import { spellConfig, type SpellId } from "../../shared/sim/spell-config"
import { SpellFx } from "./spell-fx"
import { skeletonModels } from "../render/skeleton"
import {
  CLAY_SCALE,
  emitGearParts,
  emitGearSprites,
  stepAndEmitCombatFx,
  type Boom,
  type BulletHole,
  type Flash,
  type FlashFx,
  type FragFx,
  type LooseSheet,
  type Monitor,
  type Particle,
  type Rgb3,
  type Tracer,
} from "./combat-fx"
import { SandboxSession } from "./sandbox-session"

export { SandboxSession, type Rgb3 }
const PALETTE: Rgb3[] = [
  [1.0, 0.38, 0.08],
  [0.08, 0.72, 1.0],
  [0.95, 0.85, 0.2],
  [0.75, 0.32, 1.0],
  [0.3, 1.0, 0.5],
  [1.0, 0.3, 0.55],
  [0.92, 0.92, 0.92],
  [0.4, 0.5, 1.0],
  [1.0, 0.6, 0.3],
  [0.3, 0.9, 0.9],
  [0.7, 1.0, 0.3],
  [1.0, 0.45, 0.85],
]
export const css = (c: Rgb3) => `rgb(${c.map((v) => Math.round(Math.min(1, v) * 255)).join(",")})`

const HIT_POWER: Record<Gun, number> = { rifle: 0.8, shotgun: 0.3, sniper: 1.8 }
/** Camera recoil per gun: shove along the aim, shake, zoom punch and a little roll. */
const CAM_RECOIL: Record<Gun, { kick: number; shake: number; punch: number; roll: number }> = {
  rifle: { kick: 3, shake: 0.16, punch: 0.3, roll: 0.006 },
  shotgun: { kick: 8, shake: 0.5, punch: 1.2, roll: 0.016 },
  sniper: { kick: 10, shake: 0.6, punch: 1.6, roll: 0.02 },
}
export type FeedLine = { killer: string; victim: string; kc: Rgb3; vc: Rgb3; how: Weapon; t: number; mine: boolean }
/** Blasts throw bodies hard, up and away. */
const blastStyle = (): DeathStyle => ({ push: 7 + Math.random() * 2, lift: 2.6 + Math.random(), spin: (Math.random() - 0.5) * 3, buckle: 0.2 })

/**
 * The match as this client sees it: predicted own body and own gunfire, smoothed and animated soldiers, effects,
 * and the per-frame GPU data.
 */
export class Game {
  /** Lab override is instance-local. Null follows the production review switch. */
  splatterStyle:number|null=null
  splatterFx:Splatter|undefined
  private splatterEvent=0
  /** Animation can pass stable event/limb IDs plus detached world pose and velocity here. */
  cosmeticSplatter(event:SplatterImpact,settings:SplatterSettings=bloodSplatterSettings):boolean {
    if(!(this.splatterStyle??bloodSplatterSettings.style))return false
    this.splatterFx??=new Splatter(blackoutSplatterSurfaces(buildLevel(this.map)))
    return this.splatterFx.emit(event,settings)
  }
  readonly smokeVolumes: SmokeVolumes
  readonly explosionParticles: Particles
  private readonly ownsFx: boolean
  private wallRects: Wall[] = []
  readonly juice: Juice
  private bounceBase!: FloorMap
  private bounceFull!: FloorMap
  private bounceIntensity = -1
  private monitors: Monitor[] = []
  private propHitAt = new Map<number, number>()
  private sheets: LooseSheet[] = []
  private electric: { x: number; y: number; t0: number }[] = []
  private sheetModels: { paper: number; glass: number; brass: number; screen: number }
  private labFireMap:MapDef|null=null
  map: MapDef
  blockers: Rect[] = []
  solids: Rect[] = []
  obstacles: Obstacles = { rects: [], h: [] }
  body: Body | null = null
  /** What Space would do right now, for the HUD prompt and the surface highlight. */
  /** The predicted body as drawn, smooth between ticks and corrections; the camera follows this. */
  readonly drawn = new Smoothed()
  aim = 0
  cursor = { x: 0, y: 0 }
  snap: Snapshot | null = null
  roster: RosterRow[] = []
  avatars = new Map<string, Avatar>()
  corpses: Corpse[] = []
  feed: FeedLine[] = []
  /** Last hitmarker and kill-confirm times (seconds), for the HUD. */
  hitAt = -10
  killAt = -10
  banner: { text: string; t: number } | null = null
  /** Crosshair spread from recent firing, 0..1. */
  bloom = 0
  hurt = 0
  // Local weapon prediction.
  gun: Gun = "rifle"
  /** What the mode armed you with (from the snapshot); prediction follows its rules. */
  kit: Kit = gunKit("rifle")
  /** Predicted melee: the next swing can start at swingReady; shots wait until the current one lands at swingLand. */
  private swingReady = 0
  private swingLand = 0
  mag = 0
  equip: Equip = "frag"
  equipLeft = 0
  /** The cursor on the floor, for the throw distance. */
  ground = { x: 0, y: 0 }
  private lastEquip = -10
  private grenades = new Map<number, FragFx>()
  /** When each tripped claymore beeped. */
  private trips = new Map<number, number>()
  private booms: Boom[] = []
  reloadUntil = 0
  private cooldownUntil = 0
  private readyAt = 0
  private lastLocalShot = -10
  private triggerHeld = false
  private wasAlive = false
  /** Your inputs the server hasn't acknowledged yet, replayed on every snapshot. */
  private predictor = new Predictor<Intent>()
  /** Recent snapshots: remote soldiers and vehicles are drawn between the two around now − delay. */
  private remote = remoteBuffer()
  private bracket: RemoteSample | null = null
  private glides = new Map<string, Glide>()
  private acc = 0
  private now = 0
  private tracers: Tracer[] = []
  private particles: Particle[] = []
  private flashes: Flash[] = []
  private debris: Debris[] = []
  private flashFx: FlashFx[] = []
  /** Bullet holes in walls: where, facing, height, when. */
  private holes: BulletHole[] = []
  /** Hit-stop: animation and effects crawl until this time after a kill. */
  private freezeUntil = 0
  private hitSoundAt = -1
  private soundAt = new Map<string, number>()
  private models: PartModels
  private soldierParts: PartModels
  private wizardParts: PartModels
  private spellFx: SpellFx
  private spellTuning = ""
  selectedSpell: SpellId = "moon"
  private sourceMap!: MapDef
  private wizardLook = false
  private gear: { frag: number; claymore: number; led: number }
  private frame = new Float32Array(FRAME_FLOATS)
  private culler = new LightCuller()
  private inst = new Float32Array(2048 * INST_FLOATS)
  private motionKeys = new MotionKeys()
  private spriteKeys = new MotionKeys()
  private addMotionKeys: (MotionKey | undefined)[] = []
  private add = new Float32Array(4096 * SPRITE_FLOATS)
  private alpha = new Float32Array(2048 * SPRITE_FLOATS)
  private nAdd = 0
  private nAlpha = 0
  /** Vehicles as drawn, and the one you drive predicted (./vehicles.ts); their engines, skids and horns. */
  veh!: VehicleFx
  private vsound!: VehicleSound
  /** The vehicle and seat you're in (from the server), or null on foot. */
  riding: { veh: number; seat: number } | null = null
  /** The vehicle F would get you into right now, for the HUD prompt. */
  vehiclePrompt: VehDraw | null = null
  /** Each rider's seat pose last frame, so their planted feet ride along. */
  private seatPose = new Map<string, { x: number; y: number; h: number }>()
  private fxv: FxFn = (x, y, z, vx, vy, vz, life, size, kind) => this.fx(x, y, z, vx, vy, vz, life, size, kind)

  constructor(
    private renderer: Pick<Renderer, "addModel" | "setLevel" | "updateBounce" | "width" | "height">,
    private session: Session,
    private sound: Sound,
    settings: Juice = juiceSettings(),
    initialMap: MapDef = getMap("office", 1),
    sharedFx?: { particles: Particles; volumes: SmokeVolumes },
  ) {
    this.juice = settings
    this.smokeVolumes = sharedFx?.volumes ?? new SmokeVolumes()
    this.explosionParticles = sharedFx?.particles ?? new Particles()
    this.ownsFx = !sharedFx
    const reg = (m: Parameters<Renderer["addModel"]>[0]) => renderer.addModel(m)
    const paper = new Mesh()
    paper.box(-0.1, -0.003, -0.14, 0.1, 0.003, 0.14, PAL.paper, MAT.lit, 0, undefined, true)
    const glass = new Mesh()
    glass.facet([-0.035, 0, -0.1], [0.07, 0, 0.025], [-0.035, 0.007, 0.1], hex(0xb4f4ff), MAT.shiny)
    glass.facet([-0.035, 0.007, 0.1], [0.07, 0, 0.025], [-0.035, 0, -0.1], hex(0xd7ffff), MAT.shiny)
    const brass = new Mesh()
    brass.prism(0, 0, 0.018, 0.018, -0.035, 0.035, 6, hex(0xe8b84e), MAT.shiny)
    const screen = new Mesh()
    screen.box(-0.252, 0.86, 0.023, 0.252, 1.142, 0.028, PAL.screenOff)
    this.sheetModels = { paper: reg(paper), glass: reg(glass), brass: reg(brass), screen: reg(screen) }
    const regGuns = (r: ReturnType<typeof personModels>["gun"]) => ({ rifle: reg(r.rifle), shotgun: reg(r.shotgun), sniper: reg(r.sniper) })
    const register = (p: ReturnType<typeof personModels>): PartModels => ({
      pelvis: reg(p.pelvis),
      torso: reg(p.torso),
      head: reg(p.head),
      upperArm: reg(p.upperArm),
      foreArm: reg(p.foreArm),
      thigh: reg(p.thigh),
      shin: reg(p.shin),
      foot: reg(p.foot),
      toe: reg(p.toe),
      pump: reg(p.pump),
      gun: regGuns(p.gun),
      mag: regGuns(p.mag),
      casing: regGuns(p.casing),
      hole: reg(p.hole),
    })
    this.soldierParts = register(personModels())
    this.wizardParts = register(wizardModels())
    this.spellFx = new SpellFx(renderer, register(skeletonModels()))
    this.models = this.soldierParts
    const gm = gearModels()
    this.gear = { frag: reg(gm.frag), claymore: reg(gm.claymore), led: reg(gm.led) }
    this.veh = new VehicleFx(renderer)
    this.vsound = new VehicleSound(sound)
    this.veh.onPop = d => { if (this.juice.vehicleAudio) this.vsound.pop(d.id) }
    this.map = initialMap
    this.load(this.map)
  }

  private load(map: MapDef): void {
    this.splatterFx=undefined
    this.sourceMap = map
    this.applyLook()
    this.blockers = [...map.walls.map((w) => w.rect), ...map.windows, ...map.glass]
    this.solids = [...this.blockers, ...map.props.filter((p) => p.solid).map((p) => p.rect)]
    this.obstacles = obstaclesOf(map)
    this.clearScene()
  }

  /** Rebuild static presentation only when the lab switch changes; preserve live actors and simulation. */
  private applyLook(): void {
    this.wizardLook = this.juice.wizards || this.sourceMap.id === "castle-hall"
    this.models = this.wizardLook ? this.wizardParts : this.soldierParts
    const castle = this.wizardLook && this.sourceMap.kind === "office"
    const map = this.map = castle ? castleMap(this.sourceMap) : this.sourceMap
    const dynamic = map.id === "castle-hall"
    if (dynamic) this.spellFx.setMap(map)
    const staticMap = dynamic ? { ...map, props: [] } : map
    const level = buildLevel(staticMap, castle)
    this.splatterFx = new Splatter(blackoutSplatterSurfaces(level))
    this.bounceFull = level.bounce
    this.bounceBase = bakeBounce(map, 0)
    this.bounceIntensity = -1
    this.renderer.setLevel(level)
    this.culler.setMap(staticMap)
    this.culler.torchFlicker = castle
    this.monitors = deskMonitorLights(map).map(({ x, y, yaw }) => ({ x, y, yaw, broken: false }))
  }

  /** Drops everything left over from the last match: bodies, tracers, frags, blasts. */
  private clearScene(): void {
    this.splatterFx?.reset();this.splatterEvent=0
    this.cam?.resetShake()
    this.labFireMap=null
    this.wallRects = [...this.map.walls.filter(w => w.h >= 1.8).map(w => w.rect), ...this.map.windows, ...this.map.glass]
    this.smokeVolumes.reset(this.wallRects)
    this.explosionParticles.reset()
    this.corpses = []
    this.tracers = []
    this.particles = []
    this.body = null
    this.predictor.reset()
    this.wasAlive = false
    this.grenades.clear()
    this.trips.clear()
    this.booms = []
    this.veh?.clear()
    this.riding = null
    this.seatPose.clear()
    this.debris = []
    this.sheets = []
    this.electric = []
    for (const monitor of this.monitors) monitor.broken = false
    this.propHitAt.clear()
    this.flashFx = []
    this.holes = []
  }

  get myId(): string {
    return this.session.myId
  }

  get alive(): boolean {
    return !!this.snap && this.snap.phase === "play" && !!this.snap.players.find((p) => p.id === this.myId)?.alive
  }

  /** Team colour in team modes, else the palette by roster position. */
  colorOf(id: string): Rgb3 {
    const team = teamOf(this.snap, this.roster, id)
    if (team >= 0 && this.snap?.mode.id === "inf") return INF_COLORS[team === 1 ? 1 : 0]
    if (team >= 0) return TEAM_COLORS[team]!
    const i = this.roster.findIndex((r) => r.id === id)
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length]!
  }

  nameOf(id: string): string {
    return this.roster.find((r) => r.id === id)?.name ?? ""
  }

  get health(): number {
    return this.snap?.you?.health ?? 0
  }

  get lightCount(): number { return this.culler.lightCount }

  muxState(): MuxState | null {
    return this.body ? { ...this.body, aim: this.aim, tx: this.ground.x, ty: this.ground.y } : null
  }

  sync(state: MuxState, reconcileWorld = true): void {
    this.place({ x: state.x, y: state.y, vx: state.vx, vy: state.vy })
    this.aim = state.aim
    this.ground = { x: state.tx, y: state.ty }
    this.cursor = { x: state.tx, y: state.ty }
    this.predictor.reset()
    if (reconcileWorld && this.session instanceof SandboxSession) this.session.sync(state)
  }

  // Network ----------------------------------------------------------------------------------------------------

  private ingest(): void {
    const l = this.session.latest()
    if (l && l.snap !== this.snap) {
      const s = l.snap
      // Practice on a fixed test map (?practice&map=lot): load that rather than generating one from the seed.
      const fixed = this.session.fixedMap?.()
      if (fixed && fixed !== this.sourceMap) this.load(fixed)
      if (s.map !== this.map.seed || s.mapKind !== this.map.kind || (s.mode.id === "wizards") !== (this.sourceMap.id === "castle-hall")) this.load(s.mode.id === "wizards" ? castleHall(s.map) : getMap(s.mapKind ?? "office", s.map))
      else if (this.snap && s.match !== this.snap.match) this.clearScene()
      for (const p of s.players) {
        if (p.id === this.myId) continue
        let a = this.avatars.get(p.id)
        if (!a) {
          a = newAvatar(p.id, p.x, p.y, p.aim, p.gun)
          a.alive = p.alive
          this.avatars.set(p.id, a)
        }
        // Teleport on respawn rather than sliding across the map.
        if (p.alive && (!a.alive || Math.hypot(p.x - a.x, p.y - a.y) > 4)) {
          a.x = p.x
          a.y = p.y
          this.corpses = this.corpses.filter((c) => c.id !== p.id)
        }
        a.tx = p.x
        a.ty = p.y
        a.tvx = p.vx
        a.tvy = p.vy
        a.aim = p.aim
        a.gun = p.gun
        a.bare = !!p.bare && !s.spells
        a.alive = p.alive
      }
      for (const id of [...this.avatars.keys()]) if (!s.players.some((p) => p.id === id)) {
        this.avatars.delete(id)
        this.glides.delete(id)
      }
      pushSnapshot(this.remote, s, this.now)
      this.veh.ingest(s, this.now)
      const mine = s.players.find((p) => p.id === this.myId)
      if (mine) this.reconcile(s, mine)
      if (s.spells) this.solids = [...this.blockers, ...s.spells.props.filter(p => this.sourceMap.props[p.id]?.solid && p.h < 0.2).map(p => { const r=this.sourceMap.props[p.id]!.rect, hw=(r[2]-r[0])/2,hd=(r[3]-r[1])/2; return [p.x-hw,p.y-hd,p.x+hw,p.y+hd] as Rect })]
      this.syncGrenades(s)
      this.snap = s
    }
    this.roster = this.session.roster()
    for (const e of this.session.drainEvents()) this.event(e)
  }

  /** Adopts frags we missed the throw of, corrects drift, and drops ones the server no longer has. */
  private syncGrenades(s: Snapshot): void {
    const live = new Set<number>()
    for (const g of s.grenades) {
      live.add(g.id)
      const f = this.grenades.get(g.id)
      if (!f) this.grenades.set(g.id, { ...g, at: this.now + g.fuse, spin: 0, yaw: Math.random() * 6.28 })
      else if (Math.hypot(f.x - g.x, f.y - g.y, f.z - g.z) > 0.5) Object.assign(f, { x: g.x, y: g.y, z: g.z, vx: g.vx, vy: g.vy, vz: g.vz })
    }
    for (const [id, f] of this.grenades) if (!live.has(id) && f.at - this.now < FRAG.fuse - 0.3) this.grenades.delete(id)
    for (const id of this.trips.keys()) if (!s.claymores.some((c) => c.id === id)) this.trips.delete(id)
  }

  private reconcile(s: Snapshot, mine: Snapshot["players"][number]): void {
    const you = s.you
    if (mine.alive && !this.wasAlive) {
      this.arm(you?.kit ?? gunKit(mine.gun))
      this.readyAt = 0
      if (you) {
        this.equip = you.equip
        this.equipLeft = you.equipLeft
      }
      this.place({ x: mine.x, y: mine.y, vx: 0, vy: 0 })
      this.predictor.reset()
      this.corpses = this.corpses.filter((c) => c.id !== this.myId)
    }
    this.wasAlive = mine.alive
    if (!mine.alive) {
      this.riding = null
      this.veh.pred = null
      this.place({ x: mine.x, y: mine.y, vx: 0, vy: 0 })
      return
    }
    // The mode re-armed you mid-life (a gun game kill, turning infected): swap at once, with the raise.
    if (you && you.kit.id !== this.kit.id) {
      this.arm(you.kit)
      this.readyAt = this.now + 0.3
      this.avatarMe.raiseAt = this.now
    }
    const was = this.riding
    this.riding = mine.veh ? { veh: mine.veh, seat: mine.seat ?? 0 } : null
    const riding = this.riding
    if (riding) {
      // Riding, the vehicle carries you. Driving, your inputs drive it: replay them on the server's vehicle.
      this.predictor.reconcile(s.ack - 1, () => {}, () => {})
      if (riding.seat === 0) this.veh.reconcile(riding.veh, this.predictor.unacked.map((p) => ({ i: p.cmd })), this.solids)
      else this.veh.pred = null
    } else {
      if (was) this.veh.pred = null
      const b: Body = { x: mine.x, y: mine.y, vx: mine.vx, vy: mine.vy }
      const forced = !!s.spells?.forced.includes(this.myId)
      this.predictor.reconcile(s.ack - 1, () => {}, (i) => {
        if (forced) return
        stepBody(b, i.mx, i.my, kitSprints(i, this.kit) ? this.kit.run : this.kit.walk, this.solids, DT)
        this.veh.pushOut(b)
      })
      // Adopt the replayed state exactly; a small correction is smoothed out of the drawn position, a big one snaps.
      if (!was && this.body && Math.hypot(b.x - this.body.x, b.y - this.body.y) < 1.5) {
        this.drawn.correct(b.x - this.body.x, b.y - this.body.y)
        Object.assign(this.body, b)
      } else this.place(b)
    }
    if (you) {
      if (you.reloading > 0 && this.reloadUntil <= this.now) this.reloadUntil = this.now + you.reloading
      if (this.now - this.lastLocalShot > 0.6 && this.reloadUntil <= this.now) this.mag = you.mag
      if (this.now - this.lastEquip > 0.6) {
        this.equip = you.equip
        this.equipLeft = you.equipLeft
      }
    }
  }

  private arm(kit: Kit): void {
    if (kit.id === "claws" && this.kit.id !== "claws") this.banner = { text: "YOU'RE INFECTED", t: this.now }
    this.kit = kit
    if (kit.gun) this.gun = kit.gun
    this.mag = kit.mag
    this.reloadUntil = 0
    this.swingLand = 0
  }

  private place(b: Body): void {
    this.body = b
    this.drawn.reset(b)
  }

  private event(e: SimEvent): void {
    const t = this.now
    const me = this.body
    switch (e.k) {
      case "shot": {
        const dir = Math.atan2(e.y1 - e.y0, e.x1 - e.x0)
        const victim = e.hit ? (e.hit === this.myId ? this.avatarMe : this.avatars.get(e.hit)) : undefined
        if (victim) {
          const by = e.by === this.myId ? this.gun : (this.avatars.get(e.by)?.gun ?? "rifle")
          hit(victim, Math.cos(dir), Math.sin(dir), HIT_POWER[by])
          this.blood(e.x1, e.y1, dir, by === "shotgun" ? 0.4 : 1)
        }
        if (e.by === this.myId) {
          if (e.hit && t - this.hitSoundAt > 0.04) {
            this.hitAt = t
            this.hitSoundAt = t
            this.sound.hit(false)
          }
          return
        }
        const a = this.avatars.get(e.by)
        const gun = a?.gun ?? "rifle"
        const last = this.soundAt.get(e.by) ?? -1
        const first = t - last > 0.05
        if (first && a) shoot(a, t)
        const m = a ? this.muzzle(a) : { x: e.x0, y: e.y0, z: SHOULDER - 0.15 }
        this.tracer(m.x, m.y, m.z, e.x1, e.y1, gun)
        if (!e.hit && e.veh) this.veh.ping(e.veh, e.x1, e.y1, dir, this.fxv)
        else if (!e.hit) this.impact(e.x1, e.y1, dir, gun)
        if (e.veh && me && Math.hypot(e.x1 - me.x, e.y1 - me.y) < 18) this.sound.impact(e.x1 - me.x, e.y1 - me.y)
        if (e.hit === this.myId) {
          const eff = this.juice.trauma ? 1 : 0
          const rm = this.cam?.isReducedMotion() ?? false
          const fScale = eff * cameraShakeSettings.damageFlashScale * (rm ? 0.5 : 1)
          this.hurt = Math.min(rm ? 0.35 : 1, this.hurt + 0.45 * fScale)
          if (eff) {
            this.cam?.add(0.45, dir, 0.9)
          }
          this.sound.hurt()
        } else if (me && !e.hit) {
          // Near miss: a crack as the round passes close by.
          const along = (me.x - e.x0) * Math.cos(dir) + (me.y - e.y0) * Math.sin(dir)
          const off = Math.abs(-(me.x - e.x0) * Math.sin(dir) + (me.y - e.y0) * Math.cos(dir))
          if (along > 1 && along < Math.hypot(e.x1 - e.x0, e.y1 - e.y0) && off < 1.6) this.sound.whiz(Math.cos(dir) * 2, Math.sin(dir) * 2, gun)
        }
        if (first) {
          this.soundAt.set(e.by, t)
          if (a) this.casing(a)
          this.muzzleFlash(m.x, m.y, m.z, a?.aim ?? dir, gun)
          if (me) this.sound.shot(gun, e.x0 - me.x, e.y0 - me.y, false)
        }
        return
      }
      case "kill": {
        const mine = e.victim === this.myId
        const v = mine ? this.avatarMe : this.avatars.get(e.victim)
        const blast = e.how === "frag" || e.how === "claymore" || e.how === "vehicle" || e.how === "roadkill"
        if (v?.body) {
          this.corpses = this.corpses.filter((c) => c.id !== e.victim)
          this.corpses.push({ id: e.victim, gun: v.gun, bare: v.bare, t0: t, rd: ragdoll(v.body, v.gun, v.svx, v.svy, e.dx, e.dy, blast ? blastStyle() : deathStyle(e.how as Gun), this.solids, v.hiddenBones) })
          v.body = null
          this.blood(v.x, v.y, Math.atan2(e.dy, e.dx), 2)
        }
        this.feed.unshift({ killer: this.nameOf(e.killer), victim: this.nameOf(e.victim), kc: this.colorOf(e.killer), vc: this.colorOf(e.victim), how: e.how, t, mine: e.killer === this.myId || mine })
        this.feed.length = Math.min(this.feed.length, 5)
        const eff = this.juice.trauma ? 1 : 0
        const rm = this.cam?.isReducedMotion() ?? false
        if (e.killer === this.myId) {
          this.killAt = t
          this.freezeUntil = t + (rm ? 0 : 0.07 * eff)
          this.sound.hit(true)
          if (eff) {
            this.cam?.add(0.25)
            this.cam?.killPunch()
          }
          this.banner = { text: `ELIMINATED ${this.nameOf(e.victim).toUpperCase()}`, t }
        }
        if (mine) {
          this.banner = { text: `KILLED BY ${this.nameOf(e.killer).toUpperCase()}`, t }
          if (eff) {
            this.cam?.add(0.8)
            this.cam?.kick(e.dx, e.dy, 2)
          }
        }
        return
      }
      case "reload": {
        const a = this.avatars.get(e.by)
        if (a) {
          a.reloadAt = t
          a.reloadFor = GUNS[a.gun].reload
        }
        return
      }
      case "throw": {
        this.grenades.set(e.id, { id: e.id, by: e.by, x: e.x, y: e.y, z: e.z, vx: e.vx, vy: e.vy, vz: e.vz, at: t + e.fuse, spin: 0, yaw: Math.random() * 6.28 })
        if (e.by === this.myId) return
        const a = this.avatars.get(e.by)
        if (a) useGear(a, t, false)
        if (me) this.sound.toss(e.x - me.x, e.y - me.y, false)
        return
      }
      case "plant": {
        const a = e.by === this.myId ? null : this.avatars.get(e.by)
        if (a) useGear(a, t, true)
        if (me && e.by !== this.myId && Math.hypot(e.x - me.x, e.y - me.y) < 7) this.sound.plant(e.x - me.x, e.y - me.y)
        return
      }
      case "bounce":
        if (me && Math.hypot(e.x - me.x, e.y - me.y) < 18) this.sound.bounce(e.x - me.x, e.y - me.y, e.v)
        return
      case "beep":
        this.trips.set(e.id, t)
        if (me) this.sound.beep(e.x - me.x, e.y - me.y)
        return
      case "explode":
        this.explode(e)
        return
      case "swing": {
        if (e.by === this.myId) return
        const a = this.avatars.get(e.by)
        if (a) swing(a, t)
        if (a && me && Math.hypot(a.x - me.x, a.y - me.y) < 14) this.sound.swipe(a.x - me.x, a.y - me.y, false)
        return
      }
      case "end":
        return
      case "veh": {
        const d = this.veh.draws.get(e.id)
        const near = d && me && Math.hypot(d.x - me.x, d.y - me.y) < 25
        if (near && e.what !== "seat" && Math.hypot(d.x - me.x, d.y - me.y) < 20) this.vsound.door(d.x - me.x, d.y - me.y, d.kind)
        if (near && e.what !== "exit" && e.seat === 0) this.vsound.start(d.id, d.x - me.x, d.y - me.y, d.kind)
        return
      }
      case "wreck":
        this.explode({ k: "explode", kind: "frag", by: e.by, id: -e.id, x: e.x, y: e.y, aim: 0 }, "car")
        if (e.by === this.myId) this.banner = { text: "VEHICLE DESTROYED", t }
        return
      case "crash":
        if (me && Math.hypot(e.x - me.x, e.y - me.y) < 30) this.vsound.crash(e.x - me.x, e.y - me.y, e.v)
        if (e.v > 5 && this.juice.vehicleSparks) this.veh.crash(e.id, e.x, e.y, e.v, this.solids)
        if (this.riding && this.riding.veh === e.id && this.juice.vehicleImpact) {
          this.cam?.impact(e.v)
        }
        return
      case "host":
        this.banner = { text: e.what === "reset" ? "HOST RESET THE MATCH" : `HOST SWITCHED TO ${MODES[e.mode].label.toUpperCase()}`, t }
        return
      case "obj": {
        const text = objectiveBanner(e, this.myId, teamOf(this.snap, this.roster, this.myId), (id) => this.nameOf(id))
        if (text) this.banner = { text, t }
        if (e.by === this.myId) this.sound.beep(0, 0)
        return
      }
    }
  }

  /** A frag, claymore, or vehicle going off: shared multi-phase fireball, shockwave, scorch, shrapnel, volumetric smoke, shake and bang. */
  private explode(e: Extract<SimEvent, { k: "explode" }>, presetOverride?: ExplosionPresetId): void {
    const t = this.now
    const clay = e.kind === "claymore"
    this.grenades.delete(e.id)
    this.trips.delete(e.id)
    const x = e.x
    const y = e.y
    const preset: ExplosionPresetId = presetOverride ?? (clay ? "pop" : "grenade")
    const settings = EXPLOSION_PRESETS[preset].settings
    const me = this.body
    const distToPlayer = me ? Math.hypot(x - me.x, y - me.y) : 0
    this.smokeVolumes.carve(x, y, x, y, 3)
    spawnExplosion(
      this.explosionParticles,
      this.smokeVolumes,
      x + (clay ? Math.cos(e.aim) * 0.35 : 0),
      0,
      y + (clay ? Math.sin(e.aim) * 0.35 : 0),
      settings,
      Math.random,
      1,
      1,
      {
        ...(clay ? { aim: e.aim, cone: CLAYMORE.blastCone } : {}),
        distanceToEye: distToPlayer,
        referenceDist: 20,
      },
    )
    this.booms.push({ x, y, t0: t, kind: e.kind, aim: e.aim, preset })
    const R = Math.random
    if (clay) {
      // The ball bearings: a fan of streaks out to the walls.
      for (let i = 0; i < 16; i++) {
        const a = e.aim + (R() - 0.5) * 2 * CLAYMORE.blastCone
        const len = Math.min(raycast(x, y, Math.cos(a), Math.sin(a), this.blockers, CLAYMORE.blast + 2), CLAYMORE.blast + 2) * (0.7 + R() * 0.3)
        this.tracer(x, y, 0.15, x + Math.cos(a) * len, y + Math.sin(a) * len, "shotgun")
      }
    }
    if (!me) return
    const dx = x - me.x
    const dy = y - me.y
    const d = Math.hypot(dx, dy)
    const k = Math.max(0, 1 - d / 22)
    if (this.juice.trauma) {
      this.cam?.add(Math.min(1, 1.5 * k))
      if (d > 0.01) this.cam?.kick(-dx / d, -dy / d, 9 * k * k)
      this.cam?.punch(3 * k * k, (R() < 0.5 ? -1 : 1) * 0.035 * k)
      const rm = this.cam?.isReducedMotion() ?? false
      const fScale = cameraShakeSettings.damageFlashScale * (rm ? 0.5 : 1)
      if (this.alive && d < FRAG.radius + 1.5) this.hurt = Math.min(rm ? 0.35 : 1, this.hurt + 0.6 * (1 - d / (FRAG.radius + 1.5)) * fScale)
    }
    this.sound.explode(dx, dy, e.kind)
  }

  // Input, prediction, local gunfire ----------------------------------------------------------------------------

  private cam: Camera | null = null

  update(dt: number, input: Input, cam: Camera, w: number, h: number, nowMs: number, locked?: MuxState): void {
    this.now = nowMs / 1000
    this.cam = cam
    Object.assign(cam.shakeSettings, cameraShakeSettings)
    cam.traumaSquared = this.juice.trauma
    this.session.update(dt)
    this.ingest()
    input.spellMode = !!this.snap?.spells
    if (this.snap?.spells) {
      const config=spellConfig(this.juice), key=JSON.stringify(config)
      if (this.roster.some(p=>p.id===this.myId && p.host) && key!==this.spellTuning) { this.session.send({type:"spells",config});this.spellTuning=key }
    }
    const c = cam.unproject(input.mouse.x, input.mouse.y, w, h, SHOULDER - 0.2)
    this.cursor = c
    this.ground = cam.unproject(input.mouse.x, input.mouse.y, w, h, 0)
    const origin = this.body ? this.drawn : { x: this.map.size[0] / 2, y: this.map.size[1] / 2 }
    // Keep the last aim while the cursor sits right on top of you so it doesn't jitter.
    if (Math.hypot(c.x - origin.x, c.y - origin.y) > 0.6) this.aim = Math.atan2(c.y - origin.y, c.x - origin.x)
    if (locked) {
      this.aim = locked.aim
      this.ground = { x: locked.tx, y: locked.ty }
      this.cursor = { ...this.ground }
    }
    this.acc = Math.min(this.acc + dt, DT * 5)
    while (this.acc >= DT) {
      this.acc -= DT
      const live = this.alive
      // Screen-relative movement, as in most top-down shooters: WASD move up/left/down/right; the mouse only aims.
      const mv = live ? input.move() : { mx: 0, my: 0 }
      const reload = input.takeReload()
      const firePressed = input.takeFirePress() && live && !this.snap?.spells
      const fire = live && input.enabled && (input.firing || firePressed) && !this.snap?.spells
      const equip = live && input.takeEquip()
      const use = live && input.interactHeld
      const melee = live && input.takeMelee() && this.kit.melee
      // E (or F) gets in or out of a vehicle, unless it plants or defuses here; H is the horn at the wheel.
      const enter = live && input.takeEnter() && !(this.body && canUse(this.snap, teamOf(this.snap, this.roster, this.myId), this.myId, this.body.x, this.body.y))
      const seat = live && input.takeSeat() && !!this.riding
      const driving = this.riding?.seat === 0
      const horn = live && driving && input.held("KeyH")
      const view = (fire || firePressed || melee) && this.remote.size > 0 ? Math.round(Math.max(0, this.remote.renderTime(this.now)) * 1000) / 1000 : undefined
      const i: Intent = { mx: mv.mx, my: mv.my, aim: this.aim, fire, ...(firePressed ? { firePressed: true } : {}), reload, sprint: live && input.sprinting, equip, tx: this.ground.x, ty: this.ground.y, use, melee, ...(enter ? { enter } : {}), ...(seat ? { seat } : {}), ...(horn ? { horn } : {}), ...(view !== undefined ? { view } : {}) }
      const click = input.takeCast()
      if (live && this.snap?.spells && click) {
        const target = cam.unproject(click.x, click.y, w, h, 0)
        i.cast = { spell: click.spell, quality: 1, x: target.x, y: target.y }
      }
      // Planting or defusing holds you still with the gun down, as on the server.
      if (use && this.body && canUse(this.snap, teamOf(this.snap, this.roster, this.myId), this.myId, this.body.x, this.body.y)) Object.assign(i, { mx: 0, my: 0, sprint: false, fire: false })
      // Carrying a flag you walk, as on the server.
      if (this.snap && carries(this.snap.mode, this.myId)) Object.assign(i, slowCarrier(i))
      const seq = this.predictor.record(i) + 1
      this.session.send({ type: "intent", seq, i })
      if (!live || !this.body) {
        this.triggerHeld = fire
        continue
      }
      const sprint = !this.riding && kitSprints(i, this.kit)
      if (this.riding) {
        if (driving) this.veh.tick(i, this.solids)
      } else {
        this.drawn.tick(this.body)
        if (!this.snap?.spells?.forced.includes(this.myId)) stepBody(this.body, i.mx, i.my, sprint ? this.kit.run : this.kit.walk, this.solids, DT)
        this.veh.pushOut(this.body)
      }
      // At the wheel you drive: no shooting, throwing or swinging.
      if (driving) {
        this.triggerHeld = fire
        continue
      }
      if (equip && this.equipLeft > 0) this.localEquip()
      this.localGun(i.fire, reload, sprint, melee && !this.riding, firePressed, seq)
    }
    if (this.body) this.drawn.update(this.body, this.acc / DT, dt)
    this.bracket = sampleRemote(this.remote, this.now)
    this.veh.frame(dt, this.acc / DT, this.now, this.bracket)
    this.rideAlong()
    this.vehicleSounds()
    this.bloom = Math.max(0, this.bloom - dt * 2.6)
    this.hurt = Math.max(0, this.hurt - dt * 0.9)
  }

  /** Your own throw or plant animates and sounds at once; the frag itself arrives with the server's throw event. */
  private localEquip(): void {
    const t = this.now
    this.equipLeft--
    this.lastEquip = t
    this.cooldownUntil = Math.max(this.cooldownUntil, t + EQUIP_LOCK)
    useGear(this.avatarMe, t, this.equip === "claymore")
    if (this.equip === "claymore") this.sound.plant(0, 0)
    else this.sound.toss(0, 0, true)
  }

  /** Mirrors the server's trigger and melee rules (from the kit) so your own shots and swings go on the frame you click. */
  private localGun(fire: boolean, reload: boolean, sprint: boolean, melee: boolean, firePressed: boolean, seq: number): void {
    const t = this.now
    const kit = this.kit
    if ((melee || (!kit.gun && fire)) && kit.melee && t >= this.swingReady) {
      this.swingReady = t + MELEE.cooldown
      this.swingLand = t + MELEE.windup
      swing(this.avatarMe, t)
      if (this.juice.trauma) this.cam?.add(0.18, this.aim, 1.1)
      this.sound.swipe(0, 0, true)
    }
    if (!kit.gun) {
      this.triggerHeld = fire
      return
    }
    if (sprint) this.readyAt = t + SPRINT_TO_FIRE
    const gun = GUNS[this.gun]
    if (this.session instanceof SandboxSession) {
      this.mag = kit.mag
      this.reloadUntil = 0
      reload = false
    }
    if (this.reloadUntil > 0 && t >= this.reloadUntil) {
      this.reloadUntil = 0
      this.mag = kit.mag
    }
    if (kit.reload && this.reloadUntil === 0 && ((reload && this.mag < kit.mag) || (fire && this.mag === 0))) {
      this.reloadUntil = t + gun.reload
    }
    const ready = t >= this.readyAt
    const pressed = fire && ready && (kit.auto || firePressed || !this.triggerHeld)
    if (ready || !fire) this.triggerHeld = fire
    if (!pressed || this.reloadUntil > 0 || this.mag <= 0 || t < this.cooldownUntil || t < this.swingLand) return
    this.cooldownUntil = t + kit.cooldown
    this.mag--
    this.lastLocalShot = t
    const b = this.body!
    const me = this.avatarMe
    shoot(me, t)
    const muzzle = this.muzzle(me)
    for (let k = 0; k < gun.pellets; k++) {
      const spread = bulletSpread(this.myId, seq, gun, k)
      const a = this.aim + spread
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      let stop = Math.min(raycast(b.x, b.y, dx, dy, this.blockers, gun.range), gun.range)
      const carAt = this.veh.ray(b.x, b.y, dx, dy, stop, this.riding?.veh ?? -1)
      const car = carAt < stop
      if (car) stop = carAt
      let nearest = gun.range
      let hit = false
      const myTeam = teamOf(this.snap, this.roster, this.myId)
      for (const o of this.avatars.values()) {
        if (!o.alive || (myTeam >= 0 && teamOf(this.snap, this.roster, o.id) === myTeam)) continue
        const along = (o.x - b.x) * dx + (o.y - b.y) * dy
        const off = Math.abs(-(o.x - b.x) * dy + (o.y - b.y) * dx)
        if (along > 0 && along < nearest && along < stop && off < 0.4) {
          nearest = along
          hit = true
        }
      }
      if (hit) stop = nearest
      const x1 = b.x + dx * stop
      const y1 = b.y + dy * stop
      this.tracer(muzzle.x, muzzle.y, muzzle.z, x1, y1, this.gun)
      if (!hit && car) this.veh.ping(-1, x1, y1, a, this.fxv)
      else if (!hit && stop < gun.range) this.impact(x1, y1, a, this.gun)
    }
    this.muzzleFlash(muzzle.x, muzzle.y, muzzle.z, this.aim, this.gun)
    this.casing(me)
    this.bloom = Math.min(1, this.bloom + (this.gun === "rifle" ? 0.34 : 0.9))
    const cr = CAM_RECOIL[this.gun]
    if (this.juice.trauma) {
      this.cam?.kick(-Math.cos(this.aim), -Math.sin(this.aim), cr.kick)
      this.cam?.add(cr.shake)
      this.cam?.punch(cr.punch, (Math.random() < 0.5 ? -1 : 1) * cr.roll)
    }
    this.sound.shot(this.gun, 0, 0, true)
  }

  private avatarMe: Avatar = newAvatar("me", 0, 0, 0, "rifle")

  /** The muzzle of a soldier's gun from its last pose, or where it would be. */
  private muzzle(a: Avatar): { x: number; y: number; z: number } {
    const g = gunPoints(a)
    if (g) return { x: g.muzzle[0], y: g.muzzle[2], z: g.muzzle[1] - this.veh.sinkOf(a === this.avatarMe ? this.myId : a.id) }
    const h = HOLD[a.gun]
    const c = Math.cos(a.aim)
    const s = Math.sin(a.aim)
    return { x: a.x + c * MUZZLE[a.gun] - s * h.side, y: a.y + s * MUZZLE[a.gun] + c * h.side, z: h.up }
  }

  // Effects -----------------------------------------------------------------------------------------------------

  /** Lab-only presentation port. No session ticks, input listeners or sound startup. */
  labLoad(map:MapDef):void { this.load(map); this.now=0 }
  labClear():void { this.clearScene() }
  labAdvance(dt:number):void { this.now+=dt }
  labBlood(event:SplatterImpact):void {this.blood(event.x,event.z,Math.atan2(event.dz,event.dx),event.amount??1)}
  labInspect() { return {sheets:this.sheets.length,particles:this.particles.length+this.explosionParticles.count,holes:this.holes.length,corpses:this.corpses.length,casings:this.debris.length,monitors:this.monitors.filter(m=>m.broken).length} }
  labTrigger(effect:string,gun:Gun,surface:string,x:number,y:number):void {
    const a=newAvatar("lab",x,y+2,-Math.PI/2,gun)
    animate(a,1/60,this.now,x,y+2,0,0,-Math.PI/2)
    pose(()=>{},a,[.25,.75,1],this.models)
    if(effect==="paper"||effect==="glass"){this.looseSheets(x,y,1.1,effect);return}
    if(effect==="blood"||effect==="splats"){this.blood(x,y,-Math.PI/2,2);return}
    if(effect==="monitor"){this.sparkBurst(x,y,1.1,true);this.electric.push({x,y,t0:this.now});return}
    if(effect==="lamps"){const l=this.map.lights[0];if(l)this.sparkBurst(l.x,l.y,l.h,false);return}
    if(effect==="casings"){this.casing(a);return}
    if(effect==="magazines"){this.dropMag(a);return}
    if(effect==="corpse") {if(a.body)this.corpses.push({id:"lab",gun,t0:this.now,rd:ragdoll(a.body,gun,0,0,0,-1,deathStyle(gun),this.solids)});return}
    if(effect==="explosion"||effect==="scorch"){this.explode({k:"explode",id:-1,by:"lab",x,y,kind:"frag",aim:0});return}
    if(effect==="fire"){
      this.labFireMap={...this.map,kind:"downtown",lights:[{id:999,kind:"fire",x,y,h:1,r:7,power:1,color:[1,.5,.1]}]};return
    }
    if(effect==="wreck"||effect==="vehicle"){
      this.veh.ingest({vehicles:[{id:1,kind:"jeep",x,y,h:0,vx:0,vy:0,w:0,hp:effect==="wreck"?0:100,seats:["lab"],steer:0,thr:1,...(effect==="wreck"?{wreck:1 as const}:{})}]},this.now)
      if(effect==="wreck")this.explode({k:"explode",id:-1,by:"lab",x,y,kind:"frag",aim:0},"car")
      if(effect==="vehicle")this.veh.ping(1,x+1,y,0,this.fxv)
      return
    }
    if(effect==="muzzle"){this.muzzleFlash(x,y,1.1,0,gun);return}
    if(effect==="tracer"){this.tracer(x-4,y,1.1,x+4,y,gun);return}
    if(effect==="dust"){this.fx(x,y,1.1,0,0,.3,fxSettings.dust.life,fxSettings.dust.rifleSize,"dust");return}
    if(effect==="impact"){this.impact(x,y,0,gun);return}
    // Use the same tracer/environmentHit/impact chain as a production shot, against actual map surfaces.
    let target:Rect|undefined
    if(surface==="glass")target=[...this.map.glass,...this.map.windows][0]
    else if(surface==="desk"||surface==="monitor")target=this.map.props.find(p=>p.kind==="desk")?.rect
    else target=this.map.walls.find(w=>surface==="metal"?w.style==="rack"||w.style==="shelf":surface==="partition"?w.style==="partition":w.style!=="rack"&&w.style!=="shelf")?.rect
    if(!target)return
    const tx=(target[0]+target[2])/2,ty=target[3]
    const monitor=surface==="monitor"?this.monitors.find(m=>m.x>=target![0]&&m.x<=target![2]&&m.y>=target![1]&&m.y<=target![3]):undefined
    const hitX=monitor?.x??tx,hitY=monitor?.y??ty
    if(monitor)monitor.broken=false
    for(let k=0;k<GUNS[gun].pellets;k++){
      const sx=hitX+(k-(GUNS[gun].pellets-1)/2)*.025
      this.tracer(sx,hitY+4,1.1,sx,hitY-.02,gun)
      if(surface!=="desk"&&surface!=="monitor")this.impact(sx,hitY,-Math.PI/2,gun)
    }
    this.muzzleFlash(hitX,hitY+4,1.1,-Math.PI/2,gun)
  }

  /** Lab triggers use the real presentation emitters without firing a gameplay shot. */
  testEffect(key: string): void {
    const b = this.body
    if (!b) return
    const aim = this.avatarMe.aim
    const x = b.x + Math.cos(aim) * 1.5, y = b.y + Math.sin(aim) * 1.5
    if (key === "paper" || key === "glass") this.looseSheets(x, y, 1.1, key)
    else if (key === "sparks") {
      const monitor = [...this.monitors].sort((a, c) => Math.hypot(a.x - x, a.y - y) - Math.hypot(c.x - x, c.y - y))[0]
      if (monitor) {
        monitor.broken = true
        this.electric.push({ x: monitor.x, y: monitor.y, t0: this.now })
        this.sparkBurst(monitor.x, monitor.y, 1.1)
      }
      this.sparkBurst(x, y, 1.1)
    } else if (key === "casings") this.casing(this.avatarMe)
    else if (key === "trauma") {
      this.killAt = this.now
      this.freezeUntil = this.now + 0.045
      this.cam?.killPunch()
      this.cam?.bump(0.65)
    }
  }

  /** Furniture is bullet-transparent in the game rules, but a passing round can disturb it visually. */
  private environmentHit(x0: number, y0: number, x1: number, y1: number): void {
    const len = Math.hypot(x1 - x0, y1 - y0)
    if (len < 0.01) return
    const dx = (x1 - x0) / len
    const dy = (y1 - y0) / len
    const near = (x: number, y: number, radius: number) => {
      const along = (x - x0) * dx + (y - y0) * dy
      return along > 0 && along <= len + radius && Math.abs((x - x0) * dy - (y - y0) * dx) < radius
    }
    if (this.juice.paper) {
      let closest = Infinity
      let found = -1
      this.map.props.forEach((p, i) => {
        if (!["desk", "copier", "printer", "table"].includes(p.kind) || this.now - (this.propHitAt.get(i) ?? -10) < 0.18) return
        const r: Rect = [p.rect[0] - 0.15, p.rect[1] - 0.15, p.rect[2] + 0.15, p.rect[3] + 0.15]
        const d = raycast(x0, y0, dx, dy, [r], len + 0.01)
        if (d < closest && d < len + 0.01) { closest = d; found = i }
      })
      if (found >= 0) {
        this.propHitAt.set(found, this.now)
        this.looseSheets(x0 + dx * closest, y0 + dy * closest, 0.85, "paper")
      }
    }
    if (this.juice.sparks) for (const m of this.monitors) {
      if (m.broken || !near(m.x, m.y, 0.4)) continue
      m.broken = true
      this.electric.push({ x: m.x, y: m.y, t0: this.now })
      this.sparkBurst(m.x, m.y, 1.1)
    }
  }

  private sparkBurst(x: number, y: number, z: number, electric = true): void {
    for (let i = 0; i < (electric ? fxSettings.monitor.count : fxSettings.lamps.sparks); i++) {
      const a = Math.random() * Math.PI * 2
      const s = electric ? fxSettings.monitor.speed + Math.random() * fxSettings.monitor.speedSpread : 0.2 + Math.random() * 0.45
      this.fx(x, y, z, Math.cos(a) * s, Math.sin(a) * s, electric ? 1 + Math.random() * 2 : 0.2 + Math.random() * 0.5, electric ? fxSettings.monitor.life + Math.random() * fxSettings.monitor.lifeSpread : 0.18 + Math.random() * 0.16, electric ? fxSettings.monitor.size : 0.018, electric ? "electric" : "spark")
    }
  }

  private looseSheets(x: number, y: number, z: number, kind: LooseSheet["kind"]): void {
    const s = fxSettings[kind]
    const count = s.count + Math.floor(Math.random() * s.countSpread)
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const speed = s.speed + Math.random() * s.speedSpread
      this.sheets.push({ kind, phase: Math.random() * 6.28, model: this.sheetModels[kind], p: [x, z, y], v: [Math.cos(a) * speed, s.lift + Math.random() * s.liftSpread, Math.sin(a) * speed], yaw: a, pitch: Math.random(), roll: Math.random(), w: [5, 8, 12], t0: this.now, life: s.life, bounces: 0 })
    }
    if (this.sheets.length > 200) this.sheets.splice(0, this.sheets.length - 200)
  }

  private fx(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, kind: Particle["kind"]): void {
    if (kind === "char") this.smokeVolumes.sustain(x,y)
    this.particles.push({ x, y, z, vx, vy, vz, t0: this.now, life, size, kind, bounced: false })
  }

  private tracer(x0: number, y0: number, z0: number, x1: number, y1: number, gun: Gun): void {
    this.smokeVolumes.carve(x0,y0,x1,y1,gun === "shotgun" ? 0.6 : 0.3)
    this.environmentHit(x0, y0, x1, y1)
    this.tracers.push({ x0, y0, z0, x1, y1, t0: this.now, life: gun === "sniper" ? fxSettings.tracer.sniperLife : (Math.hypot(x1 - x0, y1 - y0) + fxSettings.tracer.length) / fxSettings.tracer.speed, w: fxSettings.tracer[`${gun}Width`], gun })
    if (gun === "sniper") {
      // A smoke trail that hangs in the air along the shot.
      const len = Math.hypot(x1 - x0, y1 - y0)
      for (let d = 0.6; d < len; d += 0.9) {
        const u = d / len
        this.fx(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, z0 + (1.1 - z0) * u, (Math.random() - 0.5) * 0.15, (Math.random() - 0.5) * 0.15, 0.1, 0.9 + Math.random() * 0.4, 0.12 + Math.random() * 0.05, "smoke")
      }
    }
  }

  private muzzleFlash(x: number, y: number, z: number, aim: number, gun: Gun): void {
    const big = gun !== "rifle"
    this.flashes.push({ x: x + Math.cos(aim) * 0.9, y: y + Math.sin(aim) * 0.9, t0: this.now, life: big ? fxSettings.muzzle.heavyLightLife : fxSettings.muzzle.rifleLightLife, power: fxSettings.muzzle[`${gun}Power`] })
    this.flashFx.push({ x, y, z, aim, gun, t0: this.now, seed: Math.random() })
    const n = gun === "shotgun" ? 4 : gun === "sniper" ? 3 : Math.random() < 0.4 ? 1 : 0
    for (let i = 0; i < n; i++) {
      const s = 0.6 + Math.random() * 1.2
      const a = aim + (Math.random() - 0.5) * 0.7
      this.fx(x + Math.cos(aim) * 0.15, y + Math.sin(aim) * 0.15, z, Math.cos(a) * s, Math.sin(a) * s, 0.2 + Math.random() * 0.3, 0.6 + Math.random() * 0.6, big ? 0.09 : 0.05, "smoke")
    }
  }

  private impact(x: number, y: number, dir: number, gun: Gun): void {
    if (this.juice.glass && [...this.map.glass, ...this.map.windows].some((r) => Math.hypot(Math.max(r[0] - x, 0, x - r[2]), Math.max(r[1] - y, 0, y - r[3])) < 0.25)) {
      this.looseSheets(x - Math.cos(dir) * 0.06, y - Math.sin(dir) * 0.06, 1.1, "glass")
      return
    }
    const z = 0.9 + Math.random() * 0.5
    const n = fxSettings.impact[`${gun}Count`]
    for (let i = 0; i < n; i++) {
      const a = dir + Math.PI + (Math.random() - 0.5) * 2.4
      const s = fxSettings.impact.speed + Math.random() * fxSettings.impact.speedSpread
      this.fx(x, y, z, Math.cos(a) * s, Math.sin(a) * s, Math.random() * 3.5, fxSettings.impact.life + Math.random() * fxSettings.impact.lifeSpread, fxSettings.impact.size, "spark")
    }
    for (let i = 0; i < (gun === "shotgun" ? 1 : 3); i++) {
      const a = dir + Math.PI + (Math.random() - 0.5) * 1.6
      const s = 1 + Math.random() * 2.5
      this.fx(x, y, z, Math.cos(a) * s, Math.sin(a) * s, 1 + Math.random() * 2, 0.6 + Math.random() * 0.4, 0.03 + Math.random() * 0.02, "chip")
    }
    const puffs = gun === "shotgun" ? 1 : 2
    for (let i = 0; i < puffs; i++) {
      const a = dir + Math.PI + (Math.random() - 0.5) * 1.2
      this.fx(x - Math.cos(dir) * 0.05, y - Math.sin(dir) * 0.05, z, Math.cos(a) * 0.6, Math.sin(a) * 0.6, 0.3, fxSettings.dust.life + Math.random() * fxSettings.dust.lifeSpread, gun === "sniper" ? fxSettings.dust.sniperSize : fxSettings.dust.rifleSize, "dust")
    }
    this.fx(x, y, z, 0, 0, 0, 0.06, gun === "sniper" ? 0.6 : 0.35, "spark")
    this.holes.push({ x: x - Math.cos(dir) * 0.015, y: y - Math.sin(dir) * 0.015, z, yaw: dir, roll: Math.random() * 6.28, t0: this.now })
    if (this.holes.length > fxSettings.holes.capacity) this.holes.shift()
    const me = this.body
    if (me && Math.hypot(x - me.x, y - me.y) < 14) this.sound.impact(x - me.x, y - me.y)
  }

  private blood(x: number, y: number, dir: number, amount = 1): void {
    if(this.splatterStyle??bloodSplatterSettings.style){
      const id=++this.splatterEvent
      this.cosmeticSplatter({id,seed:this.map.seed^id,x,y:1.05,z:y,dx:Math.cos(dir),dy:.12,dz:Math.sin(dir),amount})
      return
    }
    const n = Math.round(fxSettings.blood.count * amount)
    for (let i = 0; i < n; i++) {
      const a = dir + (Math.random() - 0.5) * 1.1
      const s = fxSettings.blood.speed + Math.random() * fxSettings.blood.speedSpread
      this.fx(x, y, 0.9 + Math.random() * 0.4, Math.cos(a) * s, Math.sin(a) * s, Math.random() * 2, fxSettings.blood.life, fxSettings.blood.size + Math.random() * fxSettings.blood.sizeSpread, "blood")
    }
    if (amount >= 0.5) this.fx(x, y, 1.1, Math.cos(dir) * 0.8, Math.sin(dir) * 0.8, 0.2, 0.3, 0.2, "smoke")
  }

  /** Spent brass or a shotgun hull out of the ejection port, flung right and back, tumbling. */
  private casing(a: Avatar): void {
    if (!this.juice.casings) return
    const g = gunPoints(a)
    if (!g) return
    const s = fxSettings.casings.speed + Math.random() * fxSettings.casings.speedSpread
    const v: [number, number, number] = [g.right[0] * s - g.dir[0] * 0.6 + a.svx * 0.8, fxSettings.casings.lift + Math.random() * fxSettings.casings.liftSpread, g.right[2] * s - g.dir[2] * 0.6 + a.svy * 0.8]
    this.debris.push({ model: this.sheetModels.brass, p: [...g.port], v, yaw: a.aim + Math.PI / 2, pitch: 0, roll: 0, w: [(Math.random() - 0.5) * 30, 15 + Math.random() * 20, (Math.random() - 0.5) * 20], t0: this.now, life: a.gun === "rifle" ? fxSettings.casings.rifleLife : fxSettings.casings.heavyLife, bounces: 0 })
    if (this.debris.length > fxSettings.casings.capacity) this.debris.splice(0, this.debris.length - fxSettings.casings.capacity)
  }

  private dropMag(a: Avatar): void {
    const g = gunPoints(a)
    if (!g || a.gun === "shotgun") return
    const h = a.handVel
    this.debris.push({ model: this.models.mag[a.gun], p: g.magwell, v: [h[0] * 0.5 + a.svx, -fxSettings.magazines.dropSpeed, h[2] * 0.5 + a.svy], yaw: a.aim, pitch: 0, roll: 0, w: [(Math.random() - 0.5) * 4, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8], t0: this.now, life: fxSettings.magazines.life, bounces: 0 })
  }

  /** Cues from an avatar's animation: footsteps, casings, magazines and the mechanical sounds of the gun. */
  private cues(a: Avatar, ev: number, mine: boolean): void {
    if (!ev) return
    const me = this.body
    const dx = me ? a.x - me.x : 0
    const dy = me ? a.y - me.y : 0
    if (ev & EV.step && me && Math.hypot(dx, dy) < 16) this.sound.step(dx, dy, mine, Math.min(SPRINT_SPEED, Math.hypot(a.svx, a.svy)) / SPEED)
    if (ev & EV.magDrop) this.dropMag(a)
    if (Math.hypot(dx, dy) < 22) this.sound.cue(ev, a.gun, dx, dy, mine)
  }

  // Frame assembly ----------------------------------------------------------------------------------------------

  /** Frags tumbling through the air and claymores on their legs, with the claymores' status lights. */
  private gearParts(parts: Map<number, number[]>, t: number, dt: number): void {
    emitGearParts({
      parts,
      t,
      dt,
      grenades: this.grenades,
      obstacles: this.obstacles,
      gear: this.gear,
      snap: this.snap,
      motionKeys: this.motionKeys,
      friendlyMine: (by) => this.friendlyMine(by),
      colorOf: (id) => this.colorOf(id),
      ledColor: (c, time) => this.ledColor(c, time),
    })
  }

  /** Whether a claymore is yours or a teammate's, so you get to see its accent, arming light and faint cone. */
  private friendlyMine(by: string): boolean {
    if (by === this.myId) return true
    const mine = teamOf(this.snap, this.roster, this.myId)
    return mine >= 0 && teamOf(this.snap, this.roster, by) === mine
  }

  /**
   * Claymore light: off but for a brief dim red pinprick every couple of seconds, a frantic blink once tripped. Its
   * owner also sees a dim amber while it arms.
   */
  private ledColor(c: Snapshot["claymores"][number], t: number): [number, number, number] {
    if (c.tripped || this.trips.has(c.id)) return Math.sin(t * 60) > 0 ? [8, 0.5, 0.3] : [1, 0.05, 0.03]
    if (!c.armed) return this.friendlyMine(c.by) ? [0.8, 0.35, 0.03] : [0.02, 0.004, 0.003]
    return (t + c.id * 0.37) % 2.5 < 0.06 ? [1.4, 0.07, 0.05] : [0.02, 0.004, 0.003]
  }

  /** Frag danger rings and claymore laser cones. */
  private gearSprites(t: number): void {
    emitGearSprites({
      t,
      grenades: this.grenades,
      trips: this.trips,
      booms: this.booms,
      snap: this.snap,
      friendlyMine: (by) => this.friendlyMine(by),
      ledColor: (c, time) => this.ledColor(c, time),
      sprite: (...a) => this.sprite(...a),
    })
  }

  private sprite(add: boolean, x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number, rot = 0, stretch = 0, extra = 0): void {
    const buf = add ? this.add : this.alpha
    const n = add ? this.nAdd : this.nAlpha
    if ((n + 1) * SPRITE_FLOATS > buf.length) return
    buf.set([x, y, z, size, r, g, b, a, kind, rot, stretch, extra], n * SPRITE_FLOATS)
    if (add) { this.addMotionKeys[n] = this.spriteKeys.key(kind); this.nAdd++ }
    else this.nAlpha++
  }

  // Vehicles ----------------------------------------------------------------------------------------------------

  /** Riding, your body is your seat on the drawn vehicle. */
  private rideAlong(): void {
    const r = this.riding
    const d = r ? this.veh.draws.get(r.veh) : undefined
    if (r && d && this.body && this.alive) {
      const at = this.veh.seatAt(d, r.seat)
      this.body.x = at.x
      this.body.y = at.y
      this.body.vx = d.vx
      this.body.vy = d.vy
      this.drawn.reset(at)
    }
    const b = this.body
    const inf = this.snap?.mode.id === "inf" && teamOf(this.snap, this.roster, this.myId) === 1
    this.vehiclePrompt = !r && b && this.alive && !inf ? this.veh.enterable(b.x, b.y) : null
  }

  /** Engines of the vehicles being driven near you, the hardest skid, any horn. */
  private vehicleSounds(): void {
    const me = this.body ? this.drawn : null
    if (!me || this.snap?.phase !== "play") return this.vsound.quiet()
    const list = []
    for (const d of this.veh.draws.values()) {
      if (d.s.wreck || !d.s.seats[0]) continue
      list.push({ id: d.id, kind: d.kind, dx: d.x - me.x, dy: d.y - me.y, speed: forwardSpeed(d), thr: d.s.thr, slip: Math.abs(lateralSpeed(d)), handbrake: !!d.s.hb, horn: !!d.s.horn, mine: d.id === this.riding?.veh })
    }
    this.vsound.enabled = this.juice.vehicleAudio
    this.vsound.update(list)
  }

  /** The colour of the team holding a vehicle (its driver's, else any rider's) in team modes, else null. */
  private vehicleTeam(d: VehDraw): Rgb3 | null {
    for (const id of d.s.seats) {
      if (!id) continue
      const team = teamOf(this.snap, this.roster, id)
      if (team >= 0) return this.colorOf(id)
    }
    return null
  }

  /** The vehicle you're in, for the HUD: its name, your seat, its health and how full it is. */
  get ride(): { label: string; driver: boolean; hp: number; max: number; used: number; seats: number } | null {
    const d = this.riding ? this.veh.draws.get(this.riding.veh) : undefined
    if (!d || !this.riding) return null
    return { label: d.spec.label, driver: this.riding.seat === 0, hp: d.s.hp, max: d.spec.hp, used: d.s.seats.filter(Boolean).length, seats: d.s.seats.length }
  }

  /** Where the camera should lead while you drive (ahead along the velocity), or null on foot. */
  vehicleLead(): { x: number; y: number } | null {
    const d = this.riding?.seat === 0 ? this.veh.draws.get(this.riding.veh) : undefined
    if (!d) return null
    const k = 0.5
    const cap = 8
    return { x: Math.max(-cap, Math.min(cap, d.vx * k)), y: Math.max(-cap * 0.7, Math.min(cap * 0.7, d.vy * k)) }
  }

  /**
   * Draws a soldier riding a vehicle: on their seat, feet carried along with it, standing still on board (the driver
   * facing ahead), sunk into the bodywork or up out of a roof hatch, with their ring on the floor they stand on.
   * Returns false when they're on foot.
   */
  private rider(a: Avatar, id: string, adt: number, t: number, push: PushPart, col: Rgb3): boolean {
    const r = this.veh.riderOf(id)
    if (!r) {
      this.seatPose.delete(id)
      return false
    }
    const { d, seat } = r
    const at = this.veh.seatAt(d, seat)
    const pose1 = { x: at.x, y: at.y, h: d.h }
    const prev = this.seatPose.get(id)
    if (prev && Math.hypot(prev.x - at.x, prev.y - at.y) < 3) carry(a, prev, pose1)
    this.seatPose.set(id, pose1)
    const aim = seat === 0 ? d.h : id === this.myId ? this.aim : a.aim
    this.cues(a, animate(a, adt, t, at.x, at.y, 0, 0, aim, this.wizardLook), id === this.myId)
    const sink = d.spec.seats[seat]!.sink
    const sunk: PushPart = (model, x, y, z, ...rest) => push(model, x, y - sink, z, ...rest)
    pose(sunk, a, col, this.models)
    if (d.kind === "van" && sink > 0) return true
    const gc = glow(col, 0.9)
    this.sprite(true, at.x, FLOOR[d.kind], at.y, 0.42, gc[0], gc[1], gc[2], 0.9, 2, 0, 0.14)
    return true
  }

  build(cam: Camera, w: number, h: number, dt: number): FrameInput {
    this.smokeVolumes.update(dt)
    if (this.wizardLook !== (this.juice.wizards || this.sourceMap.id === "castle-hall")) this.applyLook()
    const t = this.now
    const intensity = this.juice.monitors ? this.juice.monitorIntensity : 0
    if (intensity !== this.bounceIntensity) {
      // Recombine pre-baked linear irradiance only on a control change; no per-frame texture/shader work.
      const base = this.bounceBase, full = this.bounceFull
      for (let i = 0; i < base.w * base.h; i++) for (let c = 0; c < 3; c++) {
        const k = i * 3 + c
        const light = base.linear![k]! + (full.linear![k]! - base.linear![k]!) * intensity
        full.data[i * 4 + c] = Math.round(Math.sqrt(Math.min(1, Math.max(0, light * 0.5))) * 255)
      }
      this.renderer.updateBounce(full.data, full.w, full.h)
      this.bounceIntensity = intensity
    }
    this.culler.setChairShadows(this.juice.chairs)
    this.culler.monitorIntensity = intensity
    const snap = this.snap
    this.nAdd = 0
    this.nAlpha = 0
    this.addMotionKeys = []
    this.motionKeys.begin()
    this.spriteKeys.begin()

    // Map lights near the view (culled to the GPU budget), then muzzle flashes as short-lived point lights that cast
    // shadows like any other. Soldiers cast round shadows.
    const vp = cam.update(w / h)
    const view = cam.groundRect()
    this.flashes = this.flashes.filter((f) => t - f.t0 < f.life)
    const dyn: DynLight[] = this.flashes.map((f) => ({ x: f.x, y: f.y, h: 1.2, r: fxSettings.muzzle.lightRadius, color: [1, 0.72, 0.38], power: f.power * (1 - (t - f.t0) / f.life), size: 0.05 }))
    this.electric = this.electric.filter((f) => t - f.t0 < fxSettings.monitor.lightLife)
    if (this.juice.sparks) for (const f of this.electric) dyn.push({ x: f.x, y: f.y, h: 1.1, r: 3, color: [0.4, 0.8, 1], power: fxSettings.monitor.lightPower * (1 - (t - f.t0) / fxSettings.monitor.lightLife), size: 0.1 })
    // Blasts: a blinding flash, then the fireball's glow dying away.
    this.booms = this.booms.filter((b) => t - b.t0 < 1.5)
    for (const b of this.booms) {
      const age = t - b.t0
      const off = b.kind === "claymore" ? 0.9 : 0
      const fl = explosionFlashLight(
        b.x + Math.cos(b.aim) * off,
        0,
        b.y + Math.sin(b.aim) * off,
        age,
        EXPLOSION_PRESETS[b.preset].settings,
      )
      if (fl) {
        dyn.push({
          x: fl.x,
          y: fl.z,
          h: fl.y,
          r: fl.radius,
          color: [fl.r, fl.g, fl.b],
          power: fl.power * 0.55,
          size: 0.3,
        })
      }
    }
    const casters: Caster[] = []
    for (const a of this.avatars.values()) if (a.alive) casters.push({ x: a.x, y: a.y })
    const vparts = new Map<number, number[]>()
    this.veh.emit(
      t,
      dt,
      (model, x, y, z, yaw, tint, pitch, roll, flash, alpha = 1) => {
        let arr = vparts.get(model)
        if (!arr) vparts.set(model, (arr = []))
        arr.push(x, y, z, yaw, tint[0], tint[1], tint[2], 1, pitch, roll, alpha, flash)
        this.motionKeys.record(arr, model)
      },
      (...a) => this.sprite(...a),
      this.fxv,
      dyn,
      casters,
      (d) => this.vehicleTeam(d),
      (d) => { this.motionKeys.begin(d); this.spriteKeys.begin(d) },
      this.juice,
      this.solids,
      this.cam?.eye ?? [0, 24, 0],
    )
    this.motionKeys.begin()
    this.spriteKeys.begin()
    if (this.alive && this.body) casters.push({ x: this.drawn.x, y: this.drawn.y })
    mapFires(this.map, view, t, dt, (...a) => this.sprite(...a), this.fxv)
    if(this.labFireMap)mapFires(this.labFireMap,view,t,dt,(...a)=>this.sprite(...a),this.fxv)
    this.culler.warmPracticals = this.map.kind === "office" && this.juice.lookPractical
    if (snap?.spells) this.spellFx.lights(snap.spells,dyn,casters)
    this.culler.update(view, t, dyn, casters, this.juice.monitors, this.juice.sparks ? this.monitors.filter((m) => m.broken) : [])
    const nl = this.culler.lightCount

    // Soldiers. A kill freezes animation and effects for a few frames (hit-stop).
    const adt = t < this.freezeUntil ? dt * 0.06 : dt
    const parts = vparts
    const push: PushPart = (model, x, y, z, yaw, tint, pitch, roll, flash, alpha = 1) => {
      let arr = parts.get(model)
      if (!arr) parts.set(model, (arr = []))
      arr.push(x, y, z, yaw, tint[0], tint[1], tint[2], 1, pitch, roll, alpha, flash)
      this.motionKeys.record(arr, model)
    }
    if (snap?.spells) this.spellFx.draw(snap.spells,snap.t,dt,parts,(...args)=>this.sprite(...args))
    if (this.juice.sparks) for (const m of this.monitors) if (m.broken) push(this.sheetModels.screen, m.x, 0, m.y, m.yaw, [1, 1, 1], 0, 0, 0)
    for (const a of this.avatars.values()) {
      if (!a.alive) continue
      this.motionKeys.begin(a)
      this.spriteKeys.begin(a)
      // Between the two snapshots around the render time; across a respawn, at the newest.
      const at = this.bracket ? soldierAt(this.bracket, a.id) : null
      if (at) a.aim = at.aim
      let glide = this.glides.get(a.id)
      if (!glide) this.glides.set(a.id, (glide = new Glide()))
      const col = this.colorOf(a.id)
      if (this.rider(a, a.id, adt, t, push, col)) {
        glide.reset()
        continue
      }
      const vx = at?.vx ?? a.tvx
      const vy = at?.vy ?? a.tvy
      const drawn = glide.step(at?.x ?? a.tx, at?.y ?? a.ty, vx, vy, dt)
      this.cues(a, animate(a, adt, t, drawn.x, drawn.y, vx, vy, a.aim, this.wizardLook), false)
      pose(push, a, col, this.models)
      if (infected(snap, this.roster, a.id)) eyes(a, t, (...e) => this.sprite(...e))
      const gc = glow(col, 0.9)
      this.sprite(true, a.x, 0.03, a.y, 0.48, gc[0], gc[1], gc[2], 0.9, 2, 0, 0.14)
    }
    const me = this.alive ? this.body : null
    if (me) {
      const a = this.avatarMe
      this.motionKeys.begin(a)
      this.spriteKeys.begin(a)
      a.gun = this.gun
      a.bare = !this.kit.gun && !snap?.spells
      a.alive = true
      a.reloadAt = this.reloadUntil > 0 ? this.reloadUntil - GUNS[this.gun].reload : -10
      a.reloadFor = GUNS[this.gun].reload
      const d = this.drawn
      const col = this.colorOf(this.myId)
      if (!this.rider(a, this.myId, adt, t, push, col)) {
        this.cues(a, animate(a, adt, t, d.x, d.y, me.vx, me.vy, this.aim, this.wizardLook), true)
        pose(push, a, col, this.models)
        if (infected(snap, this.roster, this.myId)) eyes(a, t, (...e) => this.sprite(...e))
        const gc = glow(col, 0.9)
        this.sprite(true, d.x, 0.03, d.y, 0.48, gc[0], gc[1], gc[2], 1, 2, 0, 0.14)
      }
    }

    let n = 0
    const batches: Batch[] = []
    const emit = (model: number, data: number[], alpha = false) => {
      const count = data.length / INST_FLOATS
      if (!count) return
      if ((n + count) * INST_FLOATS > this.inst.length) {
        const bigger = new Float32Array((n + count) * INST_FLOATS * 2)
        bigger.set(this.inst)
        this.inst = bigger
      }
      this.inst.set(data, n * INST_FLOATS)
      batches.push({ model, data: this.inst.subarray(n * INST_FLOATS, (n + count) * INST_FLOATS) as Float32Array<ArrayBuffer>, count, alpha, motionKeys: this.motionKeys.of(data) })
      n += count
    }

    const fxOut = stepAndEmitCombatFx({
      t,
      adt,
      juice: this.juice,
      models: this.models,
      sheetModels: this.sheetModels,
      solids: this.solids,
      blockers: this.blockers,
      me,
      debris: this.debris,
      sheets: this.sheets,
      corpses: this.corpses,
      holes: this.holes,
      flashFx: this.flashFx,
      tracers: this.tracers,
      particles: this.particles,
      motionKeys: this.motionKeys,
      spriteKeys: this.spriteKeys,
      push,
      emit,
      sprite: (...a) => this.sprite(...a),
      colorOf: (id) => this.colorOf(id),
      onClink: (dx, dy, isMag) => this.sound.clink(dx, dy, isMag),
      onGearParts: () => {
        this.gearParts(parts, t, dt)
        for (const [model, data] of parts) emit(model, data)
      },
      onGearAndModeSprites: () => {
        this.gearSprites(t)
        modeSprites(
          snap,
          t,
          (...a) => this.sprite(...a),
          (id) => (id === this.myId ? (this.body && this.alive ? this.drawn : null) : (this.avatars.get(id) ?? null)),
        )
      },
    })
    this.debris = fxOut.debris
    this.sheets = fxOut.sheets
    this.corpses = fxOut.corpses
    this.holes = fxOut.holes
    this.flashFx = fxOut.flashFx
    this.tracers = fxOut.tracers
    this.particles = fxOut.particles

    if (this.ownsFx) {
      this.explosionParticles.update(adt, this.wallRects)
    }
    this.splatterFx?.update(adt)
    // Uniforms.
    const F = this.frame
    F.set(vp, 0)
    F.set([cam.eye[0], cam.eye[1], cam.eye[2], t], 16)
    F.set([this.renderer.width, this.renderer.height, nl, this.map.lights.length], 20)
    const focus = me ? cam.project(this.drawn.x, 0.9, this.drawn.y, w, h) : { x: 0, y: 0 }
    F.set([me ? this.drawn.x : 0, me ? this.drawn.y : 0, me ? 1 : 0, 0.24], 24)
    F.set(AMBIENT[this.map.kind], 28)
    F.set([(focus.x / w) * 2 - 1, 1 - (focus.y / h) * 2, 0.7, this.culler.monitorStart], 32)
    F.set(this.culler.monitorBounds, 36)
    F.set([1 / this.map.size[0], 1 / this.map.size[1], this.map.size[0], this.map.size[1]], 40)
    F.set([this.juice.ao ? this.juice.aoStrength : 0, lookMask(this.juice), this.map.kind === "office" ? 1 : 0, 0], 44)
    const dead = !!snap && snap.phase === "play" && !this.alive
    const C = this.culler
    return {
      frame: F,
      splatter:(this.splatterStyle??bloodSplatterSettings.style)?this.splatterFx:undefined,
      fxParticles: this.explosionParticles,
      smoke: this.smokeVolumes,
      smokeEnabled: this.juice.volumes,
      lights: C.lights,
      lightCount: C.lightCount,
      shadowLightCount: C.shadowLightCount,
      occluders: C.occ,
      occluderCount: C.occCount,
      lampPower: C.power,
      lampCount: this.map.lights.length,
      view,
      batches,
      alphaSprites: this.alpha,
      alphaCount: this.nAlpha,
      addSprites: this.add,
      addCount: this.nAdd,
      addMotionKeys: this.addMotionKeys,
      grade: [t, dead ? 0.7 : 0, this.hurt * 0.9, 1.15 * (1 + (this.juice.trauma ? 0.15 * Math.max(0, 1 - (t - this.killAt) / 0.16) : 0))],
    }
  }
}
