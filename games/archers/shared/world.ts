import { type Arena, arenaOf, mod, solidAt, wrapDelta } from "./arena"
import { CHEST_EVERY, CHEST_FIRST, CHEST_MAX, COUNTDOWN_SECONDS, DT, MATCH_OVER_SECONDS, MAX_ARROWS, ROUND_OVER_SECONDS, START_ARROWS, WINS_TO_MATCH } from "./config"
import { BTN, type Buttons, DIAG, dirOf, held } from "./input"
import { DEFAULT_TUNING, type Tuning } from "./tuning"

/** Archer hit box: half width and height (tiles), and the band at the top of the head a stomp lands on. */
export const HW = 0.31
export const HH = 1.2
export const HEAD = 0.4

export type ArrowKind = "normal" | "bomb" | "laser" | "drill" | "bramble"
export type Item = Exclude<ArrowKind, "normal"> | "shield" | "wings"
export const ITEMS: readonly Item[] = ["bomb", "laser", "drill", "bramble", "shield", "wings"]
export type Phase = "count" | "play" | "over" | "match"
export type Cause = "arrow" | "stomp" | "bomb" | "laser" | "bramble"

export type Archer = {
  id: string
  slot: number
  name: string
  bot: boolean
  alive: boolean
  /** Feet centre (tiles, y up) and velocity (tiles/s). */
  x: number
  y: number
  vx: number
  vy: number
  face: 1 | -1
  quiver: ArrowKind[]
  ground: boolean
  /** The wall you're touching or sliding on (-1 left, 1 right). */
  wall: -1 | 0 | 1
  sliding: boolean
  coyote: number
  wallCoyote: number
  wallCoyoteDir: -1 | 0 | 1
  jumpBuf: number
  jumping: boolean
  /** Steering lock after a wall jump. */
  lock: number
  /** Hanging from a ledge on this side. */
  hang: -1 | 0 | 1
  hangCd: number
  dodge: number
  dodgeAge: number
  dodgeCd: number
  dodgeX: number
  dodgeY: number
  drawing: boolean
  drawT: number
  aimX: number
  aimY: number
  shield: boolean
  wings: boolean
  prev: Buttons
  /** Kills this match and round wins. */
  kills: number
  wins: number
  deadAt: number
  killedBy: string
  airTime: number
}

export type ArrowState = "fly" | "stuck" | "loose"
export type Arrow = { id: number; by: string; kind: ArrowKind; x: number; y: number; vx: number; vy: number; state: ArrowState; age: number; drilled: number; drilling: boolean }
export type Chest = { id: number; spot: number; x: number; y: number; open: boolean; openedAt: number; item: Item }
export type Pickup = { id: number; item: Item; x: number; y: number; vy: number; age: number }
export type Bramble = { id: number; by: string; x0: number; y0: number; x1: number; y1: number; born: number; until: number }

export type SimEvent =
  | { k: "shoot"; by: string; x: number; y: number; dx: number; dy: number; kind: ArrowKind }
  | { k: "stick"; id: number; x: number; y: number; dx: number; dy: number; kind: ArrowKind; into: "wall" | "floor" | "ceiling" }
  | { k: "kill"; victim: string; by: string; cause: Cause; x: number; y: number; dx: number; dy: number; last: boolean }
  | { k: "catch"; by: string; x: number; y: number }
  | { k: "jump"; id: string; x: number; y: number; kind: "ground" | "wall" | "flap" | "climb" }
  | { k: "land"; id: string; x: number; y: number; v: number }
  | { k: "dodge"; id: string; x: number; y: number; dx: number; dy: number }
  | { k: "grab"; id: string; x: number; y: number }
  | { k: "pickup"; id: string; x: number; y: number; kind: ArrowKind }
  | { k: "chest"; x: number; y: number; item: Item; by: string }
  | { k: "item"; id: string; item: Item; x: number; y: number }
  | { k: "boom"; x: number; y: number; r: number; by: string }
  | { k: "laser"; by: string; pts: number[] }
  | { k: "shield"; id: string; x: number; y: number }
  | { k: "bramble"; x0: number; y0: number; x1: number; y1: number }
  | { k: "dry"; id: string; x: number; y: number }
  | { k: "phase"; phase: Phase; winner: string }

/** Everything the simulation is: plain data, so rollback can copy and restore it. */
export type SimState = {
  arena: string
  tick: number
  time: number
  rng: number
  phase: Phase
  phaseAt: number
  round: number
  winner: string
  archers: Archer[]
  arrows: Arrow[]
  chests: Chest[]
  pickups: Pickup[]
  brambles: Bramble[]
  nextId: number
  nextChest: number
  /** Bot minds, in state so a rollback replays them exactly. */
  brains: Record<string, BrainState>
}

export type BrainState = {
  rng: number
  /** Running scripted move: which, from which tick, and its plan target. */
  script: number
  scriptAt: number
  goal: number
  goalAt: number
  /** Bow: ticks left holding the draw, and the aim buttons to hold. */
  draw: number
  aim: number
  dodgeAt: number
  /** How sharp this bot is (0..1): reaction, aim patience, catch timing. */
  skill: number
}

const EPS = 1e-4
const BOOM_R = 2.1
const LASER_LEN = 70
const LASER_BOUNCES = 3

/** mulberry32 on a number held in state. */
function rand(s: SimState): number {
  s.rng = (s.rng + 0x6d2b79f5) >>> 0
  let t = s.rng
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export function newState(seed: number, arena = "belltower"): SimState {
  return {
    arena, tick: 0, time: 0, rng: seed >>> 0, phase: "count", phaseAt: 0, round: 0, winner: "",
    archers: [], arrows: [], chests: [], pickups: [], brambles: [], nextId: 1, nextChest: CHEST_FIRST, brains: {},
  }
}

export function newArcher(id: string, slot: number, name: string, bot: boolean): Archer {
  return {
    id, slot, name, bot, alive: false, x: 0, y: 0, vx: 0, vy: 0, face: 1, quiver: [], ground: false, wall: 0, sliding: false,
    coyote: 0, wallCoyote: 0, wallCoyoteDir: 0, jumpBuf: 0, jumping: false, lock: 0, hang: 0, hangCd: 0, dodge: 0, dodgeAge: 0,
    dodgeCd: 0, dodgeX: 0, dodgeY: 0, drawing: false, drawT: 0, aimX: 1, aimY: 0, shield: false, wings: false, prev: 0,
    kills: 0, wins: 0, deadAt: -1, killedBy: "", airTime: 0,
  }
}

/**
 * The deterministic match: platforming, arrows that stick and must be collected, dodge-catches, stomps, chests and
 * rounds. Steps with one byte of buttons per archer and never reads a clock, so a room, a tab and a rollback replay
 * all produce the same game. Only + − × ÷ and sqrt touch the state (no trig), which IEEE fixes across engines.
 */
export class World {
  s: SimState
  arena: Arena
  t: Tuning
  events: SimEvent[] = []

  constructor(state: SimState, t: Tuning = DEFAULT_TUNING) {
    this.s = state
    this.arena = arenaOf(state.arena)
    this.t = t
  }

  static create(seed: number, arena = "belltower", t?: Tuning): World {
    return new World(newState(seed, arena), t)
  }

  get time() {
    return this.s.time
  }

  archer(id: string): Archer | undefined {
    return this.s.archers.find((a) => a.id === id)
  }

  add(id: string, name: string, bot: boolean): Archer {
    const used = new Set(this.s.archers.map((a) => a.slot))
    let slot = 0
    while (used.has(slot)) slot++
    const a = newArcher(id, slot, name, bot)
    this.s.archers.push(a)
    this.s.archers.sort((p, q) => p.slot - q.slot)
    return a
  }

  remove(id: string): void {
    this.s.archers = this.s.archers.filter((a) => a.id !== id)
    delete this.s.brains[id]
  }

  setArena(id: string): void {
    this.s.arena = id
    this.arena = arenaOf(id)
  }

  takeEvents(): SimEvent[] {
    const e = this.events
    this.events = []
    return e
  }

  // Rounds --------------------------------------------------------------------------------------------------------

  startRound(): void {
    const s = this.s
    s.round++
    s.phase = "count"
    s.phaseAt = s.time
    s.winner = ""
    s.arrows = []
    s.chests = []
    s.pickups = []
    s.brambles = []
    s.nextChest = s.time + COUNTDOWN_SECONDS + CHEST_FIRST
    const spawns = this.arena.spawns.map((p, i) => ({ p, k: rand(s) + i * 1e-9 }))
    spawns.sort((a, b) => a.k - b.k)
    s.archers.forEach((a, i) => {
      const sp = spawns[i % spawns.length]!.p
      Object.assign(a, newArcher(a.id, a.slot, a.name, a.bot), { kills: a.kills, wins: a.wins, prev: a.prev })
      a.alive = true
      a.x = sp[0]
      a.y = sp[1]
      a.face = sp[0] < this.arena.w / 2 ? 1 : -1
      a.aimX = a.face
      a.quiver = new Array(START_ARROWS).fill("normal")
    })
    this.events.push({ k: "phase", phase: "count", winner: "" })
  }

  private setPhase(p: Phase, winner = ""): void {
    this.s.phase = p
    this.s.phaseAt = this.s.time
    this.s.winner = winner
    this.events.push({ k: "phase", phase: p, winner })
  }

  // Step ------------------------------------------------------------------------------------------------------------

  /** One fixed tick. `input(id)` gives each archer's held buttons for this tick. */
  step(input: (a: Archer) => Buttons): void {
    const s = this.s
    s.tick++
    s.time = s.tick * DT
    const since = s.time - s.phaseAt
    if (s.round === 0) this.startRound()
    if (s.phase === "count" && since >= COUNTDOWN_SECONDS) this.setPhase("play")
    const live = s.phase === "play" || s.phase === "over"
    for (const a of s.archers) {
      const b = live ? input(a) : 0
      if (a.alive) this.stepArcher(a, b)
      a.prev = b
    }
    this.stepArrows()
    this.stomps()
    this.stepBrambles()
    if (live) this.stepChests()
    this.stepPickups()
    if (s.phase === "play") {
      const alive = s.archers.filter((a) => a.alive)
      if (s.archers.length >= 2 && alive.length <= 1) {
        const w = alive[0]
        if (w) w.wins++
        this.setPhase("over", w?.id ?? "")
      }
    } else if (s.phase === "over" && since >= ROUND_OVER_SECONDS) {
      const champ = s.archers.find((a) => a.wins >= WINS_TO_MATCH)
      if (champ) this.setPhase("match", champ.id)
      else this.startRound()
    } else if (s.phase === "match" && since >= MATCH_OVER_SECONDS) {
      for (const a of s.archers) {
        a.wins = 0
        a.kills = 0
      }
      this.startRound()
    }
  }

  // Collision -------------------------------------------------------------------------------------------------------

  /** Does an archer box with feet at (x, y) overlap a solid tile? */
  boxHits(x: number, y: number, hw = HW, h = HH): boolean {
    const x0 = Math.floor(x - hw + EPS), x1 = Math.floor(x + hw - EPS)
    const y0 = Math.floor(y + EPS), y1 = Math.floor(y + h - EPS)
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (solidAt(this.arena, tx, ty)) return true
    return false
  }

  pointSolid(x: number, y: number): boolean {
    return solidAt(this.arena, Math.floor(x), Math.floor(y))
  }

  /** Moves an archer by (dx, dy), stopping at tiles; returns which axes were blocked. */
  private move(a: Archer, dx: number, dy: number): { hitX: boolean; hitY: boolean } {
    let hitX = false, hitY = false
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.4))
    const sx = dx / n, sy = dy / n
    for (let i = 0; i < n; i++) {
      if (sx !== 0 && !hitX) {
        const nx = a.x + sx
        if (this.boxHits(nx, a.y)) {
          hitX = true
          a.x = sx > 0 ? Math.floor(nx + HW - EPS) - HW - EPS : Math.floor(nx - HW + EPS) + 1 + HW + EPS
        } else a.x = nx
      }
      if (sy !== 0 && !hitY) {
        const ny = a.y + sy
        if (this.boxHits(a.x, ny)) {
          hitY = true
          a.y = sy < 0 ? Math.floor(ny + EPS) + 1 : Math.floor(ny + HH - EPS) - HH - EPS
        } else a.y = ny
      }
    }
    a.x = mod(a.x, this.arena.w)
    a.y = mod(a.y, this.arena.h)
    return { hitX, hitY }
  }

  // Archers ---------------------------------------------------------------------------------------------------------

  /** Steps one archer alone (bot planning replays real movement with this). */
  stepSolo(a: Archer, b: Buttons): void {
    this.stepArcher(a, b)
    a.prev = b
  }

  private stepArcher(a: Archer, b: Buttons): void {
    const t = this.t
    const press = b & ~a.prev
    const release = a.prev & ~b
    const [dx, dy] = dirOf(b)
    const hx = (held(b, BTN.right) ? 1 : 0) - (held(b, BTN.left) ? 1 : 0)
    a.coyote = Math.max(0, a.coyote - DT)
    a.wallCoyote = Math.max(0, a.wallCoyote - DT)
    a.jumpBuf = Math.max(0, a.jumpBuf - DT)
    a.lock = Math.max(0, a.lock - DT)
    a.hangCd = Math.max(0, a.hangCd - DT)
    a.dodgeCd = Math.max(0, a.dodgeCd - DT)
    if (press & BTN.jump) a.jumpBuf = t.jumpBuffer

    // Dodge: 8-way burst with i-frames; its opening frames catch arrows.
    if (press & BTN.dodge && a.dodge <= 0 && a.dodgeCd <= 0) {
      let ddx = dx, ddy = dy
      if (!ddx && !ddy) ddx = a.face
      if (a.ground && ddy < 0) {
        ddy = 0
        ddx = ddx ? Math.sign(ddx) : a.face
      }
      a.dodge = t.dodgeTime
      a.dodgeAge = 0
      a.dodgeX = ddx
      a.dodgeY = ddy
      a.hang = 0
      a.drawing = false
      a.jumping = false
      if (ddx) a.face = ddx > 0 ? 1 : -1
      this.events.push({ k: "dodge", id: a.id, x: a.x, y: a.y, dx: ddx, dy: ddy })
    }

    if (a.dodge > 0) {
      a.dodgeAge += DT
      a.dodge -= DT
      a.vx = a.dodgeX * t.dodgeSpeed
      a.vy = a.dodgeY * t.dodgeSpeed
      if (a.dodge <= 0) {
        a.vx *= 0.45
        a.vy = a.vy > 0 ? a.vy * 0.5 : a.vy * 0.3
        a.dodgeCd = t.dodgeCooldown
      }
    } else if (a.hang) {
      a.vx = 0
      a.vy = 0
      const toward = hx === a.hang
      if (a.jumpBuf > 0) {
        a.jumpBuf = 0
        if (hx === -a.hang) {
          this.wallJump(a, a.hang)
        } else {
          a.vy = t.jumpSpeed * 0.92
          a.vx = a.hang * 3
          a.jumping = true
          this.events.push({ k: "jump", id: a.id, x: a.x, y: a.y, kind: "climb" })
        }
        a.hang = 0
        a.hangCd = 0.25
      } else if (held(b, BTN.down) || (hx && !toward)) {
        a.hang = 0
        a.hangCd = 0.3
      }
    } else {
      // Steering.
      const want = a.lock > 0 ? 0 : hx * t.runSpeed
      const standDraw = a.drawing && a.ground
      const target = standDraw ? 0 : want
      const accel = a.ground ? (target === 0 || Math.sign(target) !== Math.sign(a.vx) ? t.groundBrake : t.groundAccel) : t.airAccel
      if (a.lock <= 0 || a.ground) a.vx += Math.max(-accel * DT, Math.min(accel * DT, target - a.vx))
      if (hx && !a.drawing && a.lock <= 0) a.face = hx > 0 ? 1 : -1

      // Jumps: ground (with coyote), wall (with its own coyote), then wings.
      if (a.jumpBuf > 0) {
        if (a.ground || a.coyote > 0) {
          a.vy = t.jumpSpeed
          a.jumping = true
          a.ground = false
          a.coyote = 0
          a.jumpBuf = 0
          this.events.push({ k: "jump", id: a.id, x: a.x, y: a.y, kind: "ground" })
        } else if (a.wall || a.wallCoyote > 0) {
          this.wallJump(a, a.wall || a.wallCoyoteDir)
          a.jumpBuf = 0
        } else if (a.wings && press & BTN.jump) {
          a.vy = Math.max(a.vy, t.flapSpeed)
          a.jumpBuf = 0
          this.events.push({ k: "jump", id: a.id, x: a.x, y: a.y, kind: "flap" })
        }
      }
      if (a.jumping && release & BTN.jump && a.vy > 0) {
        a.vy *= t.jumpCut
        a.jumping = false
      }
      if (a.vy <= 0) a.jumping = false

      // Gravity: softer at the apex while jump is held, harder when diving.
      let g = t.gravity
      let cap = t.maxFall
      if (held(b, BTN.jump) && Math.abs(a.vy) < t.apexBand) g = t.apexGravity
      if (held(b, BTN.down) && !a.ground && a.vy < 0) {
        g *= 1.25
        cap = t.fastFall
      }
      if (a.wings && held(b, BTN.jump) && a.vy < 0) cap = t.glideFall
      a.vy = Math.max(-cap, a.vy - g * DT)
      a.sliding = false
      if (!a.ground && a.wall && hx === a.wall && a.vy < 0) {
        a.vy = Math.max(a.vy, -t.wallSlide)
        a.sliding = true
      }
    }

    const wasGround = a.ground
    const fall = a.vy
    if (!a.hang) {
      const hit = this.move(a, a.vx * DT, a.vy * DT)
      if (hit.hitX) a.vx = 0
      if (hit.hitY) {
        if (a.vy > 0) a.jumping = false
        a.vy = 0
      }
    }
    a.ground = !a.hang && a.vy <= 0 && this.boxHits(a.x, a.y - 0.03)
    const wl = this.boxHits(a.x - 0.04, a.y + 0.05, HW, HH - 0.1)
    const wr = this.boxHits(a.x + 0.04, a.y + 0.05, HW, HH - 0.1)
    a.wall = a.ground ? 0 : wr && !wl ? 1 : wl && !wr ? -1 : 0
    if (a.wall && hx === a.wall) {
      a.wallCoyote = 0.09
      a.wallCoyoteDir = a.wall
    }
    if (a.ground) {
      a.coyote = t.coyote
      if (!wasGround && a.airTime > 0.08) this.events.push({ k: "land", id: a.id, x: a.x, y: a.y, v: -fall })
      a.airTime = 0
    } else a.airTime += DT

    // Ledge grab: falling against a wall whose lip is level with your hands.
    if (!a.ground && !a.hang && a.dodge <= 0 && a.hangCd <= 0 && a.vy <= 0 && hx && hx === a.wall && !a.drawing) this.tryLedge(a, hx as 1 | -1)

    // Bow: hold to draw and aim in 8 ways (standing still on the ground), release to loose.
    const aim = dx || dy ? [dx, dy] : [a.face, 0]
    if (press & BTN.shoot && a.dodge <= 0) {
      a.drawing = true
      a.drawT = 0
    }
    if (a.drawing) {
      a.drawT += DT
      a.aimX = aim[0]!
      a.aimY = aim[1]!
      if (a.aimX) a.face = a.aimX > 0 ? 1 : -1
      if (!held(b, BTN.shoot)) {
        a.drawing = false
        this.loose(a)
      }
    } else if (!(press & BTN.shoot)) {
      a.aimX = aim[0]!
      a.aimY = aim[1]!
    }
    void release
    this.collect(a)
  }

  private wallJump(a: Archer, wall: number): void {
    const t = this.t
    a.vx = -wall * t.wallJumpX
    a.vy = t.wallJumpY
    a.lock = t.wallJumpLock
    a.face = wall > 0 ? -1 : 1
    a.jumping = true
    a.wallCoyote = 0
    a.sliding = false
    this.events.push({ k: "jump", id: a.id, x: a.x, y: a.y, kind: "wall" })
  }

  private tryLedge(a: Archer, d: 1 | -1): void {
    const col = Math.floor(d > 0 ? a.x + HW + 0.06 : a.x - HW - 0.06)
    const top = a.y + HH
    const ty = Math.floor(top - 0.05)
    // The lip is the top of a solid tile with free space above it, within reach of your head.
    for (const row of [ty, ty - 1]) {
      const lip = row + 1
      if (!solidAt(this.arena, col, row) || solidAt(this.arena, col, row + 1)) continue
      if (top < lip - this.t.ledgeReach || top > lip + 0.25) continue
      const ny = lip - HH * 0.82
      const nx = d > 0 ? col - HW - EPS * 2 : col + 1 + HW + EPS * 2
      if (this.boxHits(nx, ny)) continue
      a.x = mod(nx, this.arena.w)
      a.y = mod(ny, this.arena.h)
      a.vx = 0
      a.vy = 0
      a.hang = d
      a.face = d
      a.jumping = false
      this.events.push({ k: "grab", id: a.id, x: a.x, y: a.y })
      return
    }
  }

  private loose(a: Archer): void {
    const kind = a.quiver.shift()
    if (!kind) {
      this.events.push({ k: "dry", id: a.id, x: a.x, y: a.y + 0.8 })
      return
    }
    const t = this.t
    const ox = a.x + a.aimX * 0.45, oy = a.y + 0.72 + a.aimY * 0.5
    this.events.push({ k: "shoot", by: a.id, x: ox, y: oy, dx: a.aimX, dy: a.aimY, kind })
    if (kind === "laser") return this.laser(a, ox, oy, a.aimX, a.aimY)
    this.s.arrows.push({ id: this.s.nextId++, by: a.id, kind, x: mod(ox, this.arena.w), y: mod(oy, this.arena.h), vx: a.aimX * t.arrowSpeed, vy: a.aimY * t.arrowSpeed, state: "fly", age: 0, drilled: 0, drilling: false })
  }

  /** A laser is instant: it travels LASER_LEN tiles, reflecting off walls up to LASER_BOUNCES times. */
  private laser(a: Archer, x: number, y: number, dx: number, dy: number): void {
    const pts = [x, y]
    let bounces = 0
    const stepLen = 0.1
    for (let d = 0; d < LASER_LEN; d += stepLen) {
      const nx = x + dx * stepLen, ny = y + dy * stepLen
      if (this.pointSolid(nx, ny)) {
        if (bounces++ >= LASER_BOUNCES) {
          pts.push(x, y)
          break
        }
        const bx = this.pointSolid(nx, y), by = this.pointSolid(x, ny)
        if (bx || !by) dx = -dx
        if (by || !bx) dy = -dy
        pts.push(x, y)
        continue
      }
      // Leaving the arena wraps the beam; record a break so it isn't drawn across the screen.
      const wx = mod(nx, this.arena.w), wy = mod(ny, this.arena.h)
      if (wx !== nx || wy !== ny) pts.push(nx, ny, Number.NaN, Number.NaN, wx, wy)
      x = wx
      y = wy
      for (const v of this.s.archers) {
        if (!v.alive || (v.id === a.id && d < 1.5)) continue
        if (this.inBox(v, x, y, 0.1)) this.hurt(v, a.id, "laser", dx, dy)
      }
      if (d + stepLen >= LASER_LEN) pts.push(x, y)
    }
    this.events.push({ k: "laser", by: a.id, pts })
  }

  private inBox(v: Archer, x: number, y: number, pad: number): boolean {
    const ddx = wrapDelta(x - v.x, this.arena.w), ddy = wrapDelta(y - v.y, this.arena.h)
    return Math.abs(ddx) <= HW + pad && ddy >= -pad && ddy <= HH + pad
  }

  /** Something lethal touched `v`. Dodging, shields and spawn safety decide whether it kills. Returns true on a kill. */
  hurt(v: Archer, by: string, cause: Cause, dx: number, dy: number): boolean {
    if (!v.alive || this.s.phase === "count") return false
    if (v.dodge > 0 && cause !== "bomb" && cause !== "bramble") return false
    if (v.shield) {
      v.shield = false
      this.events.push({ k: "shield", id: v.id, x: v.x, y: v.y + HH / 2 })
      return false
    }
    v.alive = false
    v.deadAt = this.s.time
    v.killedBy = by
    v.drawing = false
    v.hang = 0
    const killer = this.archer(by)
    if (killer && killer.id !== v.id) killer.kills++
    const left = this.s.archers.filter((a) => a.alive).length
    this.events.push({ k: "kill", victim: v.id, by, cause, x: v.x, y: v.y + HH * 0.5, dx, dy, last: this.s.phase === "play" && left <= 1 })
    // The quiver spills where you fell.
    v.quiver.forEach((kind, i) => {
      const side = (i % 2 ? 1 : -1) * (0.4 + i * 0.25)
      this.s.arrows.push({ id: this.s.nextId++, by: v.id, kind, x: v.x, y: v.y + 0.8, vx: side * 2.5 + dx * 2, vy: 6 + i, state: "loose", age: 0, drilled: 0, drilling: false })
    })
    v.quiver = []
    v.shield = false
    v.wings = false
    return true
  }

  private collect(a: Archer): void {
    if (a.quiver.length >= MAX_ARROWS) return
    for (const r of this.s.arrows) {
      if (r.state === "fly" || (r.by === a.id && r.age < 0.25 && r.state === "loose")) continue
      if (!this.inBox(a, r.x, r.y, 0.3)) continue
      a.quiver.push(r.kind)
      r.state = "fly"
      r.age = -1
      this.events.push({ k: "pickup", id: a.id, x: r.x, y: r.y, kind: r.kind })
      if (a.quiver.length >= MAX_ARROWS) break
    }
    this.s.arrows = this.s.arrows.filter((r) => r.age !== -1)
  }

  // Arrows ----------------------------------------------------------------------------------------------------------

  private stepArrows(): void {
    const s = this.s
    const t = this.t
    const keep: Arrow[] = []
    for (const r of s.arrows) {
      r.age += DT
      if (r.state === "stuck") {
        keep.push(r)
        continue
      }
      if (r.state === "loose") {
        r.vy = Math.max(-14, r.vy - 30 * DT)
        r.vx *= 0.98
        const nx = r.x + r.vx * DT, ny = r.y + r.vy * DT
        if (this.pointSolid(nx, ny)) {
          if (!this.pointSolid(nx, r.y)) {
            r.x = mod(nx, this.arena.w)
          }
          r.state = "stuck"
          r.vx = Math.sign(r.vx) || 1
          r.vy = -0.25
        } else {
          r.x = mod(nx, this.arena.w)
          r.y = mod(ny, this.arena.h)
        }
        keep.push(r)
        continue
      }
      if (this.flyArrow(r, t)) keep.push(r)
    }
    s.arrows = keep
  }

  /** Advances a flying arrow; false when it is used up (exploded, or caught). */
  private flyArrow(r: Arrow, t: Tuning): boolean {
    const s = this.s
    const speed = Math.sqrt(r.vx * r.vx + r.vy * r.vy)
    // A little bend toward a target in front, like TowerFall's aim assist.
    if (t.arrowHoming > 0 && speed > 1) {
      let best: Archer | null = null, bestD = 81
      const ux = r.vx / speed, uy = r.vy / speed
      for (const v of s.archers) {
        if (!v.alive || (v.id === r.by && r.age < 0.6)) continue
        const ddx = wrapDelta(v.x - r.x, this.arena.w), ddy = wrapDelta(v.y + HH * 0.55 - r.y, this.arena.h)
        const d2 = ddx * ddx + ddy * ddy
        if (d2 > bestD || d2 < 0.01) continue
        const d = Math.sqrt(d2)
        if ((ddx * ux + ddy * uy) / d < 0.8) continue
        best = v
        bestD = d2
      }
      if (best) {
        const ddx = wrapDelta(best.x - r.x, this.arena.w), ddy = wrapDelta(best.y + HH * 0.55 - r.y, this.arena.h)
        const d = Math.sqrt(ddx * ddx + ddy * ddy)
        const k = Math.min(1, t.arrowHoming * DT)
        r.vx += (ddx / d * speed - r.vx) * k
        r.vy += (ddy / d * speed - r.vy) * k
        const ns = Math.sqrt(r.vx * r.vx + r.vy * r.vy) || 1
        r.vx *= speed / ns
        r.vy *= speed / ns
      }
    }
    if (r.kind !== "laser") r.vy -= t.arrowGravity * DT * (r.age < 0.15 ? 0.3 : 1)
    const dist = Math.sqrt(r.vx * r.vx + r.vy * r.vy) * DT
    const n = Math.max(1, Math.ceil(dist / 0.2))
    for (let i = 0; i < n; i++) {
      const px = r.x, py = r.y
      const nx = r.x + (r.vx * DT) / n, ny = r.y + (r.vy * DT) / n
      const solid = this.pointSolid(nx, ny)
      if (r.kind === "drill" && (solid || r.drilling)) {
        // Drill arrows bore through the first wall they meet, then stick in the next.
        if (solid && r.drilled === 0) r.drilling = true
        if (r.drilling && !solid) {
          r.drilling = false
          r.drilled = 1
        }
        if (r.drilling) {
          r.x = mod(nx, this.arena.w)
          r.y = mod(ny, this.arena.h)
          continue
        }
      }
      if (solid) {
        const bx = this.pointSolid(nx, py), by = this.pointSolid(px, ny)
        const into = by && !bx ? (r.vy < 0 ? "floor" : "ceiling") : "wall"
        // Embed the head a little past the surface.
        const k = 0.35
        r.x = mod(px + (nx - px) * k, this.arena.w)
        r.y = mod(py + (ny - py) * k, this.arena.h)
        this.events.push({ k: "stick", id: r.id, x: r.x, y: r.y, dx: r.vx, dy: r.vy, kind: r.kind, into })
        if (r.kind === "bomb") {
          this.boom(r.x, r.y, r.by)
          return false
        }
        if (r.kind === "bramble") this.sprout(r, into, px, py)
        r.state = "stuck"
        return true
      }
      r.x = mod(nx, this.arena.w)
      r.y = mod(ny, this.arena.h)
      for (const v of s.archers) {
        if (!v.alive || (v.id === r.by && r.age < 0.12)) continue
        if (!this.inBox(v, r.x, r.y, 0.08)) continue
        if (v.dodge > 0 && v.dodgeAge <= t.catchWindow + DT && v.quiver.length < MAX_ARROWS) {
          v.quiver.push(r.kind)
          this.events.push({ k: "catch", by: v.id, x: r.x, y: r.y })
          return false
        }
        if (v.dodge > 0) continue
        const len = Math.sqrt(r.vx * r.vx + r.vy * r.vy) || 1
        if (r.kind === "bomb") {
          this.boom(r.x, r.y, r.by)
          return false
        }
        if (!this.hurt(v, r.by, "arrow", r.vx / len, r.vy / len)) {
          // Deflected by a shield: it tumbles away and can be picked up.
          r.state = "loose"
          r.vx = -r.vx * 0.2
          r.vy = 5
          return true
        }
        // A kill stops the arrow in the body; it drops with the archer's quiver.
        r.state = "loose"
        r.vx *= 0.1
        r.vy = 2
        return true
      }
    }
    return true
  }

  private boom(x: number, y: number, by: string): void {
    this.events.push({ k: "boom", x, y, r: BOOM_R, by })
    for (const v of this.s.archers) {
      if (!v.alive) continue
      const ddx = wrapDelta(v.x - x, this.arena.w), ddy = wrapDelta(v.y + HH * 0.5 - y, this.arena.h)
      const d = Math.sqrt(ddx * ddx + ddy * ddy)
      if (d < BOOM_R) this.hurt(v, by, "bomb", ddx / (d || 1), ddy / (d || 1))
    }
  }

  private sprout(r: Arrow, into: "wall" | "floor" | "ceiling", px: number, py: number): void {
    const len = 1.6
    const tx = Math.floor(r.x), ty = Math.floor(r.y)
    let b: Omit<Bramble, "id" | "by" | "born" | "until">
    if (into === "floor") b = { x0: r.x - len, y0: ty + 1, x1: r.x + len, y1: ty + 1.55 }
    else if (into === "ceiling") b = { x0: r.x - len, y0: ty - 0.55, x1: r.x + len, y1: ty }
    else {
      const side = px < r.x ? tx : tx + 1
      b = px < r.x ? { x0: side - 0.55, y0: r.y - len, x1: side, y1: r.y + len } : { x0: side, y0: r.y - len, x1: side + 0.55, y1: r.y + len }
    }
    void py
    this.s.brambles.push({ id: this.s.nextId++, by: r.by, born: this.s.time, until: this.s.time + 7, ...b })
    this.events.push({ k: "bramble", ...b })
  }

  private stepBrambles(): void {
    const s = this.s
    s.brambles = s.brambles.filter((b) => b.until > s.time)
    for (const b of s.brambles) {
      if (s.time - b.born < 0.25) continue
      for (const v of s.archers) {
        if (!v.alive || (v.id === b.by && s.time - b.born < 1.2)) continue
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2
        const ddx = wrapDelta(v.x - cx, this.arena.w), ddy = wrapDelta(v.y + HH / 2 - cy, this.arena.h)
        if (Math.abs(ddx) < HW + (b.x1 - b.x0) / 2 && Math.abs(ddy) < HH / 2 + (b.y1 - b.y0) / 2) this.hurt(v, b.by, "bramble", 0, 1)
      }
    }
  }

  // Stomps ----------------------------------------------------------------------------------------------------------

  private stomps(): void {
    const s = this.s
    for (const a of s.archers) {
      if (!a.alive || a.vy >= 0 || a.ground) continue
      for (const v of s.archers) {
        if (v === a || !v.alive) continue
        const ddx = wrapDelta(a.x - v.x, this.arena.w)
        const ddy = wrapDelta(a.y - (v.y + HH), this.arena.h)
        if (Math.abs(ddx) < HW * 1.8 && ddy <= 0.12 && ddy >= -HEAD) {
          if (this.hurt(v, a.id, "stomp", 0, -1) || v.dodge > 0 || !v.alive) {
            a.vy = this.t.stompBounce
            a.jumping = false
          } else {
            a.vy = this.t.stompBounce * 0.8
          }
        }
      }
    }
  }

  // Chests and pickups ----------------------------------------------------------------------------------------------

  private stepChests(): void {
    const s = this.s
    if (s.phase === "play" && s.time >= s.nextChest) {
      s.nextChest = s.time + CHEST_EVERY
      const closed = s.chests.filter((c) => !c.open)
      const free = this.arena.chests.map((_, i) => i).filter((i) => !s.chests.some((c) => c.spot === i))
      if (closed.length < CHEST_MAX && free.length) {
        const spot = free[Math.floor(rand(s) * free.length)]!
        const p = this.arena.chests[spot]!
        s.chests.push({ id: s.nextId++, spot, x: p[0], y: p[1], open: false, openedAt: 0, item: ITEMS[Math.floor(rand(s) * ITEMS.length)]! })
      }
    }
    for (const c of s.chests) {
      if (c.open) continue
      for (const a of s.archers) {
        if (!a.alive || !this.inBox(a, c.x, c.y + 0.35, 0.35)) continue
        c.open = true
        c.openedAt = s.time
        s.pickups.push({ id: s.nextId++, item: c.item, x: c.x, y: c.y + 0.6, vy: 5.5, age: 0 })
        this.events.push({ k: "chest", x: c.x, y: c.y, item: c.item, by: a.id })
        break
      }
    }
    s.chests = s.chests.filter((c) => !c.open || s.time - c.openedAt < 2.5)
  }

  private stepPickups(): void {
    const s = this.s
    const keep: Pickup[] = []
    for (const p of s.pickups) {
      p.age += DT
      p.vy *= 0.9
      p.y += p.vy * DT
      let taken = false
      if (p.age > 0.35) {
        for (const a of s.archers) {
          if (!a.alive || !this.inBox(a, p.x, p.y, 0.3)) continue
          if (p.item === "shield") a.shield = true
          else if (p.item === "wings") a.wings = true
          else {
            for (let i = 0; i < 2; i++) a.quiver.unshift(p.item)
            a.quiver.length = Math.min(a.quiver.length, MAX_ARROWS)
          }
          this.events.push({ k: "item", id: a.id, item: p.item, x: p.x, y: p.y })
          taken = true
          break
        }
      }
      if (!taken && p.age < 14) keep.push(p)
    }
    s.pickups = keep
  }
}

export { DIAG }
