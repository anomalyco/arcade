import { afterAll, describe, expect, test } from "bun:test"
import { CoopSim } from "../shared/coop-sim"
import { DEFAULT_SECRETS_TUNING } from "../shared/secrets/catalog"
import { workLock, type SecretsState } from "../shared/secrets/cellar"
import { secretSitesIn } from "../shared/secrets/places"
import { PULSE_GAP, PULSE_ON, PULSE_PAUSE, secretRun } from "../shared/secrets/select"
import { clearAmbientCalls, drainAmbientCalls } from "../src/audio/soundscape/hooks"
import { SecretSounds } from "../src/audio/soundscape/secrets"
import { soundWorld } from "../src/audio/world"

/** A run with the radio man's cellar, its house streamed in. */
function atCellar() {
  for (let i = 0; i < 200; i++) {
    const seed = 1 + i * 7919
    if (!secretRun({ seed, houseSeed: seed }, DEFAULT_SECRETS_TUNING).picked.has("cellar")) continue
    const sim = new CoopSim(seed, seed)
    sim.addSurvivor("a", 0)
    const state = sim.getFeatureState<SecretsState>("secrets")!
    const host = state.hosts.get("cellar")!
    Object.assign(sim.slots[0]!.survivor, { x: (host.rect[0] + host.rect[2]) / 2, y: host.rect[3] + 3 })
    sim.syncWorldChunks()
    const b = sim.town.buildings.find((x) => x.id === state.hatch!.buildingId)!
    const sites = secretSitesIn(sim.town, b, state.run, state.hosts)
    return { sim, state, set: sites.find((s) => s.piece === "set")!, clock: sites.find((s) => s.piece === "clock")! }
  }
  throw new Error("no cellar in 200 seeds")
}

function heard(sounds: SecretSounds, sim: CoopSim, time: number, at: { x: number; y: number }): string[] {
  const ids: string[] = []
  sounds.update({ ...soundWorld(sim), time }, at)
  drainAmbientCalls((c) => ids.push(c.id), (h) => ids.push(`hold:${h.id}`))
  return ids
}

describe("secret sounds (AR-85 through the soundscape)", () => {
  const { sim, state, set, clock } = atCellar()
  afterAll(clearAmbientCalls)

  test("his set hisses and beeps once per lit pulse: the number, then a pause", () => {
    const sounds = new SecretSounds()
    drainAmbientCalls(() => {}, () => {})
    const n = state.run.pulses
    const period = n * (PULSE_ON + PULSE_GAP) + PULSE_PAUSE
    let pips = 0
    let hiss = 0
    const at = { x: set.x + 1, y: set.y }
    for (let t = 100; t < 100 + period * 2; t += 1 / 60) {
      const ids = heard(sounds, sim, t, at)
      pips += ids.filter((i) => i === "scape.secret.pip").length
      if (ids.includes("hold:scape.secret.static")) hiss++
    }
    expect(pips).toBeGreaterThanOrEqual(n * 2 - 1)
    expect(pips).toBeLessThanOrEqual(n * 2 + 1)
    expect(hiss).toBeGreaterThan(0)
    // Out of earshot: let the last hold lapse (holds outlive one drain), then nothing is asked for.
    drainAmbientCalls(() => {}, () => {})
    drainAmbientCalls(() => {}, () => {})
    expect(heard(new SecretSounds(), sim, 0, { x: set.x + 40, y: set.y })).not.toContain("hold:scape.secret.static")
  })

  test("a stopped clock's hand ticks once a second at the mark it never passes", () => {
    const sounds = new SecretSounds()
    drainAmbientCalls(() => {}, () => {})
    let ticks = 0
    for (let t = 50; t < 60; t += 1 / 60) ticks += heard(sounds, sim, t, { x: clock.x, y: clock.y + 1 }).filter((i) => i === "scape.secret.twitch").length
    expect(ticks).toBeGreaterThanOrEqual(9)
    expect(ticks).toBeLessThanOrEqual(11 * 2)
  })

  test("the padlock clicks a notch per turn and gives when it opens; joining late hears nothing old", () => {
    const sounds = new SecretSounds()
    drainAmbientCalls(() => {}, () => {})
    const hatch = state.hatch!
    const at = { x: hatch.x + 1, y: hatch.y }
    workLock(sim, state, false)
    // The first look only learns the lock.
    expect(heard(sounds, sim, 10, at).filter((i) => i.startsWith("scape.secret.dial"))).toEqual([])
    workLock(sim, state, false)
    expect(heard(sounds, sim, 10.1, at)).toContain("scape.secret.dial")
    const [a, d, c] = state.run.code
    // Back to 0 on the first dial, then the code.
    for (let k = 0; k < (10 - 2 + a) % 10; k++) workLock(sim, state, false)
    workLock(sim, state, true)
    for (let k = 0; k < d; k++) workLock(sim, state, false)
    workLock(sim, state, true)
    for (let k = 0; k < c; k++) workLock(sim, state, false)
    const ids = heard(sounds, sim, 10.2, at)
    expect(ids).toContain("scape.secret.unlock")
    expect(ids).toContain("scape.secret.hatch")
    expect(heard(sounds, sim, 10.3, at)).not.toContain("scape.secret.unlock")
  })
})
