import {
  BUST_RANGE,
  BUST_SECONDS,
  BUST_RATE_PER_COP,
  END_SECONDS,
  EXTRACT_BOXED_RATE,
  EXTRACT_SPOTLIT_RATE,
  EXTRACT_OPEN_SECONDS,
  EXTRACT_RADIUS,
  EXTRACT_SPEED,
  EXTRACT_SECONDS,
  GADGETS,
  HEAD_START_SECONDS,
  HEAR_RANGE,
  INTRO_SECONDS,
  LOADOUT,
  NEAR_MISS_DIST,
  NEAR_MISS_SPEED,
  OIL_SPIN_SECONDS,
  REPAIR_SECONDS,
  REPAIR_SPEED,
  ROAD_HALF,
  ROUND_SECONDS,
  SIGHT_RANGE,
  CAMERA_YAW,
  SCREEN_AHEAD,
  SCREEN_BACK,
  SCREEN_HALF_WIDTH,
  SHOP_COOLDOWN,
  SPIKE_SPOT_RANGE,
  SPIKE_THICK,
  VEHICLE_BY_ID,
  VEHICLES,
  type Extraction,
  type JobSite,
  type Role,
  type Vehicle,
} from "../config"
import { copBrain, robberBrain } from "./bots"
import { type Box, type City, generateCity, nearestNode, routeNodes, shopAt } from "./city"
import {
  type GadgetState,
  type GadgetView,
  type Prop,
  type PropView,
  type Pose,
  newGadgets,
  placeProp,
  propBox,
  segmentHitsBox,
  segmentHitsCircle,
  stripWheels,
} from "./gadgets"
import { mulberry32, type Rng } from "./rng"
import { carShape, collideShapes, shapeGap } from "./collide"
import { type Body, type Impact, type Input, NO_INPUT, WHEEL_NAMES, collideBoxes, collideCars, flatCount, forward, isDark, lateralSpeed, newBody, speedOf, stepAndCollide, toggleEngine } from "./vehicle"
import { TUNNEL, inTunnel, tunnelLink } from "./tunnel"

/** intro: robber at the scene, alarm ringing. headstart: robber drives, cops wait. chase: everyone drives. end: results. */
/** waiting: fewer than two players, everyone free-drives until someone joins. */
export type Phase = "waiting" | "intro" | "headstart" | "chase" | "end"

export type Participant = {
  id: string
  name: string
  human: boolean
  picks: Record<Role, string>
}

export type Car = {
  id: number
  ownerId: string
  name: string
  role: Role
  vehicle: Vehicle
  body: Body
  input: Input
  human: boolean
  impact: number
  stuck: number
  reverseT: number
  route: number[]
  routeI: number
  routeT: number
  routeX: number
  routeZ: number
  homeX: number
  homeZ: number
  nearCool: number
  hideX: number
  hideZ: number
  hideT: number
  /** Q / E loadout for this round. */
  gadgets: GadgetState[]
  /** A human gadget press waiting for the next tick. */
  pendingGadget: 0 | 1 | null
  /** Last gadget value seen from setInput, for edge detection. */
  lastGadget: 0 | 1 | null
  /** A human engine (H) press waiting for the next tick, and the last engine key state seen, for edge detection. */
  pendingEngine: boolean
  lastEngine: boolean
  /** Seconds before this car can raise another "impact" event. */
  impactCool: number
}

/** `to`: deliver only to this player (owner id); everyone gets the rest. */
export type SimEvent = { t: number; kind: string; text: string; carId?: number; to?: string; impact?: number }

export type CarView = {
  tunnels?: number
  /** Optional for older snapshots; current worlds always supply vertical/control state. */
  y?: number
  vy?: number
  airborne?: boolean
  landing?: number
  landings?: number
  braking?: boolean
  boosting?: boolean
  id: number
  ownerId: string
  name: string
  role: Role
  vehicle: string
  x: number
  z: number
  h: number
  vx: number
  vz: number
  speed: number
  drift: number
  stun: number
  boost: number
  human: boolean
  impact: number
  /** Cops only see the robber's last known position when out of sight. */
  ghost: boolean
  /** Gadget slots (Q, E). Only present on the viewer's own car (all cars for an unfiltered view). */
  gadgets?: GadgetView[]
  /** Body state for client prediction (0 for a ghost): yaw rate, drift state 0..1, oil spin seconds left, popped tires (Body.wheels). */
  yaw?: number
  slide?: number
  slip?: number
  wheels?: number
  /** Engine switched off (no headlights, dim taillights, no engine sound). */
  engineOff?: boolean
  /** The robber's live position comes from shared detection (radar). False when a cop sees a dark robber only on their own screen. */
  radar?: boolean
}

export type Heli = { active: boolean; x: number; y: number; z: number; h: number; sx: number; sz: number; lock: number }

export type Standing = { id: string; name: string; human: boolean; score: number; escapes: number; busts: number; best: number }

export type WorldView = {
  t: number
  round: number
  phase: Phase
  phaseT: number
  robberId: string
  site: JobSite
  exit: Extraction
  heat: number
  stars: number
  loot: number
  seen: boolean
  lastSeen: { x: number; z: number; t: number } | null
  bust: number
  boxed: boolean
  busted: boolean
  escaped: boolean
  extract: number
  /** Seconds until the extraction point opens (0 once open). */
  exitOpenIn?: number
  timeLeft: number
  roundScore: { drift: number; nearMisses: number; score: number }
  standings: Standing[]
  heli: Heli
  cars: CarView[]
  /** Deployed gadgets. Spike strips are hidden from the robber beyond SPIKE_SPOT_RANGE; robber props are hidden from cops until revealed. */
  props?: PropView[]
  /** Seconds the robber has stayed free since the cops were dispatched (frozen once busted). */
  survived: number
  /** The latest dispatch tip (broad area), until the driver is seen again. Visible to everyone. */
  tip?: Tip | null
  /** Driver's view only: repair progress 0..1 in a shop bay, and each shop's seconds until it can fix tires again. */
  repair?: number
  shopCool?: number[]
  /** Best survival time in this room so far, and who set it. */
  best: number
  bestName: string
  /** The round that just ended set a new room best. */
  newBest: boolean
}

/** Survival mode: no extraction, no gadgets; the chase runs until the robber is busted. */
export const SURVIVAL = true
/** A backup unit joins the hunt every this many seconds of survival. */
export const BACKUP_EVERY = 25
export const MAX_BACKUP = 6
/** Generous bounds of what a cop's screen can show around their car (camera axes, meters); see World.inView. */
export const VIEW_HALF_WIDTH = 85
export const VIEW_BACK = 45
export const VIEW_AHEAD = 85
/** Spike strips a cop can have on the road at once; placing another removes their oldest. */
export const MAX_STRIPS = 3
/** While nobody has eyes on the driver, dispatch radios a broad area every TIP_EVERY seconds. */
export const TIP_EVERY = 60
/** Radius of the tipped area; the driver is somewhere inside it, not at its center. */
export const TIP_RADIUS = 110

/** Radio "spotted" call: eyes back on the driver after this many seconds unseen, or this far from the last sighting. */
export const SPOT_AFTER = 4
export const SPOT_MOVED = 60
/** At most one "spotted" call per this many seconds. */
export const SPOT_COOLDOWN = 6
/** Radio "lost" call after this many seconds without eyes on the driver. */
export const LOST_AFTER = 5

/** A broad "suspect reported in this area" circle. `t` is the sim time it was issued. */
export type Tip = { x: number; z: number; r: number; t: number }
/** PvP: no bot cars. Rounds need at least this many players. */
export const PVP = true
export const MIN_PLAYERS = 2

export const HEAT_RATE = 0.35
export const HEAT_SEEN_RATE = 0.8
/** Extra heat per second while the helicopter holds the robber in its spotlight. */
export const HEAT_SPOT_RATE = 1.2
export const HELI_DELAY = 20
export const HELI_SPEED = 26
const HELI_ALT = 42
export const SPOT_RADIUS = 12
const SPOT_SWEEP = 22

export class World {
  city: City
  rng: Rng
  round = -1
  phase: Phase = "intro"
  phaseT = 0
  t = 0
  site!: JobSite
  exit!: Extraction
  cars: Car[] = []
  robberId = ""
  heat = 0
  loot = 0
  seen = false
  lastSeen: { x: number; z: number; t: number } | null = null
  bust = 0
  boxed = false
  busted = false
  escaped = false
  extract = 0
  roundDrift = 0
  roundNear = 0
  roundScore = 0
  survived = 0
  tip: Tip | null = null
  /** Seconds the driver has sat in a repair bay with flat tires, and each shop's seconds until it can work again. */
  repair = 0
  shopCool: number[] = []
  /** Seconds since anyone last had eyes on the driver (or since the last tip). */
  private unseenFor = 0
  /** Radio calls: seconds since the driver was last seen, whether a sighting is still live, and the last "spotted" call. */
  private unseenRadio = Infinity
  private sighted = false
  private lastSpotT = -Infinity
  best = 0
  bestName = ""
  newBest = false
  heli: Heli = { active: false, x: 0, y: HELI_ALT, z: 0, h: 0, sx: 0, sz: 0, lock: 0 }
  events: SimEvent[] = []
  props: Prop[] = []
  /** Chase seconds before the helicopter launches (Infinity grounds it, for balance experiments). */
  heliDelay = HELI_DELAY
  /** Collision boxes of live roadblocks, rebuilt when props change. */
  propBoxes: Box[] = []
  standings = new Map<string, Standing>()
  private participants: Participant[] = []
  private nextId = 1
  private reinforcements = 0
  private robberTurn = 0
  private nextPropId = 1
  private lastSeenH = 0
  private blockedEdges = new Set<number>()
  private sightBoxes: Box[]

  constructor(seed: number, participants: Participant[]) {
    this.city = generateCity(seed)
    this.sightBoxes = this.city.boxes.filter((b) => b.kind !== "special" && b.h > 3)
    this.rng = mulberry32(seed ^ 0x9e3779b9)
    this.setParticipants(participants)
    this.startRound()
  }

  get stars() {
    return Math.min(5, 1 + Math.floor(this.heat / 25))
  }

  robber(): Car | undefined {
    return this.cars.find((c) => c.ownerId === this.robberId)
  }

  cops(): Car[] {
    return this.cars.filter((c) => c.role === "cop")
  }

  carOf(ownerId: string) {
    return this.cars.find((c) => c.ownerId === ownerId)
  }

  /** Road route between two points, avoiding road segments closed by roadblocks. */
  routeTo(x: number, z: number, tx: number, tz: number): number[] {
    const blocked = this.blockedEdges.size ? (a: number, b: number) => this.blockedEdges.has(a * 1024 + b) : undefined
    return routeNodes(this.city, nearestNode(this.city, x, z), nearestNode(this.city, tx, tz), blocked)
  }

  /** Updates the roster. New humans join as spectators until the next round; leavers' cars are handed to bots. */
  setParticipants(ps: Participant[]) {
    this.participants = ps
    for (const p of ps) if (!this.standings.has(p.id)) this.standings.set(p.id, { id: p.id, name: p.name, human: p.human, score: 0, escapes: 0, busts: 0, best: 0 })
    for (const c of this.cars) if (c.human && !ps.some((p) => p.id === c.ownerId)) c.human = false
    if (!PVP || (this.round < 0 && this.phase !== "waiting")) return
    const enough = ps.length >= MIN_PLAYERS
    if (this.phase === "waiting") {
      if (enough) this.startRound()
      else this.syncWaitingCars()
    } else if (!enough || !ps.some((p) => p.id === this.robberId)) {
      // Not enough players left, or the robber walked out: back to the start.
      this.startRound()
    } else {
      // Leavers' cars disappear; there are no bots to hand them to.
      this.cars = this.cars.filter((c) => ps.some((p) => p.id === c.ownerId) || c.ownerId.startsWith("backup-"))
      // Late joiners drop straight in as cops from the precinct; nobody sits out a survival round.
      if (this.phase !== "end") {
        const n = this.city.nodes[this.city.precinct.spawnNode]!
        for (const p of ps) {
          if (this.cars.some((c) => c.ownerId === p.id)) continue
          const k = this.cops().length
          this.spawn(p, "cop", n.x + (k % 2 === 0 ? -2.5 : 2.5), n.z + Math.floor(k / 2) * 7, Math.PI)
          this.emit("join", `${p.name} joined the pursuit`)
        }
      }
    }
  }

  /** While waiting, every player has a car to drive around in. */
  private syncWaitingCars() {
    this.cars = this.cars.filter((c) => this.participants.some((p) => p.id === c.ownerId))
    this.participants.forEach((p, i) => {
      if (this.cars.some((c) => c.ownerId === p.id)) return
      const site = this.city.sites[i % this.city.sites.length]!
      this.spawn(p, "robber", site.x, site.z - 10, 0)
    })
  }

  /** Gadget presses are latched until the next tick, and a value repeated across inputs only fires once. */
  setInput(ownerId: string, input: Input) {
    const c = this.carOf(ownerId)
    if (!c || !c.human) return
    const g = input.gadget ?? null
    if (g !== null && g !== c.lastGadget) c.pendingGadget = g
    c.lastGadget = g
    const e = !!input.engine
    if (e && !c.lastEngine) c.pendingEngine = true
    c.lastEngine = e
    c.input = input
  }

  /** Picks the next robber: humans take turns; a lone human alternates with a bot robber so both roles get played. */
  private chooseRobber(): Participant {
    const humans = this.participants.filter((p) => p.human)
    const bots = this.participants.filter((p) => !p.human)
    const turn = this.robberTurn++
    if (humans.length >= 2) return humans[turn % humans.length]!
    if (humans.length === 1 && (turn % 2 === 0 || !bots.length)) return humans[0]!
    return bots[turn % Math.max(1, bots.length)] ?? this.participants[0]!
  }

  startRound() {
    if (PVP && this.participants.length < MIN_PLAYERS) {
      this.phase = "waiting"
      this.phaseT = 0
      this.robberId = ""
      this.bust = 0
      this.busted = false
      this.boxed = false
      this.seen = false
      this.lastSeen = null
      this.props = []
      this.propsChanged()
      // Views always carry a site and exit; before the first round there is none, so point at a fixed one.
      this.site ??= this.city.sites[0]!
      this.exit ??= this.city.extraction[0]!
      this.cars = []
      const hp = this.city.helipad
      this.heli = { active: false, x: hp.x, y: hp.y, z: hp.z, h: 0, sx: hp.x, sz: hp.z, lock: 0 }
      this.syncWaitingCars()
      return
    }
    this.round++
    this.phase = "intro"
    this.phaseT = 0
    this.t = 0
    this.heat = 0
    this.bust = 0
    this.boxed = false
    this.busted = false
    this.escaped = false
    this.extract = 0
    this.reinforcements = 0
    this.survived = 0
    this.tip = null
    this.repair = 0
    this.shopCool = this.city.shops.map(() => 0)
    this.unseenFor = 0
    this.unseenRadio = Infinity
    this.sighted = false
    this.lastSpotT = -Infinity
    this.newBest = false
    this.roundDrift = 0
    this.roundNear = 0
    this.roundScore = 0
    this.seen = false
    this.lastSeen = null
    this.props = []
    this.propsChanged()
    const hp = this.city.helipad
    this.heli = { active: false, x: hp.x, y: hp.y, z: hp.z, h: 0, sx: hp.x, sz: hp.z, lock: 0 }
    this.site = this.city.sites[Math.floor(this.rng() * this.city.sites.length)]!
    const exits = this.city.extraction.filter((e) => Math.hypot(e.x - this.site.x, e.z - this.site.z) > 220)
    this.exit = exits[Math.floor(this.rng() * exits.length)] ?? this.city.extraction[0]!
    this.loot = this.site.value
    this.cars = []
    const robber = this.chooseRobber()
    this.robberId = robber.id
    // The robber pulls away from the curb outside the job, facing down the street.
    this.spawn(robber, "robber", this.site.x, this.site.z - 10, 0)
    const cops = this.participants.filter((p) => p.id !== robber.id)
    const n = this.city.nodes[this.city.precinct.spawnNode]!
    cops.forEach((p, i) => this.spawn(p, "cop", n.x + (i % 2 === 0 ? -2.5 : 2.5), n.z + Math.floor(i / 2) * 7, Math.PI))
    this.emit("round", SURVIVAL ? `${robber.name} is on the run.` : `${robber.name} hit ${this.site.name}. Get to the ${this.exit.name}.`)
  }

  private spawn(p: Participant, role: Role, x: number, z: number, h: number) {
    const vehicle = VEHICLE_BY_ID.get(p.picks[role]) ?? VEHICLES.find((v) => v.role === role)!
    const fixed = vehicle.role === role ? vehicle : VEHICLES.find((v) => v.role === role)!
    const car: Car = {
      id: this.nextId++,
      ownerId: p.id,
      name: p.name,
      role,
      vehicle: fixed,
      body: newBody(x, z, h),
      input: NO_INPUT,
      human: p.human,
      impact: 0,
      stuck: 0,
      reverseT: 0,
      route: [],
      routeI: 0,
      routeT: 0,
      routeX: 0,
      routeZ: 0,
      homeX: x,
      homeZ: z,
      nearCool: 0,
      hideX: x,
      hideZ: z,
      hideT: 0,
      gadgets: newGadgets(LOADOUT[role]),
      pendingGadget: null,
      lastGadget: null,
      pendingEngine: false,
      lastEngine: false,
      impactCool: 0,
    }
    this.cars.push(car)
    return car
  }

  private emit(kind: string, text: string, carId?: number, to?: string) {
    this.events.push(to === undefined ? { t: this.t, kind, text, carId } : { t: this.t, kind, text, carId, to })
  }

  drainEvents(): SimEvent[] {
    const e = this.events
    this.events = []
    return e
  }

  private credit(ownerId: string, pts: number) {
    const s = this.standings.get(ownerId)
    if (s) s.score += pts
  }

  private addReinforcement() {
    const n = this.city.nodes[this.city.precinct.spawnNode]!
    const vehicle = this.reinforcements % 2 ? "swat" : "interceptor"
    const p: Participant = { id: `backup-${this.reinforcements}`, name: `Unit ${41 + this.reinforcements}`, human: false, picks: { robber: vehicle, cop: vehicle } }
    this.spawn(p, "cop", n.x, n.z - 6, Math.PI)
    this.reinforcements++
    this.emit("dispatch", "Backup unit inbound")
  }

  private endRound(escaped: boolean, text: string) {
    this.phase = "end"
    this.phaseT = 0
    this.escaped = escaped
    this.busted = !escaped
    const robber = this.robber()
    const st = this.standings.get(this.robberId)
    if (escaped && st) st.escapes++
    if (st && this.survived > st.best) st.best = this.survived
    if (this.survived > this.best) {
      this.best = this.survived
      this.bestName = robber?.name ?? ""
      this.newBest = true
    }
    this.emit("end", text, robber?.id)
    if (this.roundDrift > 0 && robber) this.emit("award", `Drift king: ${robber.name} ${Math.round(this.roundDrift)}`)
    if (this.roundNear > 0 && robber) this.emit("award", `Close calls: ${this.roundNear}`)
  }

  step(dt: number) {
    this.phaseT += dt
    if (this.phase === "end") {
      if (this.phaseT >= END_SECONDS) this.startRound()
      return
    }
    this.t += dt
    if (this.phase === "intro" && this.phaseT >= INTRO_SECONDS) {
      this.phase = "headstart"
      this.phaseT = 0
      this.emit("go", "GO")
    } else if (this.phase === "headstart" && this.phaseT >= HEAD_START_SECONDS) {
      this.phase = "chase"
      this.phaseT = 0
      const r = this.robber()
      if (r) this.lastSeen = { x: r.body.x, z: r.body.z, t: this.t }
      this.emit("dispatch", "All units, suspect fleeing. Pursue.")
    }
    this.stepCars(dt)
    if (this.phase === "chase") this.stepRules(dt)
    if (this.phase === "headstart" || this.phase === "chase") this.stepScoring(dt)
  }

  private moving(c: Car) {
    if (this.phase === "waiting") return true
    if (this.phase === "intro") return false
    if (this.phase === "headstart") return c.role === "robber"
    return !(c.role === "robber" && this.busted)
  }

  private stepCars(dt: number) {
    const boxes = this.propBoxes.length ? [...this.city.boxes, ...this.propBoxes] : this.city.boxes
    const prev = new Map<number, Pose>()
    const wall: Impact = { impact: 0, x: 0, z: 0, nx: 0, nz: 0 }
    for (const c of this.cars) {
      for (const g of c.gadgets) g.cooldown = Math.max(0, g.cooldown - dt)
      c.impactCool = Math.max(0, c.impactCool - dt)
      if (!this.moving(c)) {
        c.body.vx *= 0.85
        c.body.vz *= 0.85
        c.impact = 0
        c.pendingGadget = null
        c.pendingEngine = false
        continue
      }
      const input = c.human ? c.input : c.role === "robber" ? robberBrain(this, c) : copBrain(this, c)
      if (c.human ? c.pendingEngine : input.engine) toggleEngine(c.body)
      c.pendingEngine = false
      const slot = c.human ? c.pendingGadget : (input.gadget ?? null)
      c.pendingGadget = null
      if (slot !== null) this.useGadget(c, slot)
      prev.set(c.id, { x: c.body.x, z: c.body.z, h: c.body.h })
      c.impact = stepAndCollide(c.body, input, c.vehicle, dt, boxes, wall, this.city.ramps)
      if (Math.abs(c.body.x - prev.get(c.id)!.x) > 100) prev.set(c.id, { x: c.body.x, z: c.body.z, h: c.body.h })
      if (c.body.landing > 0) this.events.push({ t: this.t, kind: "landing", text: "", carId: c.id, impact: c.body.landing, to: c.role === "robber" && !this.seen ? c.ownerId : undefined })
      if (c.impact >= IMPACT_EVENT) this.impactEvent(c, wall)
    }
    // Every car is solid; one that isn't moving this phase (frozen at the precinct) is an immovable obstacle.
    const touched = new Set<Car>()
    for (let i = 0; i < this.cars.length; i++)
      for (let j = i + 1; j < this.cars.length; j++) {
        const a = this.cars[i]!
        const b = this.cars[j]!
        const ma = this.moving(a)
        const mb = this.moving(b)
        if (a.role === "cop" && b.role === "cop") {
          // Gentle positional separation only: no collision impulse, damage, stun,
          // heat or crash event. Frozen units stay put, and airborne cars pass above.
          if ((!ma && !mb) || Math.abs(a.body.y - b.body.y) > 1.5) continue
          const contact = collideShapes(carShape(a.body, a.vehicle), carShape(b.body, b.vehicle))
          if (!contact) continue
          const shift = Math.min(6 * dt, contact.depth * (1 - Math.exp(-dt * 12))) / (Number(ma) + Number(mb))
          if (ma) { a.body.x -= contact.nx * shift; a.body.z -= contact.nz * shift; touched.add(a) }
          if (mb) { b.body.x += contact.nx * shift; b.body.z += contact.nz * shift; touched.add(b) }
          continue
        }
        const hit = collideCars(a.body, a.vehicle, b.body, b.vehicle, dt, !ma, !mb)
        if (!hit) continue
        if (ma) touched.add(a)
        if (mb) touched.add(b)
        a.impact = Math.max(a.impact, hit.impact)
        b.impact = Math.max(b.impact, hit.impact)
        if (this.phase === "chase" && (a.role === "robber" || b.role === "robber") && hit.impact > 8) this.heat += 1
        if (hit.impact >= IMPACT_EVENT) {
          this.impactEvent(a, { ...hit, nx: -hit.nx, nz: -hit.nz })
          this.impactEvent(b, hit)
        }
      }
    // A shove can push a car into a wall; settle it against the city again.
    for (const c of touched) collideBoxes(c.body, c.vehicle, boxes)
    this.stepProps(dt, prev)
  }

  /**
   * "impact" event for a hard hit: text "speed|x|z|nx|nz" (contact point, normal pointing into the car). Events reach
   * every player, so an unseen driver's hits carry only the speed.
   */
  private impactEvent(c: Car, hit: Impact) {
    if (c.impactCool > 0) return
    c.impactCool = IMPACT_COOLDOWN
    const hidden = c.role === "robber" && this.phase === "chase" && !this.seen
    const f = (v: number, d: number) => v.toFixed(d)
    this.emit("impact", hidden ? f(hit.impact, 1) : [f(hit.impact, 1), f(hit.x, 2), f(hit.z, 2), f(hit.nx, 3), f(hit.nz, 3)].join("|"), c.id)
  }

  /** Q / E. Robber gadgets work from the head start on; cop gadgets once the chase is on. */
  gadgetReady(c: Car, slot: 0 | 1) {
    // Survival: cops have only the spike strip; the driver has nothing.
    if (SURVIVAL && (c.role !== "cop" || c.gadgets[slot]?.id !== "spike")) return false
    const g = c.gadgets[slot]
    // Survival spike strips never run out (placing a fourth picks up your oldest), so only the cooldown gates them.
    if (!g || g.cooldown > 0 || (g.charges <= 0 && !(SURVIVAL && g.id === "spike"))) return false
    if (c.role === "cop") return this.phase === "chase"
    return (this.phase === "headstart" || this.phase === "chase") && !this.busted
  }

  useGadget(c: Car, slot: 0 | 1): boolean {
    if (SURVIVAL) slot = 0
    if (!this.gadgetReady(c, slot)) return false
    const g = c.gadgets[slot]!
    const spec = GADGETS[g.id]
    g.charges--
    g.cooldown = spec.cooldown
    const at = placeProp(g.id, c.body, c.vehicle.length)
    this.props.push({ id: this.nextPropId++, kind: g.id, x: at.x, z: at.z, h: at.h, r: spec.radius, life: spec.ttl, ttl: spec.ttl, owner: c.id, team: c.role, revealed: c.role === "cop" || this.seen, hits: [] })
    if (SURVIVAL && g.id === "spike") {
      // Each cop keeps at most MAX_STRIPS down; the oldest one disappears. `charges` shows how many are left before that.
      const mine = this.props.filter((p) => p.kind === "spike" && p.owner === c.id)
      if (mine.length > MAX_STRIPS) this.props.splice(this.props.indexOf(mine[0]!), 1)
      g.charges = Math.max(0, MAX_STRIPS - Math.min(MAX_STRIPS, mine.length))
    }
    if (g.id === "roadblock") this.propsChanged()
    if (c.role === "robber" && this.phase === "chase") this.heat += 2
    this.emit("gadget", `${c.name} deployed ${spec.name}`, c.id)
    return true
  }

  private propsChanged() {
    this.propBoxes = []
    this.blockedEdges.clear()
    for (const p of this.props) {
      const box = propBox(p)
      if (!box) continue
      this.propBoxes.push(box)
      const { nodes, adj } = this.city
      for (let u = 0; u < nodes.length; u++)
        for (const v of adj[u]!) {
          const a = nodes[u]!
          const b = nodes[v]!
          if (tunnelLink(a, b)) continue // This edge is not a straight road through the city centre.
          if (segmentHitsCircle(a.x, a.z, b.x, b.z, p.x, p.z, ROAD_HALF + 1)) this.blockedEdges.add(u * 1024 + v)
        }
    }
  }

  private stepProps(dt: number, prev: Map<number, Pose>) {
    let roadblocks = false
    this.props = this.props.filter((p) => {
      // Survival: spike strips are permanent for the rest of the round.
      if (SURVIVAL && p.kind === "spike") return true
      p.life -= dt
      if (p.life > 0) return true
      roadblocks ||= p.kind === "roadblock"
      return false
    })
    const cops = this.cops()
    const robber = this.robber()
    for (const p of [...this.props]) {
      if (!p.revealed && cops.some((c) => Math.hypot(c.body.x - p.x, c.body.z - p.z) < SIGHT_RANGE)) p.revealed = true
      if (p.kind === "oil") {
        for (const c of cops) {
          if (p.hits.includes(c.id) || !prev.has(c.id) || Math.hypot(c.body.x - p.x, c.body.z - p.z) > p.r + 0.6) continue
          p.hits.push(c.id)
          const b = c.body
          const [fx, fz] = forward(b.h)
          const side = b.vx * fz - b.vz * fx
          b.slip = OIL_SPIN_SECONDS
          b.yaw = (side > 0 ? -1 : 1) * (2.5 + Math.min(2, speedOf(b) / 15))
          b.drift = 0
          this.emit("spinout", `${c.name} spun out on the oil`, c.id)
        }
      } else if (p.kind === "spike" && robber && prev.has(robber.id)) {
        const b = robber.body
        const v = robber.vehicle
        const [fx, fz] = forward(p.h)
        // Permanent strips bite once per pass: wait until the driver is clear of it before it can bite again.
        const clear = Math.abs((b.x - p.x) * fx + (b.z - p.z) * fz) > v.length / 2 + SPIKE_THICK / 2 + 1 || Math.abs((b.x - p.x) * fz - (b.z - p.z) * fx) > p.r + v.length / 2 + 1
        if (clear) {
          if (p.hits.length) p.hits.length = 0
          continue
        }
        if (p.hits.includes(robber.id)) continue
        // One tire per pass: the first intact one to go over the strip.
        const order = stripWheels(p, prev.get(robber.id)!, b, v.length, v.width)
        if (!order.length) continue
        if (SURVIVAL) p.hits.push(robber.id)
        else this.props.splice(this.props.indexOf(p), 1)
        const wheel = order.find((i) => !((b.wheels ?? 0) & (1 << i)))
        if (wheel === undefined) continue
        b.wheels = (b.wheels ?? 0) | (1 << wheel)
        // Hitting a strip gives the driver away: the strip's spot becomes the last known position.
        this.lastSeen = { x: b.x, z: b.z, t: this.t }
        this.lastSeenH = b.h
        this.heat += 2
        // "count|tire", e.g. "2|RL".
        this.emit("flat", `${flatCount(b.wheels)}|${WHEEL_NAMES[wheel]}`, robber.id)
      }
    }
    if (roadblocks) this.propsChanged()
  }

  /**
   * Repair shops: the driver stopped in a bay with flat tires gets them all fixed after REPAIR_SECONDS. Driving out
   * resets the progress; rolling around inside drains it. A shop that just did a repair needs SHOP_COOLDOWN seconds
   * before it can do another. Cops never need one. Unless the driver is seen, only the driver hears about it.
   */
  private stepRepair(dt: number, r: Car) {
    for (let i = 0; i < this.shopCool.length; i++) this.shopCool[i] = Math.max(0, this.shopCool[i]! - dt)
    const b = r.body
    const i = shopAt(this.city, b.x, b.z)
    if (i < 0 || !b.wheels || this.shopCool[i]! > 0) {
      this.repair = 0
      return
    }
    if (speedOf(b) >= REPAIR_SPEED) {
      this.repair = Math.max(0, this.repair - dt * 2)
      return
    }
    this.repair += dt
    if (this.repair < REPAIR_SECONDS) return
    this.repair = 0
    b.wheels = 0
    this.shopCool[i] = SHOP_COOLDOWN
    const shop = this.city.shops[i]!
    if (this.seen) this.emit("repair", shop.id, r.id)
    else this.emit("repair", "", r.id, r.ownerId)
  }

  /** Is the robber inside a smoke cloud? */
  inSmoke(x: number, z: number) {
    return this.props.some((p) => p.kind === "smoke" && Math.hypot(p.x - x, p.z - z) < p.r)
  }

  /** Line of sight from a cop to the robber: within sight range, not through smoke, and not around a building unless close enough to hear. */
  /**
   * Dispatch tips: after TIP_EVERY seconds with nobody seeing the driver, cops get a broad circle that contains the
   * driver somewhere inside it (offset from the center by a seeded random amount), then again every TIP_EVERY seconds.
   */
  private stepTip(dt: number, r: Car) {
    if (this.seen) {
      this.unseenFor = 0
      this.tip = null
      return
    }
    this.unseenFor += dt
    if (this.unseenFor < TIP_EVERY) return
    this.unseenFor = 0
    const a = this.rng() * Math.PI * 2
    const off = TIP_RADIUS * (0.25 + 0.5 * this.rng())
    this.tip = { x: r.body.x + Math.cos(a) * off, z: r.body.z + Math.sin(a) * off, r: TIP_RADIUS, t: this.t }
    this.emit("tip", "Dispatch: caller reports the suspect in this area")
  }

  /**
   * Radio calls. "spotted" when eyes land on the driver after a while unseen or somewhere new (text "heli|north": who saw
   * them, and their heading in map terms, where north is the camera's forward like the minimap). "lost" once a sighting
   * has gone cold. Runs before lastSeen is refreshed, so lastSeen is still the previous sighting.
   */
  private stepSighting(dt: number, r: Car, wasSeen: boolean, ground: boolean) {
    if (!this.seen) {
      this.unseenRadio += dt
      if (this.sighted && this.unseenRadio >= LOST_AFTER) {
        this.sighted = false
        this.emit("lost", "Lost visual on the suspect")
      }
      return
    }
    const away = this.lastSeen ? Math.hypot(r.body.x - this.lastSeen.x, r.body.z - this.lastSeen.z) : Infinity
    const fresh = !wasSeen && (this.unseenRadio >= SPOT_AFTER || away > SPOT_MOVED)
    this.unseenRadio = 0
    this.sighted = true
    if (!fresh || this.t - this.lastSpotT < SPOT_COOLDOWN) return
    this.lastSpotT = this.t
    const b = r.body
    const [fx, fz] = speedOf(b) > 2 ? [b.vx, b.vz] : forward(b.h)
    // Map up is the camera's forward; map right is the camera's screen right.
    const north = fx * Math.sin(CAMERA_YAW) + fz * Math.cos(CAMERA_YAW)
    const east = -fx * Math.cos(CAMERA_YAW) + fz * Math.sin(CAMERA_YAW)
    const heading = Math.abs(north) >= Math.abs(east) ? (north >= 0 ? "north" : "south") : east >= 0 ? "east" : "west"
    this.emit("spotted", `${ground ? "ground" : "heli"}|${heading}`)
  }

  /** Is the robber inside the area this cop's screen shows? (Survival mode's notion of "seeing" the robber.) */
  onScreen(cop: Car, r: Car) {
    if (inTunnel(cop.body) || inTunnel(r.body)) return false
    const dx = r.body.x - cop.body.x
    const dz = r.body.z - cop.body.z
    const along = dx * Math.sin(CAMERA_YAW) + dz * Math.cos(CAMERA_YAW)
    const side = dx * Math.cos(CAMERA_YAW) - dz * Math.sin(CAMERA_YAW)
    return Math.abs(side) < SCREEN_HALF_WIDTH && along > -SCREEN_BACK && along < SCREEN_AHEAD
  }

  /**
   * Could the driver be anywhere on this cop's actual screen? Deliberately generous: the camera zooms out with speed,
   * leads the car by up to ~16 m and players have wide monitors. Used for drawing the car, never for radar.
   */
  inView(cop: Car, r: Car) {
    if (inTunnel(cop.body) || inTunnel(r.body)) return false
    const dx = r.body.x - cop.body.x
    const dz = r.body.z - cop.body.z
    const along = dx * Math.sin(CAMERA_YAW) + dz * Math.cos(CAMERA_YAW)
    const side = dx * Math.cos(CAMERA_YAW) - dz * Math.sin(CAMERA_YAW)
    return Math.abs(side) < VIEW_HALF_WIDTH && along > -VIEW_BACK && along < VIEW_AHEAD
  }

  canSee(cop: Car, r: Car) {
    if (inTunnel(cop.body) || inTunnel(r.body)) return false
    const a = cop.body
    const b = r.body
    const d = Math.hypot(a.x - b.x, a.z - b.z)
    if (d > SIGHT_RANGE) return false
    for (const p of this.props) if (p.kind === "smoke" && segmentHitsCircle(a.x, a.z, b.x, b.z, p.x, p.z, p.r)) return false
    if (d < HEAR_RANGE) return true
    for (const box of this.sightBoxes) if (segmentHitsBox(a.x, a.z, b.x, b.z, box)) return false
    return true
  }

  private stepRules(dt: number) {
    const r = this.robber()
    if (!r) return
    const cops = this.cops()
    this.survived = this.phaseT
    this.heat += dt * (this.seen ? HEAT_SEEN_RATE : HEAT_RATE)
    if (!SURVIVAL && this.phaseT >= EXTRACT_OPEN_SECONDS && this.phaseT - dt < EXTRACT_OPEN_SECONDS) this.emit("exit", `The ride is waiting at the ${this.exit.name}`)
    this.stepHeli(dt, r)
    const smoked = this.inSmoke(r.body.x, r.body.z)
    // Dark (engine off, standing still): no radar and no helicopter. Cops can still see the car on their own screens and bust it.
    const dark = isDark(r.body) || inTunnel(r.body)
    const spotted = this.heli.active && !smoked && !dark && Math.hypot(this.heli.sx - r.body.x, this.heli.sz - r.body.z) < SPOT_RADIUS
    this.heli.lock = spotted ? this.heli.lock + dt : 0
    if (spotted) this.heat += dt * HEAT_SPOT_RATE
    const wasSeen = this.seen
    const ground = !smoked && !dark && cops.some((c) => (SURVIVAL ? this.onScreen(c, r) : this.canSee(c, r)))
    this.seen = spotted || ground
    this.stepSighting(dt, r, wasSeen, ground)
    if (this.seen) {
      this.lastSeen = { x: r.body.x, z: r.body.z, t: this.t }
      this.lastSeenH = r.body.h
    }
    if (SURVIVAL) this.stepTip(dt, r)
    this.stepRepair(dt, r)

    // Bust: slow robber with cops pressed against them. One cop works against a wall; more cops are faster.
    const near = cops.filter((c) => Math.hypot(c.body.x - r.body.x, c.body.z - r.body.z) < BUST_RANGE)
    this.boxed = near.length > 0 && speedOf(r.body) < 7
    if (this.boxed) {
      // Linear in the number of cops: one cop fills it in BUST_SECONDS * 2, two in BUST_SECONDS, three in BUST_SECONDS / 1.5...
      const rate = near.length * BUST_RATE_PER_COP
      this.bust = Math.min(1, this.bust + (dt / BUST_SECONDS) * rate)
      if (this.bust >= 1) {
        const pts = 1000 + Math.round(this.loot / 1000)
        for (const c of near) {
          this.credit(c.ownerId, Math.round(pts / near.length))
          const s = this.standings.get(c.ownerId)
          if (s) s.busts++
        }
        this.emit("bust", `${near.map((c) => c.name).join(" & ")} busted ${r.name}`, r.id)
        this.endRound(false, "SUSPECT BUSTED")
        return
      }
    } else this.bust = Math.max(0, this.bust - dt * 0.4)

    if (SURVIVAL) {
      if (!PVP && this.reinforcements < MAX_BACKUP && this.phaseT >= BACKUP_EVERY * (this.reinforcements + 1)) this.addReinforcement()
      return
    }

    const d = Math.hypot(r.body.x - this.exit.x, r.body.z - this.exit.z)
    // In the zone and slow enough: the ride loads up. Cops pressed against the car and the helicopter's spotlight
    // both slow the loading down.
    if (this.exitOpenIn() <= 0 && d < EXTRACT_RADIUS && speedOf(r.body) < EXTRACT_SPEED) {
      const rate = (spotted ? EXTRACT_SPOTLIT_RATE : 1) * (this.boxed ? EXTRACT_BOXED_RATE : 1)
      this.extract = Math.min(EXTRACT_SECONDS, this.extract + dt * rate)
      if (this.extract >= EXTRACT_SECONDS) {
        this.credit(this.robberId, this.loot)
        this.roundScore += this.loot
        this.emit("extract", `${r.name} got away with $${Math.round(this.loot / 1000)}K`, r.id)
        this.endRound(true, "CLEAN GETAWAY")
        return
      }
    } else this.extract = Math.max(0, this.extract - dt)

    if (this.t > ROUND_SECONDS + INTRO_SECONDS + HEAD_START_SECONDS) {
      this.emit("end", "Out of time. Roadblocks sealed the district.")
      this.endRound(false, "TIME'S UP")
      return
    }
    if (this.stars > this.reinforcements + 2 && this.reinforcements < 3) this.addReinforcement()
  }

  /**
   * The helicopter flies to the suspect while they are seen. Once the trail goes cold it flies an expanding spiral
   * around the last sighting, sweeping its spotlight; anything inside the beam is seen by every cop.
   */
  private stepHeli(dt: number, r: Car) {
    const h = this.heli
    if (!h.active) {
      if (this.phaseT < this.heliDelay) return
      h.active = true
      this.emit("heli", "Air unit up. Spotlight sweeping.")
    }
    h.y += (HELI_ALT - h.y) * Math.min(1, dt * 0.8)
    const live = this.seen && Math.hypot(r.body.x - h.x, r.body.z - h.z) < 90
    const target = live ? { x: r.body.x, z: r.body.z } : this.heliSearch()
    const dx = target.x - h.x
    const dz = target.z - h.z
    const d = Math.hypot(dx, dz)
    const lag = live ? 10 : 0
    if (d > lag) {
      const step = Math.min(d - lag, HELI_SPEED * dt)
      h.x += (dx / d) * step
      h.z += (dz / d) * step
      if (d > 2) h.h = Math.atan2(dx, dz)
    }
    let tx: number
    let tz: number
    if (live) {
      tx = r.body.x + r.body.vx * 0.2
      tz = r.body.z + r.body.vz * 0.2
    } else {
      const a = this.t * 2.1
      const rad = SPOT_SWEEP * (0.6 + 0.4 * Math.sin(this.t * 0.7))
      tx = h.x + Math.cos(a) * rad
      tz = h.z + Math.sin(a) * rad
    }
    const k = Math.min(1, dt * 3)
    h.sx += (tx - h.sx) * k
    h.sz += (tz - h.sz) * k
  }

  /** Expanding spiral around the last sighting (or the exit when there is none), flown at about the helicopter's speed. */
  heliSearch(phase = 0): { x: number; z: number } {
    const c = this.lastSeen ?? { x: this.exit.x, z: this.exit.z, t: this.t }
    const age = Math.max(0, this.t - c.t)
    const rad = Math.min(170, 12 + 4.5 * age)
    const angle = phase + age * Math.min(1.2, (HELI_SPEED * 0.9) / rad)
    const x = Math.max(0, Math.min(this.city.max - 8, c.x + Math.cos(angle) * rad))
    const z = Math.max(0, Math.min(this.city.waterZ - 8, c.z + Math.sin(angle) * rad))
    return { x, z }
  }

  private stepScoring(dt: number) {
    const r = this.robber()
    if (!r || this.busted) return
    r.nearCool = Math.max(0, r.nearCool - dt)
    const sp = speedOf(r.body)
    const lat = lateralSpeed(r.body)
    if (sp > 10 && lat > 5) {
      const pts = lat * sp * dt * 0.8
      this.roundDrift += pts
      this.roundScore += pts
      this.credit(r.ownerId, pts)
    }
    if (sp < NEAR_MISS_SPEED || r.nearCool > 0 || this.phase !== "chase") return
    for (const c of this.cops()) {
      const d = Math.hypot(c.body.x - r.body.x, c.body.z - r.body.z)
      if (d < NEAR_MISS_DIST + 2.5 && r.impact < 1 && shapeGap(carShape(c.body, c.vehicle), carShape(r.body, r.vehicle)) > 0.3) {
        this.roundNear++
        this.roundScore += 500
        this.credit(r.ownerId, 500)
        r.nearCool = 1.6
        this.heat += 3
        this.emit("near", "NEAR MISS +500", r.id)
        break
      }
    }
  }

  /** Public fields prepared once per broadcast. Visibility and private gadgets are applied separately for each viewer. */
  viewBase(): { cars: CarView[]; standings: Standing[] } {
    return {
      cars: this.cars.map((c) => {
        const b = c.body
        return {
          id: c.id, ownerId: c.ownerId, name: c.name, role: c.role, vehicle: c.vehicle.id,
          x: b.x, z: b.z, h: b.h, vx: b.vx, vz: b.vz, speed: speedOf(b), drift: lateralSpeed(b),
          tunnels: b.tunnels,
          y: b.y, vy: b.vy, airborne: b.airborne, landing: b.landing, landings: b.landings, braking: b.braking, boosting: b.boosting,
          stun: b.stun, boost: b.boostFuel, human: c.human, impact: c.impact, ghost: false,
          gadgets: undefined, yaw: b.yaw, slide: b.drift ?? 0, slip: b.slip ?? 0, wheels: b.wheels ?? 0,
          engineOff: !!b.engineOff, radar: c.role === "robber" ? true : undefined,
        }
      }),
      standings: [...this.standings.values()].filter((s) => this.participants.some((p) => p.id === s.id)).sort((a, b) => b.score - a.score),
    }
  }

  /** What a given viewer is allowed to know. Cops get the robber's last-seen ping instead of the live car when it is out of sight. */
  view(viewerId?: string, base = this.viewBase()): WorldView {
    const robberView = viewerId === undefined || viewerId === this.robberId || !this.cars.some((c) => c.ownerId === viewerId)
    const showRobber = robberView || this.seen || this.phase === "waiting" || this.phase === "intro" || this.phase === "end"
    const viewer = viewerId === undefined ? undefined : this.carOf(viewerId)
    const cars: CarView[] = []
    for (let index = 0; index < this.cars.length; index++) {
      const c = this.cars[index]!
      // A cop who has the robber on their own screen sees the car with their own eyes, even when it's dark to radar.
      const ownSight = !showRobber && c.role === "robber" && viewer?.role === "cop" && this.inView(viewer, c)
      const hidden = c.role === "robber" && !showRobber && !ownSight
      if (hidden && !this.lastSeen) continue
      let view = base.cars[index]!
      if (hidden) view = { ...view, tunnels: 0, x: this.lastSeen!.x, z: this.lastSeen!.z, h: this.lastSeenH, y: 0, vy: 0, airborne: false, landing: 0, landings: 0, braking: false, boosting: false, vx: 0, vz: 0, speed: 0, drift: 0, stun: 0, boost: 0, impact: 0, ghost: true, yaw: 0, slide: 0, slip: 0, wheels: 0, engineOff: false, radar: false }
      else if (ownSight) view = { ...view, radar: false }
      if (viewerId === undefined || viewerId === c.ownerId) view = { ...view, gadgets: c.gadgets.map((g, i) => ({ ...g, ready: this.gadgetReady(c, i as 0 | 1) })) }
      cars.push(view)
    }
    const props: PropView[] = []
    for (const p of this.props) {
      if (viewer?.role === "robber" && p.kind === "spike" && Math.hypot(p.x - viewer.body.x, p.z - viewer.body.z) > SPIKE_SPOT_RANGE) continue
      if (viewer?.role === "cop" && !p.revealed) continue
      props.push({ id: p.id, kind: p.kind, x: p.x, z: p.z, h: p.h, r: p.r, life: p.life, ttl: p.ttl })
    }
    const standings = base.standings
    return {
      t: this.t,
      round: this.round,
      phase: this.phase,
      phaseT: this.phaseT,
      robberId: this.robberId,
      site: this.site,
      exit: this.exit,
      heat: this.heat,
      stars: this.stars,
      loot: this.loot,
      seen: this.seen,
      lastSeen: this.lastSeen,
      bust: this.bust,
      boxed: this.boxed,
      busted: this.busted,
      escaped: this.escaped,
      extract: this.extract / EXTRACT_SECONDS,
      exitOpenIn: this.exitOpenIn(),
      survived: this.survived,
      tip: this.tip,
      ...(robberView && this.phase === "chase" ? { repair: this.repair / REPAIR_SECONDS, shopCool: [...this.shopCool] } : {}),
      best: this.best,
      bestName: this.bestName,
      newBest: this.newBest,
      timeLeft: Math.max(0, ROUND_SECONDS + INTRO_SECONDS + HEAD_START_SECONDS - this.t),
      roundScore: { drift: Math.round(this.roundDrift), nearMisses: this.roundNear, score: Math.round(this.roundScore) },
      standings,
      heli: { ...this.heli },
      cars,
      props,
    }
  }

  exitOpenIn() {
    if (this.phase === "intro" || this.phase === "headstart") return EXTRACT_OPEN_SECONDS
    if (this.phase === "end") return 0
    return Math.max(0, EXTRACT_OPEN_SECONDS - this.phaseT)
  }

  /** Where cop bots think the robber is: live when seen, otherwise the last sighting, otherwise a guess at the exit. */
  copTarget(car?: Car): { x: number; z: number; visible: boolean } | null {
    const r = this.robber()
    if (!r) return null
    if (this.seen || (car && this.phase === "chase" && isDark(r.body) && this.onScreen(car, r))) return { x: r.body.x, z: r.body.z, visible: true }
    if (this.lastSeen && this.t - this.lastSeen.t < 10) {
      const p = this.lastSeen
      // Follow the observed departure, not the hidden live position.
      if (Math.abs(p.z - TUNNEL.z) < TUNNEL.half) {
        if (p.x > TUNNEL.eastMouth - 12 && Math.sin(this.lastSeenH) > 0.5) return { x: 0, z: TUNNEL.z, visible: false }
        if (p.x < TUNNEL.westMouth + 12 && Math.sin(this.lastSeenH) < -0.5) return { x: this.city.max - 8, z: TUNNEL.z, visible: false }
      }
      return { x: p.x, z: p.z, visible: false }
    }
    // Trail gone cold: ground units fan out along the helicopter's search spiral, each a different way round.
    return { ...this.heliSearch(car ? 2 + car.id * 2.4 : 0), visible: false }
  }
}

/** Hits at least this hard (m/s at the contact) raise an "impact" event, at most once per IMPACT_COOLDOWN seconds per car. */
export const IMPACT_EVENT = 6
const IMPACT_COOLDOWN = 0.3
