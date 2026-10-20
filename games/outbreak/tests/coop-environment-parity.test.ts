import { expect, test } from "bun:test"
import { bodySites } from "../shared/bodies/bodies"
import { buildingShells } from "../shared/hearing"
import { sampleWeather, DEFAULT_WEATHER_TUNING } from "../shared/weather/schedule"
import { lightningAt, strikesBetween } from "../shared/weather/lightning"
import { placeAmbientBlood } from "../src/blood/placement"
import { DEFAULT_BLOOD_SETTINGS } from "../src/blood/settings"
import { placeNightLights } from "../src/night-lights/placement"
import { DEFAULT_NIGHT_LIGHT_SETTINGS } from "../src/night-lights/settings"
import { placeDetails, placeCrowFlocks } from "../src/details/placement"
import { DEFAULT_DETAIL_SETTINGS } from "../src/details/settings"
import { CrowFlocks } from "../src/details/crows"
import type { CoopSim } from "../shared/coop-sim"
import { featureRoom } from "./coop-feature-room"

export const scenery = (sim: CoopSim) => ({
  blood: placeAmbientBlood(sim.town, DEFAULT_BLOOD_SETTINGS),
  lights: placeNightLights(sim.town, DEFAULT_NIGHT_LIGHT_SETTINGS),
  details: placeDetails(sim.town, DEFAULT_DETAIL_SETTINGS),
  crows: placeCrowFlocks(sim.town, DEFAULT_DETAIL_SETTINGS, bodySites(sim.town)),
})

test("blood, night lights, details and crow sites match after either player streams and a late join", () => {
  const r = featureRoom()
  try {
    for (const actor of [r.a, r.b]) {
      r.place(actor, 110, 46)
      r.flush()
      const want = scenery(r.core.sim)
      expect(want.blood.length).toBeGreaterThan(0)
      expect(want.details.length).toBeGreaterThan(0)
      for (const c of r.clients) expect(scenery(c.sim)).toEqual(want)
      r.place(actor, 30, 46)
    }
    r.join()
    r.tick(12)
    r.flush()
    for (const c of r.clients) expect(scenery(c.sim)).toEqual(scenery(r.core.sim))
  } finally { r.close() }
})

for (const seat of [0, 1]) test(`seat ${seat}: a shot scatters every client's crows from replicated noise`, () => {
  const r = featureRoom()
  try {
    const actor = r.clients[seat]!
    r.place(actor, 30, 46)
    r.act(actor, { fire: true })
    r.tick(6)
    r.flush()
    for (const sim of [r.core.sim, ...r.clients.map((c) => c.sim)]) {
      const flock = new CrowFlocks()
      // Pin a flock in earshot to isolate the real room noise input from random placement.
      flock.setFlocks("parity", [{ key: "flock", x: 32, z: 46, birds: 3, seed: 7 }])
      let scattered = 0
      flock.onScatter = () => { scattered++ }
      flock.step(1 / 60, sim.time, 5.5, [], sim.ai.noiseBus.events)
      expect(scattered).toBe(1)
    }
  } finally { r.close() }
})

for (const seat of [0, 1]) test(`seat ${seat}: peek is private; opening a window updates every hearing shell`, () => {
  const r = featureRoom()
  try {
    const actor = r.clients[seat]!
    r.place(actor, 24.5, 36.1, -Math.PI / 2)
    r.act(actor, { interact: true })
    r.tick(12)
    r.flush()
    const slot = r.core.sim.slot(actor.id)!
    expect(slot.peek).not.toBeNull()
    expect(actor.view.peek).toEqual(slot.peek)
    expect(r.clients[1 - seat]!.view.peek).toBeNull()
    // The same physical action may be performed by either seat; the private peek never leaks to the other camera.
    const window = r.core.sim.town.windows.find((w) => w.id === slot.survivor.peekingWindowId)!
    expect(window.open).toBe(false)
    r.act(actor, { interact: true, interactAction: "toggle" })
    r.tick(12)
    r.flush()
    expect(window.open).toBe(true)
    const shells = (sim: CoopSim) => buildingShells(sim.town, (id) => sim.ai.portalStates.get(id)?.barricadePlanks ?? 0)
    for (const c of r.clients) expect(shells(c.sim)).toEqual(shells(r.core.sim))
    r.join()
    r.tick(12)
    r.flush()
    for (const c of r.clients) expect(shells(c.sim)).toEqual(shells(r.core.sim))
  } finally { r.close() }
})

test("weather and lightning schedule derive from the room clock for both peers and late joiners", () => {
  const r = featureRoom()
  try {
    const states = new Set<string>()
    // Fixed clock checkpoints cover every weather kind without simulating an hour of AI.
    for (const time of [30, 420, 940, 1410, 2400, 3000, 3600]) {
      r.core.sim.time = time
      r.core.sim.hour = 22
      r.tick(12)
      r.flush()
      for (const c of r.clients) {
        const s = c.snapHistory.get(c.lastServerTick)!
        expect(s.time).toBeCloseTo(r.core.sim.time, 3)
        expect(s.hour).toBeCloseTo(r.core.sim.hour, 2)
        const weather = sampleWeather(c.sim.town.seed, s.time, s.hour)
        states.add(weather.state)
        const want = sampleWeather(r.core.sim.town.seed, s.time, s.hour)
        expect(weather).toEqual(want)
        expect(lightningAt(c.sim.town.seed, s.time, s.hour, DEFAULT_WEATHER_TUNING)).toBe(lightningAt(r.core.sim.town.seed, s.time, s.hour, DEFAULT_WEATHER_TUNING))
        expect(strikesBetween(c.sim.town.seed, s.time - 1, s.time, s.hour, DEFAULT_WEATHER_TUNING)).toEqual(strikesBetween(r.core.sim.town.seed, s.time - 1, s.time, s.hour, DEFAULT_WEATHER_TUNING))
      }
    }
    expect(states.size).toBe(4)
    r.join()
    r.tick(12)
    r.flush()
    for (const c of r.clients) expect(sampleWeather(c.sim.town.seed, 3600, 22)).toEqual(sampleWeather(r.core.sim.town.seed, 3600, 22))
  } finally { r.close() }
})
