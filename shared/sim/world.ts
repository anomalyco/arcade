import {
  BUST_RANGE,
  BUST_SECONDS,
  END_SECONDS,
  EXTRACT_SECONDS,
  HEAD_START_SECONDS,
  INTRO_SECONDS,
  NEAR_MISS_DIST,
  NEAR_MISS_SPEED,
  ROUND_SECONDS,
  VEHICLE_BY_ID,
  VEHICLES,
  type Extraction,
  type JobSite,
  type Role,
  type Vehicle,
} from "../config"
import { copBrain, robberBrain } from "./bots"
import { type City, generateCity, nearestNode, routeNodes } from "./city"
import { mulberry32, type Rng } from "./rng"
import { type Body, type Input, NO_INPUT, collideBoxes, lateralSpeed, newBody, speedOf, stepBody } from "./vehicle"

/** intro: robber at the scene, alarm ringing. headstart: robber drives, cops wait. chase: everyone drives. end: results. */
export type Phase = "intro" | "headstart" | "chase" | "end"

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
}

export type SimEvent = { t: number; kind: string; text: string; carId?: number }

export type CarView = {
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
}

export type Heli = { active: boolean; x: number; y: number; z: number; h: number; sx: number; sz: number; lock: number }

export type Standing = { id: string; name: string; human: boolean; score: number; escapes: number; busts: number }

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
  timeLeft: number
  roundScore: { drift: number; nearMisses: number; score: number }
  standings: Standing[]
  heli: Heli
  cars: CarView[]
}

const SIGHT_RANGE = 70
const HELI_DELAY = 20
const HELI_SPEED = 26
const HELI_ALT = 42
const SPOT_RADIUS = 10

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
  heli: Heli = { active: false, x: 0, y: HELI_ALT, z: 0, h: 0, sx: 0, sz: 0, lock: 0 }
  events: SimEvent[] = []
  standings = new Map<string, Standing>()
  private participants: Participant[] = []
  private nextId = 1
  private reinforcements = 0
  private robberTurn = 0

  constructor(seed: number, participants: Participant[]) {
    this.city = generateCity(seed)
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

  routeTo(x: number, z: number, tx: number, tz: number): number[] {
    return routeNodes(this.city, nearestNode(this.city, x, z), nearestNode(this.city, tx, tz))
  }

  /** Updates the roster. New humans join as spectators until the next round; leavers' cars are handed to bots. */
  setParticipants(ps: Participant[]) {
    this.participants = ps
    for (const p of ps) if (!this.standings.has(p.id)) this.standings.set(p.id, { id: p.id, name: p.name, human: p.human, score: 0, escapes: 0, busts: 0 })
    for (const c of this.cars) if (c.human && !ps.some((p) => p.id === c.ownerId)) c.human = false
  }

  setInput(ownerId: string, input: Input) {
    const c = this.carOf(ownerId)
    if (c && c.human) c.input = input
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
    this.roundDrift = 0
    this.roundNear = 0
    this.roundScore = 0
    this.seen = false
    this.lastSeen = null
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
    this.emit("round", `${robber.name} hit ${this.site.name}. Get to the ${this.exit.name}.`)
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
    }
    this.cars.push(car)
    return car
  }

  private emit(kind: string, text: string, carId?: number) {
    this.events.push({ t: this.t, kind, text, carId })
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
    if (this.phase === "intro") return false
    if (this.phase === "headstart") return c.role === "robber"
    return !(c.role === "robber" && this.busted)
  }

  private stepCars(dt: number) {
    const boxes = this.city.boxes
    for (const c of this.cars) {
      if (!this.moving(c)) {
        c.body.vx *= 0.85
        c.body.vz *= 0.85
        c.impact = 0
        continue
      }
      const input = c.human ? c.input : c.role === "robber" ? robberBrain(this, c) : copBrain(this, c)
      stepBody(c.body, input, c.vehicle, dt)
      c.impact = collideBoxes(c.body, radiusOf(c), boxes)
    }
    const live = this.cars.filter((c) => this.moving(c))
    for (let i = 0; i < live.length; i++)
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i]!
        const b = live[j]!
        const ra = radiusOf(a)
        const rb = radiusOf(b)
        const dx = b.body.x - a.body.x
        const dz = b.body.z - a.body.z
        const d = Math.hypot(dx, dz)
        if (d >= ra + rb || d < 1e-6) continue
        const nx = dx / d
        const nz = dz / d
        const overlap = ra + rb - d
        const ma = a.vehicle.mass
        const mb = b.vehicle.mass
        a.body.x -= (nx * overlap * mb) / (ma + mb)
        a.body.z -= (nz * overlap * mb) / (ma + mb)
        b.body.x += (nx * overlap * ma) / (ma + mb)
        b.body.z += (nz * overlap * ma) / (ma + mb)
        const vn = (b.body.vx - a.body.vx) * nx + (b.body.vz - a.body.vz) * nz
        if (vn >= 0) continue
        const imp = (-1.25 * vn) / (1 / ma + 1 / mb)
        a.body.vx -= (imp / ma) * nx
        a.body.vz -= (imp / ma) * nz
        b.body.vx += (imp / mb) * nx
        b.body.vz += (imp / mb) * nz
        a.impact = Math.max(a.impact, -vn)
        b.impact = Math.max(b.impact, -vn)
        if (-vn > 13) {
          const weak = ma < mb ? a : b
          weak.body.stun = Math.max(weak.body.stun, Math.min(1.2, -vn / 25))
        }
      }
  }

  private stepRules(dt: number) {
    const r = this.robber()
    if (!r) return
    const cops = this.cops()
    this.heat += dt * 0.5
    this.stepHeli(dt, r)
    const spotted = this.heli.active && Math.hypot(this.heli.sx - r.body.x, this.heli.sz - r.body.z) < SPOT_RADIUS
    this.heli.lock = spotted ? this.heli.lock + dt : 0
    this.seen = spotted || cops.some((c) => Math.hypot(c.body.x - r.body.x, c.body.z - r.body.z) < SIGHT_RANGE)
    if (this.seen) this.lastSeen = { x: r.body.x, z: r.body.z, t: this.t }

    // Bust: slow robber with cops pressed against them. One cop works against a wall; more cops are faster.
    const near = cops.filter((c) => Math.hypot(c.body.x - r.body.x, c.body.z - r.body.z) < BUST_RANGE)
    this.boxed = near.length > 0 && speedOf(r.body) < 7
    if (this.boxed) {
      const rate = near.length === 1 ? 0.45 : 1 + 0.25 * (near.length - 2)
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

    const d = Math.hypot(r.body.x - this.exit.x, r.body.z - this.exit.z)
    if (d < 14 && speedOf(r.body) < 16) {
      this.extract = Math.min(EXTRACT_SECONDS, this.extract + dt)
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

  /** The helicopter flies to where the cops think the suspect is and sweeps its spotlight around that point. */
  private stepHeli(dt: number, r: Car) {
    const h = this.heli
    if (!h.active) {
      if (this.phaseT < HELI_DELAY) return
      h.active = true
      this.emit("heli", "Air unit up. Spotlight sweeping.")
    }
    h.y += (HELI_ALT - h.y) * Math.min(1, dt * 0.8)
    const target = this.copTarget()
    if (!target) return
    const dx = target.x - h.x
    const dz = target.z - h.z
    const d = Math.hypot(dx, dz)
    const lag = 14
    if (d > lag) {
      const step = Math.min(d - lag, HELI_SPEED * dt)
      h.x += (dx / d) * step
      h.z += (dz / d) * step
      h.h = Math.atan2(dx, dz)
    }
    let tx: number
    let tz: number
    if (this.seen && Math.hypot(r.body.x - h.x, r.body.z - h.z) < 60) {
      tx = r.body.x + r.body.vx * 0.25
      tz = r.body.z + r.body.vz * 0.25
    } else {
      const a = this.t * 0.9
      const rad = 18 + 10 * Math.sin(this.t * 0.37)
      tx = target.x + Math.cos(a) * rad
      tz = target.z + Math.sin(a * 1.3) * rad
    }
    const k = Math.min(1, dt * 2.2)
    h.sx += (tx - h.sx) * k
    h.sz += (tz - h.sz) * k
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
      if (d < NEAR_MISS_DIST + 2.5 && d > radiusOf(c) + radiusOf(r) + 0.2 && r.impact < 1) {
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

  /** What a given viewer is allowed to know. Cops get the robber's last-seen ping instead of the live car when it is out of sight. */
  view(viewerId?: string): WorldView {
    const robberView = viewerId === undefined || viewerId === this.robberId || !this.cars.some((c) => c.ownerId === viewerId)
    const showRobber = robberView || this.seen || this.phase === "intro" || this.phase === "end"
    const cars: CarView[] = []
    for (const c of this.cars) {
      const hidden = c.role === "robber" && !showRobber
      if (hidden && !this.lastSeen) continue
      const b = c.body
      cars.push({
        id: c.id,
        ownerId: c.ownerId,
        name: c.name,
        role: c.role,
        vehicle: c.vehicle.id,
        x: hidden ? this.lastSeen!.x : b.x,
        z: hidden ? this.lastSeen!.z : b.z,
        h: b.h,
        vx: hidden ? 0 : b.vx,
        vz: hidden ? 0 : b.vz,
        speed: hidden ? 0 : speedOf(b),
        drift: hidden ? 0 : lateralSpeed(b),
        stun: b.stun,
        boost: b.boostFuel,
        human: c.human,
        impact: c.impact,
        ghost: hidden,
      })
    }
    const standings = [...this.standings.values()].filter((s) => this.participants.some((p) => p.id === s.id)).sort((a, b) => b.score - a.score)
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
      timeLeft: Math.max(0, ROUND_SECONDS + INTRO_SECONDS + HEAD_START_SECONDS - this.t),
      roundScore: { drift: Math.round(this.roundDrift), nearMisses: this.roundNear, score: Math.round(this.roundScore) },
      standings,
      heli: { ...this.heli },
      cars,
    }
  }

  /** Where cop bots think the robber is: live when seen, otherwise the last sighting, otherwise a guess at the exit. */
  copTarget(): { x: number; z: number; visible: boolean } | null {
    const r = this.robber()
    if (!r) return null
    if (this.seen) return { x: r.body.x, z: r.body.z, visible: true }
    if (this.lastSeen && this.t - this.lastSeen.t < 12) return { x: this.lastSeen.x, z: this.lastSeen.z, visible: false }
    return { x: this.exit.x, z: this.exit.z, visible: false }
  }
}

export function radiusOf(c: Car) {
  return Math.max(1.1, c.vehicle.length * 0.42)
}
