import type { CombatShotEvent } from "../../../outbreak/shared/combat"
import { LocalSession, type Command, type SessionView } from "../../../outbreak/shared/session"
import { DEFAULT_STAMINA_TUNING } from "../../../outbreak/shared/stamina"
import { makeVignetteTown } from "../../../outbreak/src/vignette/presets"

export const STYLE_LOOP_TICKS = 450 // 7.50 s at 60 Hz
export const STYLE_LOOP_DT = 1 / 60
export const STYLE_HERO_TICK = 85 // 1.42 s: shot just fired, muzzle flash + tracer + zombie stagger + collapse

const SHOT_TICKS = new Set([28, 52, 84, 112, 146, 174, 228, 256, 288, 316])

export type ActiveShotSummary = {
  fromX: number
  fromZ: number
  toX: number
  toZ: number
  aim: number
  shotIntensity: number
  hitIntensity: number
  killed: boolean
  seed: number
}

export class StylePlaygroundSim {
  session!: LocalSession
  seed: number
  tick = 0
  private lastShot: CombatShotEvent | null = null

  constructor(seed = 7) {
    this.seed = seed
    this.reset(seed, STYLE_HERO_TICK)
  }

  get view(): SessionView {
    return this.session.view
  }

  get loopTime(): number {
    return Number((this.tick * STYLE_LOOP_DT).toFixed(3))
  }

  reset(seed = this.seed, targetTick = STYLE_HERO_TICK): void {
    this.seed = Math.max(1, Math.min(999, Math.round(seed) || 7))
    this.initCycleZero()
    if (targetTick > 0) {
      this.advanceTicks(targetTick)
    }
  }

  seekToTick(targetTick: number): void {
    const clamped = ((Math.round(targetTick) % STYLE_LOOP_TICKS) + STYLE_LOOP_TICKS) % STYLE_LOOP_TICKS
    if (clamped === this.tick) return
    if (clamped > this.tick) {
      this.advanceTicks(clamped - this.tick)
    } else {
      this.initCycleZero()
      this.advanceTicks(clamped)
    }
  }

  step(dt: number): void {
    const ticks = Math.max(1, Math.min(4, Math.round(dt * 60)))
    for (let i = 0; i < ticks; i++) {
      if (this.tick + 1 >= STYLE_LOOP_TICKS) {
        this.initCycleZero()
      } else {
        this.stepOneTick()
      }
    }
  }

  private initCycleZero(): void {
    this.tick = 0
    this.lastShot = null
    const session = new LocalSession(
      this.seed,
      this.seed,
      0.22,
      {
        zombieCount: 0,
        directorPacing: 0,
        walkSpeed: 0.95,
        chaseSpeed: 1.55,
        aggression: 1.2,
      },
      undefined,
      "classic",
    )
    const town = makeVignetteTown({
      seed: this.seed,
      houseSeed: this.seed,
      foliageDensity: 0.75,
      clutterDensity: 0.85,
      treeSlot: 1,
    })
    // Copy single-lot cutaway room into the classic session's town
    session.sim.town.buildings = town.buildings
    session.sim.town.barriers = town.barriers
    session.sim.town.doors = town.doors
    session.sim.town.windows = town.windows
    session.sim.town.props = town.props
    session.sim.town.lamps = town.lamps
    session.sim.hour = 20.5
    session.rebuildCollision()

    // Place 2 barricade planks on the east window so portal barricade state is exercised
    session.ai.addBarricadePlank("ash-east", 100)
    session.ai.addBarricadePlank("ash-east", 100)

    // Place survivor in the open central floor (clear of the x=27.0 living-room media partition) facing the zombies on the right
    const p = session.view.player
    p.x = 27.65
    p.y = 32.45
    p.vx = 0
    p.vy = 0
    p.aim = -0.06
    p.equippedItem = "pistol"
    p.flashlightOn = true
    p.flashlightOutput = 1

    // Spawn 3 zombies in the right half of the cutaway room
    session.ai.agents.length = 0
    const z1 = session.ai.spawnZombie(session.sim.town, 31.15, 32.05, "chase", Math.PI)
    z1.hp = 95
    const z2 = session.ai.spawnZombie(session.sim.town, 32.05, 31.25, "chase", Math.PI + 0.18)
    z2.hp = 95
    const z3 = session.ai.spawnZombie(session.sim.town, 32.35, 33.05, "chase", Math.PI - 0.18)
    z3.hp = 95

    this.session = session
  }

  private advanceTicks(count: number): void {
    for (let i = 0; i < count; i++) {
      this.stepOneTick()
    }
  }

  private stepOneTick(): void {
    const nextTick = this.tick + 1
    const view = this.session.view
    const p = view.player

    // Spawn second doorway breach wave at tick 200
    if (nextTick === 200) {
      const b1 = this.session.ai.spawnZombie(this.session.sim.town, 28.2, 34.8, "chase", -Math.PI / 2)
      b1.hp = 95
      const b2 = this.session.ai.spawnZombie(this.session.sim.town, 28.0, 30.0, "chase", Math.PI / 2)
      b2.hp = 95
    }

    // Pick nearest living zombie to aim at
    let bestZ = view.zombies.find(z => z.state !== "dead") ?? null
    let bestD = Infinity
    for (const z of view.zombies) {
      if (z.state === "dead") continue
      const d = Math.hypot(z.x - p.x, z.y - p.y)
      if (d < bestD) {
        bestD = d
        bestZ = z
      }
    }

    const aim = bestZ ? Math.atan2(bestZ.y - p.y, bestZ.x - p.x) : -0.05
    // Subtle tactical footwork in the open central floor (x in [27.35, 28.05]) so the shared rig's planted-foot gait is exercised
    let mx = 0
    let my = 0
    if (nextTick >= 10 && nextTick < 70 && p.x > 27.38) {
      mx = -0.28
      my = 0.06
    } else if (nextTick >= 120 && nextTick < 180 && p.x < 27.95) {
      mx = 0.26
      my = -0.05
    }

    const fire = SHOT_TICKS.has(nextTick) && Boolean(bestZ)
    const reload = nextTick === 345

    const cmd: Command = {
      mx,
      my,
      aim,
      interact: false,
      fire,
      reload,
    }

    this.session.update(STYLE_LOOP_DT, cmd, 0, {
      ...DEFAULT_STAMINA_TUNING,
      infiniteAmmo: 1,
    })

    if (view.shots.length > 0) {
      this.lastShot = view.shots[view.shots.length - 1]!
    }
    this.tick = nextTick
  }

  /** Returns the current or most recent gunshot summary for style shaders (muzzle flash, tracer & impact burst). */
  activeShotSummary(): ActiveShotSummary {
    const view = this.session.view
    const p = view.player
    const cosA = Math.cos(p.aim)
    const sinA = Math.sin(p.aim)
    const defFromX = p.x + cosA * 0.36
    const defFromZ = p.y + sinA * 0.36
    const livingZ = view.zombies.find(z => z.state !== "dead") ?? view.zombies[1] ?? view.zombies[0]
    const defToX = livingZ ? livingZ.x : defFromX + cosA * 4.2
    const defToZ = livingZ ? livingZ.y : defFromZ + sinA * 4.2

    const latest = view.shots[view.shots.length - 1] ?? this.lastShot
    if (!latest) {
      return {
        fromX: defFromX,
        fromZ: defFromZ,
        toX: defToX,
        toZ: defToZ,
        aim: p.aim,
        shotIntensity: 0,
        hitIntensity: 0,
        killed: false,
        seed: 1,
      }
    }
    const age = Math.max(0, view.time - latest.time)
    const shotIntensity = Math.max(0, 1 - age / 0.32)
    const hitIntensity = latest.hitZombieId !== null ? Math.max(0, 1 - age / 0.34) : 0
    return {
      fromX: latest.fromX,
      fromZ: latest.fromY,
      toX: latest.toX,
      toZ: latest.toY,
      aim: latest.aim,
      shotIntensity,
      hitIntensity,
      killed: latest.killed,
      seed: (latest.seed % 997) * 0.01,
    }
  }
}
