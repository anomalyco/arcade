import { describe, expect, test } from "bun:test"
import { DEFAULT_MIX, busLevels, loadMix, saveMix } from "../src/sound/mix"
import { LAB_CUES, effectBed, effectSounds } from "../src/sound/cues"
import { DEFAULT_CUES } from "@arcade/kit/audio"

describe("lab mix", () => {
  test("defaults, automation mute and round trip", () => {
    expect(loadMix(null, false)).toEqual({ ...DEFAULT_MIX })
    expect(loadMix(null, true).muted).toBe(true)
    const mix = { ...DEFAULT_MIX, muted: false, volume: 0.35, vehicles: 0.5 }
    expect(loadMix(saveMix(mix), true)).toEqual(mix)
  })
  test("malformed values fall back and levels clamp", () => {
    expect(loadMix("not json", false)).toEqual({ ...DEFAULT_MIX })
    const mix = loadMix(JSON.stringify({ muted: "yes", volume: 4, effects: -1, ui: "loud" }), false)
    expect(mix).toEqual({ ...DEFAULT_MIX, volume: 1, effects: 0 })
  })
  test("groups drive their buses", () => {
    expect(busLevels({ ...DEFAULT_MIX, vehicles: 0.2, effects: 0.3, ambience: 0.4, ui: 0.5 })).toEqual({ engine: 0.2, tyre: 0.2, impact: 0.3, spell: 0.3, ambience: 0.4, ui: 0.5 })
  })
})

describe("scene cues", () => {
  const known = new Set([...LAB_CUES, ...DEFAULT_CUES].map(cue => cue.id))
  test("every effect sound names a registered cue", () => {
    for (const effect of ["explosion", "fireball", "glass", "monitor", "shot", "muzzle", "sparks", "vehicle", "landing", "blood", "pops"]) {
      const sounds = effectSounds(effect, "glass")
      expect(sounds.length).toBeGreaterThan(0)
      for (const sound of sounds) expect(known.has(sound.cue)).toBe(true)
    }
    expect(effectSounds("headlights")).toEqual([])
  })
  test("shots ring glass only on glass", () => {
    expect(effectSounds("shot", "glass").map(s => s.cue)).toEqual(["lab_gunshot", "lab_glass"])
    expect(effectSounds("shot", "wall").map(s => s.cue)).toEqual(["lab_gunshot", "impact_metal_clink"])
  })
  test("fire and water beds", () => {
    expect(effectBed("fire")).toBe("fire")
    expect(effectBed("hydrant")).toBe("water")
    expect(effectBed("explosion")).toBe(null)
    expect(effectBed("explosion", "fire-water")).toBe("fire")
    for (const id of ["lab_fire_bed", "lab_water_bed"]) expect(LAB_CUES.find(cue => cue.id === id)?.loop).toBe(true)
  })
})
