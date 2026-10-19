import { describe, expect, test } from "bun:test"
import { crowdHearingReach, DEFAULT_AI_CONFIG } from "../shared/ai"
import { cueFrame, cueLabel, cueSource, edgeAnchor, FADE_IN, SoundCueModel, springStep, WAVE_TIME, type NoiseLike } from "../src/sound-cues/model"

const noise = (id: number, kind: string, sourceId = "player", radius = 32): NoiseLike => ({ id, x: 10, y: 10, radius, kind, sourceId, time: 0 })
const allies = new Set(["bob"])
const reachOf = (n: NoiseLike) => ({ reach: n.radius * 0.75, outside: null })

describe("which noises become cues", () => {
  test("each new noise once, footsteps never, and the oldest go past a dozen", () => {
    const m = new SoundCueModel()
    m.observe([noise(1, "gunshot"), noise(2, "footstep"), noise(3, "sprint")], "player", allies, 0, reachOf)
    expect(m.cues.map((c) => c.kind)).toEqual(["gunshot"])
    m.observe([noise(1, "gunshot"), noise(4, "glass", "bob")], "player", allies, 0.1, reachOf)
    expect(m.cues.map((c) => c.id)).toEqual([1, 4])
    m.observe(Array.from({ length: 20 }, (_, i) => noise(10 + i, "bash", "zombie-3")), "player", allies, 0.2, reachOf)
    expect(m.cues.length).toBe(12)
    expect(m.cues.at(-1)!.id).toBe(29)
  })

  test("cues leave when their life is up, and a restarted bus starts over", () => {
    const m = new SoundCueModel()
    m.observe([noise(5, "door", "player", 5.5)], "player", allies, 0, reachOf)
    expect(m.cues.length).toBe(1)
    m.observe([], "player", allies, 10, reachOf)
    expect(m.cues.length).toBe(0)
    m.observe([noise(1, "gunshot")], "player", allies, 11, reachOf)
    expect(m.cues.map((c) => c.id)).toEqual([1])
  })

  test("names and owners", () => {
    expect(cueLabel("gunshot")).toBe("Shot")
    expect(cueLabel("reload")).toBe("Reload")
    expect(cueLabel("whatever")).toBe("Noise")
    expect(cueSource("player", "player", allies)).toBe("self")
    expect(cueSource("bob", "player", allies)).toBe("ally")
    expect(cueSource("zombie-12", "player", allies)).toBe("dead")
    expect(cueSource("radio", "player", allies)).toBe("world")
  })

  test("the ring is the reach the dead have: hearing scale and the night", () => {
    const day = crowdHearingReach(DEFAULT_AI_CONFIG, 0)
    const night = crowdHearingReach(DEFAULT_AI_CONFIG, 1)
    expect(day).toBeCloseTo(0.75 * Math.sqrt(0.68))
    expect(night).toBeCloseTo(0.75 * Math.sqrt(0.68 + 0.32 + 0.4))
  })
})

describe("motion", () => {
  test("fades in, the wave runs out once and eases, then everything fades out together; nothing pops", () => {
    const life = 1.6
    expect(cueFrame(0, life).alpha).toBe(0)
    expect(cueFrame(FADE_IN, life).alpha).toBeCloseTo(1)
    expect(cueFrame(WAVE_TIME * 0.5, life).wave).toBeGreaterThan(0.8)
    expect(cueFrame(WAVE_TIME, life).waveAlpha).toBe(0)
    expect(cueFrame(life, life).alpha).toBeCloseTo(0)
    let prev = 0
    for (let t = 0; t <= life; t += 1 / 60) {
      const a = cueFrame(t, life).alpha
      expect(Math.abs(a - prev)).toBeLessThan(0.25)
      prev = a
    }
  })

  test("reduced motion keeps the fades and drops the travel", () => {
    const f = cueFrame(0.05, 1.6, true)
    expect(f.wave).toBe(1)
    expect(f.waveAlpha).toBe(0)
    expect(f.lift).toBe(0)
  })

  test("the spring settles without overshoot", () => {
    const s = { v: 0, dv: 0 }
    let max = 0
    for (let i = 0; i < 120; i++) {
      springStep(s, 1, 1 / 60, 0.3)
      max = Math.max(max, s.v)
    }
    expect(max).toBeLessThanOrEqual(1.0001)
    expect(s.v).toBeCloseTo(1, 3)
  })

  test("edge arrows sit on the border along the line from the centre", () => {
    expect(edgeAnchor(500, 300, 1000, 600, 30)).toBeNull()
    const right = edgeAnchor(2000, 300, 1000, 600, 30)!
    expect(right.x).toBeCloseTo(970)
    expect(right.y).toBeCloseTo(300)
    const corner = edgeAnchor(-500, -500, 1000, 600, 30)!
    expect(corner.y).toBeCloseTo(30)
    expect(corner.x).toBeGreaterThan(30)
  })
})
