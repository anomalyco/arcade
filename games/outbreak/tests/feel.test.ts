import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { sightRects } from "../shared/map"
import { LocalSession } from "../shared/session"
import { supportHeight } from "../shared/terrain"
import { Vision } from "../shared/vision"
import { shotImpacts } from "../src/audio/impacts"
import { BulletImpactFx, IMPACT_LIFE } from "../src/bullet-impacts"
import { DEFAULT_FEEL_TUNING, feelControls } from "../src/feel-tuning"
import { createOutbreakSettings } from "../src/settings"
import { zombieTuning } from "../src/zombie-profile"
import { STRIKE_TIME, StrikeTracker, strikeEnvelope } from "../src/zombie-strikes"
import { ZombieCrowdRenderer } from "../src/zombies"

const idle = { mx: 0, my: 0, aim: 0, interact: false }

describe("bullet impact flash", () => {
  test("a miss flashes where the sound plays, when the round arrives, and is gone after its life", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const p = session.view.player
    Object.assign(p, { x: 31, y: 40, vx: 0, vy: 0, aim: -Math.PI / 2, magAmmo: 4, reserveAmmo: 0 })
    session.update(TICK_DT, { ...idle, aim: -Math.PI / 2, fire: true }, 0)
    const shot = session.view.shots.at(-1)!
    expect(shot.hitZombieId).toBeNull()
    const hits = shotImpacts(session.view.town, shot)
    expect(hits.length).toBeGreaterThan(0)

    const fx = new BulletImpactFx()
    fx.emit(session.view.town, shot)
    const sprites: number[][] = []
    const at = (t: number) => {
      sprites.length = 0
      fx.collect(t, () => 0, (...s) => sprites.push(s))
      return sprites.length
    }
    const arrival = shot.time + hits.at(-1)!.t / 360
    expect(at(arrival - 0.004)).toBe(0)
    expect(at(arrival + 0.01)).toBeGreaterThan(0)
    const flash = sprites.find((s) => s[8] === 0)!
    expect(flash[0]).toBeCloseTo(hits.at(-1)!.x, 3)
    expect(flash[2]).toBeCloseTo(hits.at(-1)!.y, 3)
    expect(at(arrival + IMPACT_LIFE + 0.01)).toBe(0)
    expect(fx.count).toBe(0)
  })

  test("scale 0 draws nothing", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    Object.assign(session.view.player, { x: 31, y: 40, aim: -Math.PI / 2, magAmmo: 4 })
    session.update(TICK_DT, { ...idle, aim: -Math.PI / 2, fire: true }, 0)
    const fx = new BulletImpactFx()
    fx.emit(session.view.town, session.view.shots.at(-1)!)
    let n = 0
    fx.collect(session.view.time + 0.05, () => 0, () => n++, 0)
    expect(n).toBe(0)
  })
})

describe("feel tuning", () => {
  test("every feel knob is a combat setting with today's value as its default", () => {
    const settings = createOutbreakSettings(new URLSearchParams())
    for (const c of feelControls) {
      const key = c.key as keyof typeof DEFAULT_FEEL_TUNING
      expect(settings.combat[key]).toBe(DEFAULT_FEEL_TUNING[key])
    }
    expect(DEFAULT_FEEL_TUNING.hitStopShotKill).toBe(22)
    expect(DEFAULT_FEEL_TUNING.hitStopMeleeHeavy).toBe(44)
  })
})

describe("zombie renderer", () => {
  test("drawing never decays the simulation's hit flash (dead, knocked down and crawling zombies included)", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const town = session.view.town
    const states = ["dead", "knockdown", "crawler", "stagger", "chase"] as const
    const zs = states.map((s, i) => {
      const z = session.ai.spawnZombie(town, 40 + i * 2, 44, s)
      z.hitFlash = 1
      if (s === "crawler") z.detachedLimbs = ["left.thigh", "right.thigh"]
      return z
    })
    const crowd = new ZombieCrowdRenderer({ addModel: () => 0 })
    const vision = new Vision()
    vision.update(44, 44, 0, sightRects(town), { range: 96, cone: 360, awareness: 96 })
    for (let f = 0; f < 6; f++) crowd.draw(session.view.zombies, TICK_DT, (x, z) => supportHeight(town, x, z), vision, [0, 0, 96, 96], zombieTuning, false)
    for (const z of zs) expect(z.hitFlash).toBe(1)
  })
})

describe("camera lead", () => {
  test("no lead trails a sprint by speed / 6; a 1/6 s movement lead centres the survivor", async () => {
    const { Camera } = await import("@arcade/kit/client/camera")
    const { onFootLead } = await import("../src/feel-tuning")
    const trail = (moveLead: number) => {
      const cam = new Camera()
      const p = { x: 0, y: 0, vx: 5.6, vy: 0, aim: 0 }
      for (let i = 0; i < 240; i++) {
        p.x += p.vx / 60
        const lead = onFootLead(p, { cameraMoveLead: moveLead, cameraAimLead: 0 })
        cam.follow(p.x, p.y, lead.x, lead.y, 1 / 60, false)
      }
      return p.x - cam.x
    }
    expect(trail(0)).toBeCloseTo(5.6 / 6, 1)
    expect(Math.abs(trail(1 / 6))).toBeLessThan(0.05)
    expect(trail(0.3)).toBeLessThan(-0.6)
  })

  test("the default lead runs ahead while moving and recentres on a survivor who stops", async () => {
    const { Camera } = await import("@arcade/kit/client/camera")
    const { DEFAULT_CAMERA_LEAD, onFootLead } = await import("../src/feel-tuning")
    expect(DEFAULT_CAMERA_LEAD).toEqual({ cameraMoveLead: 0.3, cameraAimLead: 0 })
    const cam = new Camera()
    const p = { x: 0, y: 0, vx: 3.2, vy: 0, aim: 0 }
    const tick = () => {
      p.x += p.vx / 60
      const lead = onFootLead(p, DEFAULT_CAMERA_LEAD)
      cam.follow(p.x, p.y, lead.x, lead.y, 1 / 60, false)
    }
    for (let i = 0; i < 240; i++) tick()
    expect(cam.x - p.x).toBeGreaterThan(0.3)
    p.vx = 0
    p.aim = 1.2
    for (let i = 0; i < 180; i++) tick()
    expect(Math.hypot(cam.x - p.x, cam.z - p.y)).toBeLessThan(0.01)
  })
})

describe("zombie strike lunge", () => {
  test("the zombie whose attack landed lunges at once, the body pitches in and the hands thrust out, then it settles", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const town = session.view.town
    const p = session.view.player
    Object.assign(p, { x: 44, y: 44, vx: 0, vy: 0, aim: 0 })
    const near = session.ai.spawnZombie(town, 46.2, 44, "chase", Math.PI)
    near.targetX = 44
    near.targetY = 44
    const far = session.ai.spawnZombie(town, 50, 44, "chase", Math.PI)
    const tracker = new StrikeTracker()
    const crowd = new ZombieCrowdRenderer({ addModel: () => 0 })
    const vision = new Vision()
    vision.update(44, 44, 0, sightRects(town), { range: 96, cone: 360, awareness: 96 })
    const draw = () => crowd.draw(session.view.zombies, TICK_DT, (x, z) => supportHeight(town, x, z), vision, [0, 0, 96, 96], zombieTuning, false)
    // How far the elbows sit in front of the zombie's ground position, toward the survivor (it faces -x).
    const hand = () => {
      const b = crowd.getAgentBones(near.id)!.bones as Record<string, { p: number[] }>
      return near.x - Math.min(b["left.foreArm"]!.p[0]!, b["right.foreArm"]!.p[0]!)
    }
    tracker.observe(session.sim.slots, session.view.zombies)
    let struckAt = -1
    let rest = 0
    let peak = -Infinity
    for (let f = 0; f < 120; f++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0)
      for (const id of tracker.observe(session.sim.slots, session.view.zombies)) {
        expect(id).toBe(near.id)
        crowd.strike(id)
        if (struckAt < 0) struckAt = f
      }
      if (struckAt < 0) rest = (draw(), hand())
      else {
        draw()
        if (f - struckAt < 10) peak = Math.max(peak, hand())
      }
    }
    expect(struckAt).toBeGreaterThanOrEqual(0)
    expect(p.health).toBeLessThan(100)
    expect(crowd.strikeAge(far.id)).toBeUndefined()
    // The arms thrust at least 20 cm (0.40 → 0.67 m measured) further toward the survivor within the first frames of the strike.
    expect(peak - rest).toBeGreaterThan(0.2)
  })

  test("the envelope thrusts in 70 ms and is gone by its end", () => {
    expect(strikeEnvelope(0)).toBe(0)
    expect(strikeEnvelope(0.07)).toBeCloseTo(1, 5)
    expect(strikeEnvelope(STRIKE_TIME / 2)).toBeGreaterThan(0.2)
    expect(strikeEnvelope(STRIKE_TIME)).toBe(0)
  })
})
