import { describe, expect, test } from "bun:test"
import { LabNavigation } from "../lab-navigation"
import { DeterministicOfflineAudioContext } from "./test-context"
import {
  ActivationGate,
  AudioRuntime,
  blocked,
  createAudioLabController,
  createBoxOcclusionQuery,
  Gearbox,
  character,
  renderOcclusionReverbAb,
  renderWorldSignalReplayOffline,
  SpellAudioEmitter,
  tyreSlip,
  VehicleAudioEmitter,
  bindVolumeControls,
  busVolume,
  DEFAULT_VOLUME_SETTINGS,
  loadVolumeSettings,
  saveVolumeSettings,
  selectSfx,
  sfxCues,
  sfxManifest,
  synthesizeFallbackPcm,
  volumeControls,
  volumeStorageKey,
} from "@arcade/kit/audio"

function createTestRuntime(seed = 7, maxVoices = 12) {
  const ctx = new DeterministicOfflineAudioContext(2, 48000 * 4, 48000) as unknown as OfflineAudioContext
  return {
    ctx,
    runtime: new AudioRuntime({
      context: ctx,
      seed,
      maxVoices,
    }),
  }
}

describe("seeded sample selection and recipe variation", () => {
  test("same seed produces identical round-robin and weighted sample sequences without immediate repeats", () => {
    const { runtime: a } = createTestRuntime(42)
    const { runtime: b } = createTestRuntime(42)

    const seqA: string[] = []
    const seqB: string[] = []
    for (let i = 0; i < 16; i++) {
      a.scheduleTime = i * 0.25
      b.scheduleTime = i * 0.25
      const ha = a.playCue("impact_crash_layered", { intensity: 0.9 })
      const hb = b.playCue("impact_crash_layered", { intensity: 0.9 })
      expect(ha?.samplesPicked).toEqual(hb?.samplesPicked)
      seqA.push(ha!.samplesPicked[0]!)
      seqB.push(hb!.samplesPicked[0]!)
      if (i > 0) {
        expect(seqA[i]).not.toBe(seqA[i - 1])
      }
    }
    expect(seqA).toEqual(seqB)

    // Resetting the seed reproduces the exact sequence from the start
    a.setSeed(42)
    a.reset()
    const seqReset: string[] = []
    for (let i = 0; i < 16; i++) {
      a.scheduleTime = i * 0.25
      const h = a.playCue("impact_crash_layered", { intensity: 0.9 })
      seqReset.push(h!.samplesPicked[0]!)
    }
    expect(seqReset).toEqual(seqA)
  })
})

describe("activation gate and world-driven emitters", () => {
  test("held boost or spell charge exhausts once and cannot re-ignite on fuel/mana refill until released", () => {
    const gate = new ActivationGate()
    let ignitions = 0
    for (let i = 0; i < 300; i++) {
      const fuel = i < 90 ? Math.max(0, 1 - Math.floor(i / 5) / 15) : 0.65
      gate.update(true, fuel, 1 / 60)
      ignitions += Number(gate.ignited)
      if (i >= 75) expect(gate.active).toBe(false)
    }
    expect(ignitions).toBe(1)

    // Release and press again -> second ignition
    gate.update(false, 1, 1 / 60)
    gate.update(true, 1, 1 / 60)
    expect(gate.ignited).toBe(true)
    expect(gate.activations).toBe(2)

    // Cancel during hold requires a fresh release before re-arming
    gate.cancel()
    for (let i = 0; i < 30; i++) {
      gate.update(true, 1, 1 / 60)
      expect(gate.active).toBe(false)
      expect(gate.ignited).toBe(false)
    }
    gate.update(false, 1, 1 / 60)
    gate.update(true, 1, 1 / 60)
    expect(gate.ignited).toBe(true)
  })

  test("vehicle and spell emitters enforce cooldowns, re-arm hysteresis, and idempotent stop()", () => {
    const { runtime } = createTestRuntime(7)
    const vehicle = new VehicleAudioEmitter(runtime, { id: "car-1", vehicleClass: "muscle" })
    const spell = new SpellAudioEmitter(runtime, { id: "mage-1" })

    // Continuous wall rubbing at constant force triggers once, not every frame
    let hits = 0
    for (let i = 0; i < 60; i++) {
      runtime.scheduleTime = i / 60
      vehicle.update({ speed: 20, throttle: 0.8, boost: true, fuel: 1 }, 1 / 60)
      if (vehicle.stepImpact(0.55, 1 / 60, "metal")) hits++
    }
    expect(hits).toBe(1)
    expect(vehicle.nitroState.ignitions).toBe(1)
    expect(vehicle.isActive).toBe(true)

    // Spell charge interrupted by stop() never fires a cast burst
    for (let i = 60; i < 100; i++) {
      runtime.scheduleTime = i / 60
      spell.update({ active: true, mana: 1 }, 1 / 60)
    }
    expect(spell.isActive).toBe(true)
    expect(spell.casts).toBe(0)

    // Idempotent stop
    vehicle.stop()
    vehicle.stop()
    spell.stop()
    spell.stop()
    expect(vehicle.isActive).toBe(false)
    expect(vehicle.nitroState.active).toBe(false)
    expect(spell.isActive).toBe(false)
    expect(spell.casts).toBe(0)
  })

  test("gearbox and tyre slip preserve approved Getaway drivetrain curves", () => {
    const g = new Gearbox(character("muscle"))
    for (let i = 0; i < 60; i++) g.update(0, 0, false, 1 / 60)
    expect(g.rpm).toBe(g.spec.idle)

    expect(tyreSlip(28, 0, 0, false).squeal).toBe(0)
    expect(tyreSlip(28, 12, 0, false, false, "road").squeal).toBeGreaterThan(0.2)
    expect(tyreSlip(28, 12, 0, false, true, "road").squeal).toBe(0)
    expect(tyreSlip(28, 12, 0, false, false, "grass").squeal).toBeLessThan(0.1)
  })
})

describe("voice budget, cooldowns, stealing policies, and listener cleanup", () => {
  test("enforces per-cue cooldown, drop policy, steal-oldest policy, and replace policy", () => {
    const { runtime } = createTestRuntime(11, 4)

    // "tyre_slide_bark" has cooldownSeconds: 0.35 and steal: "drop"
    runtime.scheduleTime = 0
    const first = runtime.playCue("tyre_slide_bark")
    expect(first).not.toBeNull()
    runtime.scheduleTime = 0.1
    const secondDuringCooldown = runtime.playCue("tyre_slide_bark")
    expect(secondDuringCooldown).toBeNull()
    expect(runtime.telemetry().droppedVoices).toBe(1)

    // "spell_arcane_cast" uses steal: "replace" -> retriggering replaces prior voice of same ownerKey
    runtime.scheduleTime = 0.5
    const s1 = runtime.playCue("spell_arcane_cast")
    runtime.scheduleTime = 0.7
    const s2 = runtime.playCue("spell_arcane_cast")
    expect(s1?.active).toBe(false)
    expect(s2?.active).toBe(true)

    // Global maxVoices = 4 with "steal-oldest" on "impact_metal_clink" (cooldown 0.04)
    for (let i = 0; i < 8; i++) {
      runtime.scheduleTime = 1.0 + i * 0.05
      runtime.playCue("impact_metal_clink")
    }
    const tel = runtime.telemetry()
    expect(tel.activeVoices).toBeLessThanOrEqual(4)
    expect(tel.stolenVoices).toBeGreaterThan(0)
  })

  test("spatialization, Doppler, box occlusion query, mute listener cleanup, and dispose", () => {
    const wall = { x0: 4, x1: 8, z0: -10, z1: 10, h: 6 }
    expect(blocked(0, 0, 12, 0, wall)).toBe(true)
    expect(blocked(0, 15, 12, 15, wall)).toBe(false)

    const { runtime } = createTestRuntime(7)
    runtime.visibilityQuery = createBoxOcclusionQuery([wall])
    runtime.setListener({ x: 0, z: 0, vx: 0, vz: 0, rightX: 1, rightZ: 0, earHeight: 16 })

    const openMix = runtime.spatialize({ x: 0, z: 15, vx: 0, vz: -20 })
    const occMix = runtime.spatialize({ x: 15, z: 0, vx: -20, vz: 0 })
    expect(openMix.occlusion).toBe(0)
    expect(occMix.occlusion).toBeGreaterThan(0)
    expect(occMix.cutoffHz).toBeLessThan(openMix.cutoffHz)
    expect(occMix.wet).toBeGreaterThan(openMix.wet)
    expect(openMix.doppler).toBeGreaterThan(1)

    const states: boolean[] = []
    const unsub = runtime.onMute(m => states.push(m))
    runtime.setMuted(true)
    unsub()
    runtime.setMuted(false)
    expect(states).toEqual([false, true])

    runtime.scheduleTime = 0.2
    const v = runtime.playCue("ui_confirm")
    expect(v?.active).toBe(true)
    runtime.dispose()
    expect(v?.active).toBe(false)
    expect(runtime.playCue("ui_confirm")).toBeNull()
  })
})

describe("offline deterministic rendering, clip protection, silence windows, and A/B proof", () => {
  test("occlusion and reverb A/B render is clip-free, darkens occluded spectrum, and extends reverb tail", async () => {
    const ab = await renderOcclusionReverbAb(7, DeterministicOfflineAudioContext as unknown as typeof OfflineAudioContext)
    expect(ab.dryOpen.stats.clippedSamples).toBe(0)
    expect(ab.reverbOccluded.stats.clippedSamples).toBe(0)
    expect(ab.dryOpen.stats.peak).toBeGreaterThan(0.05)
    expect(ab.dryOpen.stats.peak).toBeLessThan(1.0)
    expect(ab.reverbOccluded.stats.peak).toBeGreaterThan(0.03)
    expect(ab.reverbOccluded.stats.peak).toBeLessThan(1.0)

    // Occluded variant has lower spectral centroid and stronger reverb tail energy
    expect(ab.delta.centroidDropHz).toBeGreaterThan(100)
    expect(ab.delta.reverbTailGainRatio).toBeGreaterThan(1.4)
    expect(ab.dryOpen.wav.byteLength).toBeGreaterThan(44)
    expect(ab.reverbOccluded.wav.byteLength).toBe(ab.dryOpen.wav.byteLength)
  })

  test("world-signal chase and spell-cycle replays are deterministic, clip-free, and silent after stop", async () => {
    const run1 = await renderWorldSignalReplayOffline("chase", 7, DeterministicOfflineAudioContext as unknown as typeof OfflineAudioContext)
    const run2 = await renderWorldSignalReplayOffline("chase", 7, DeterministicOfflineAudioContext as unknown as typeof OfflineAudioContext)

    expect(run1.events).toEqual(run2.events)
    expect(run1.events.nitroIgnitions).toBe(2)
    expect(run1.events.impacts.length).toBe(2)
    expect(run1.events.shifts.length).toBeGreaterThanOrEqual(2)
    expect(run1.stats.clippedSamples).toBe(0)
    expect(run1.stats.peak).toBeGreaterThan(0.05)
    expect(run1.stats.peak).toBeLessThan(1.0)
    // Quiet window [5.25s, 5.92s] after stop() at 5.0s must be silent
    expect(run1.stats.quietWindowRms[0]).toBeLessThan(1e-4)

    const spellRun = await renderWorldSignalReplayOffline("spell_cycle", 7, DeterministicOfflineAudioContext as unknown as typeof OfflineAudioContext)
    expect(spellRun.events.spellActivations).toBe(2)
    // First charge released normally -> 1 cast; second charge depleted mana mid-hold -> no cast!
    expect(spellRun.events.spellCasts).toBe(1)
    expect(spellRun.stats.clippedSamples).toBe(0)
    expect(spellRun.stats.quietWindowRms[0]).toBeLessThan(1e-4)
  })

  test("Audio Lab controller registers compatible LabSection and supports group randomize/reset/copy", async () => {
    const lab = createAudioLabController(undefined, { offlineContext: DeterministicOfflineAudioContext as unknown as typeof OfflineAudioContext })
    expect(lab.section.id).toBe("audio")
    const nav = new LabNavigation(lab.section.settings, [...lab.section.controls])
    expect(nav.search("reverb")[0]?.control?.key).toBe("reverbWet")

    const variationRow = nav.rows.find(r => r.group === "Variation" && !r.control)!
    nav.jump(variationRow)
    nav.randomize("Variation")
    expect(Number(lab.section.settings.seed)).toBeGreaterThanOrEqual(1)
    nav.reset(true)
    expect(lab.section.settings.seed).toBe(7)
    expect(JSON.parse(nav.json("Variation")).seed).toBe(7)

    const stats = await lab.triggerCurrent()
    expect(stats).not.toBeNull()
    expect(stats!.clippedSamples).toBe(0)
    expect(lab.section.telemetry!()).toContain("dBFS")
    lab.dispose()
  })
})

describe("samples still loading", () => {
  test("a cue whose sample is still on its way is skipped, not played as its loud synthesized stand-in", () => {
    const entries = selectSfx(["game:outbreak"]).filter((e) => e.id === "ambience.threat")
    const ctx = new DeterministicOfflineAudioContext(2, 48000 * 4, 48000) as unknown as OfflineAudioContext
    const runtime = new AudioRuntime({ context: ctx, manifest: sfxManifest(entries), cues: sfxCues(entries) })
    runtime.sampleBank.loadingInFlight = true
    expect(runtime.playCue("ambience.threat")).toBeNull()
    expect(runtime.telemetry().pendingSkips).toBe(1)
    expect(runtime.telemetry().activeVoices).toBe(0)
    // Once loading ends (here: failed, so the stand-in is all there is) the cue plays.
    runtime.sampleBank.loadingInFlight = false
    expect(runtime.playCue("ambience.threat")).not.toBeNull()
  })

  test("a looped stand-in sits near the beds' loudness, not 16 dB over it", () => {
    const meta = sfxManifest(selectSfx(["game:outbreak"])).find((m) => m.id.startsWith("ambience.night.suburb"))!
    const pcm = synthesizeFallbackPcm(meta, 48000)
    const ch = pcm.channels[0]!
    let sum = 0
    for (const v of ch) sum += v * v
    const rmsDb = 10 * Math.log10(sum / ch.length)
    expect(rmsDb).toBeLessThan(-25)
    expect(rmsDb).toBeGreaterThan(-35)
  })
})

describe("player volume", () => {
  test("channels scale their buses, save per game, and a game shows only the channels it has", () => {
    const s = { ...DEFAULT_VOLUME_SETTINGS, volumeEffects: 50, volumeAmbience: 25, volumeVoice: 0 }
    expect(busVolume(s, "weapon")).toBe(0.5)
    expect(busVolume(s, "foley")).toBe(0.5)
    expect(busVolume(s, "ambience")).toBe(0.25)
    expect(busVolume(s, "voice")).toBe(0)
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    const json = saveVolumeSettings(storage, "demo", s)
    expect(store.get(volumeStorageKey("demo"))).toBe(json)
    store.set(volumeStorageKey("demo"), JSON.stringify({ ...JSON.parse(json), volumeMaster: 300 }))
    const loaded = { ...DEFAULT_VOLUME_SETTINGS }
    expect(loadVolumeSettings(storage, "demo", loaded)).toBe(true)
    expect(loaded).toEqual({ ...s, volumeMaster: DEFAULT_VOLUME_SETTINGS.volumeMaster })
    expect(loadVolumeSettings(storage, "other", loaded)).toBe(false)
    expect(volumeControls(["master", "effects", "ambience", "voice"], "Volume", { voice: "Zombie voices" }).map((c) => c.label)).toEqual(["Master", "Effects", "Ambience", "Zombie voices"])

    let muted = false
    let changes = 0
    const volumes = { ...DEFAULT_VOLUME_SETTINGS }
    let addedBag: Record<string, boolean | number | string> = {}
    let addedControls: { key: string; label: string }[] = []
    bindVolumeControls(
      {
        addControls(bag, controls) {
          addedBag = bag
          addedControls = controls
        },
      },
      {
        volumes,
        channels: ["master", "effects", "ambience"],
        getMuted: () => muted,
        setMuted: (m) => {
          muted = m
        },
        onChange: () => {
          changes++
        },
      },
    )
    expect(addedControls.map((c) => c.key)).toEqual(["audioMuted", "volumeMaster", "volumeEffects", "volumeAmbience"])
    addedBag.audioMuted = true
    expect(muted).toBe(true)
    addedBag.volumeEffects = 45
    expect(volumes.volumeEffects).toBe(45)
    expect(changes).toBe(1)
  })
})
