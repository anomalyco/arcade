import { describe, expect, test } from "bun:test"
import { ByteReader, ByteWriter } from "@arcade/kit/net/bytes"
import { DEFAULT_INTEREST } from "@arcade/kit/net/interest"
import { CoopSim } from "../shared/coop-sim"
import { outbreakSharedFeatures, OutbreakSharedFeatureRegistry } from "../shared/feature-registry"
import { outbreakClientFeatures, OutbreakClientFeatureRegistry } from "../src/feature-registry"
import { outbreakMapFeature } from "../src/map"
import { outbreakMeleeFeature, outbreakMeleeSharedFeature } from "../src/melee/index"
import { outbreakPacingFeature, outbreakPacingSharedFeature } from "../src/pacing"
import { outbreakProgressionFeature, outbreakProgressionSharedFeature } from "../src/progression"
import { outbreakVehiclesFeature, outbreakVehiclesSharedFeature } from "../src/vehicles/index"
import { outbreakWeatherFeature } from "../src/weather"

describe("OutbreakSharedFeatureRegistry", () => {
  test("sorts registered features deterministically by order then id regardless of registration order", () => {
    const registry = new OutbreakSharedFeatureRegistry()
    registry.register({ id: "weather", order: 30 })
    registry.register({ id: "melee", order: 20 })
    registry.register({ id: "vehicles", order: 10 })
    registry.register({ id: "map", order: 20 })

    expect(registry.list().map((f) => f.id)).toEqual(["vehicles", "map", "melee", "weather"])
  })

  test("creates and clones per-simulation feature state purely without shared mutable singletons", () => {
    const registry = new OutbreakSharedFeatureRegistry()
    registry.register<{ ticks: number; history: number[] }>({
      id: "counter",
      createState: () => ({ ticks: 0, history: [1, 2] }),
      cloneState: (state) => ({ ticks: state.ticks, history: [...state.history] }),
    })

    const simA = new CoopSim(11, 7, 0.22, { zombieCount: 0 }, undefined, "classic")
    const simB = new CoopSim(11, 7, 0.22, { zombieCount: 0 }, undefined, "classic")

    const statesA = registry.createSimStates(simA)
    const stateA = statesA.get("counter") as { ticks: number; history: number[] }
    stateA.ticks = 5
    stateA.history.push(3)

    const statesB = registry.cloneSimStates(statesA, simB, simA)
    const stateB = statesB.get("counter") as { ticks: number; history: number[] }
    expect(stateB).toEqual({ ticks: 5, history: [1, 2, 3] })

    // Mutating the forked state must never affect the original simulation's state
    stateB.ticks = 99
    stateB.history.push(4)
    expect(stateA).toEqual({ ticks: 5, history: [1, 2, 3] })
  })

  test("resolves tuning namespaces from both namespaced and legacy flat session tuning objects", () => {
    const registry = new OutbreakSharedFeatureRegistry()
    registry.register({
      id: "melee",
      tuning: {
        namespace: "melee",
        legacyNamespaces: ["combat"],
        defaults: { swingSpeed: 1.0, staminaCost: 0.2 },
      },
    })
    registry.register({
      id: "vehicles",
      tuning: {
        namespace: "vehicle",
        defaults: { maxSpeed: 14, engineNoise: 28 },
      },
    })

    // Namespaced tuning with legacy combat fallback overridden by explicit melee namespace
    const fromNamespaced = registry.resolveTuningNamespaces({
      combat: { swingSpeed: 1.25, staminaCost: 0.35 },
      melee: { swingSpeed: 1.5 },
      vehicle: { maxSpeed: 18 },
    })
    expect(fromNamespaced.melee).toEqual({ swingSpeed: 1.5, staminaCost: 0.35 })
    expect(fromNamespaced.vehicle).toEqual({ maxSpeed: 18, engineNoise: 28 })

    // Legacy flat tuning
    const fromFlat = registry.resolveTuningNamespaces({
      swingSpeed: 1.4,
      engineNoise: 20,
    })
    expect(fromFlat.melee).toEqual({ swingSpeed: 1.4, staminaCost: 0.2 })
    expect(fromFlat.vehicle).toEqual({ maxSpeed: 14, engineNoise: 20 })
  })

  test("encodes and decodes binary snapshot sections via registered codecs", () => {
    const registry = new OutbreakSharedFeatureRegistry()
    registry.register<{ count: number }, number[]>({
      id: "sample-sec",
      createState: () => ({ count: 3 }),
      netSection: {
        bit: 64,
        key: "sample",
        collect: ({ state }) => ({
          snapshotValue: [state.count, state.count * 2],
          shouldWrite: state.count > 0,
          writePayload: [state.count, state.count * 2],
        }),
        encode: (w, payload) => {
          w.uvar(payload.length)
          for (const n of payload) w.u16(n)
        },
        decode: (r) => {
          const len = r.uvar()
          const out: number[] = []
          for (let i = 0; i < len; i++) out.push(r.u16())
          return out
        },
      },
    })

    const sim = new CoopSim(11, 7, 0.22, { zombieCount: 0 }, undefined, "classic")
    const states = registry.createSimStates(sim)
    const entry = registry.netSections()[0]!
    const collected = entry.codec.collect({
      sim,
      tick: 6,
      isDelta: false,
      interest: DEFAULT_INTEREST,
      bubbleCx: 48,
      bubbleCy: 48,
      state: states.get("sample-sec"),
    })
    expect(collected.shouldWrite).toBe(true)
    expect(collected.snapshotValue).toEqual([3, 6])

    const writer = new ByteWriter(32)
    entry.codec.encode(writer, collected.writePayload!, { sim, tick: 6, isDelta: false })
    const decoded = entry.codec.decode(new ByteReader(writer.finish()), { tick: 6, time: 0.1, isDelta: false })
    expect(decoded).toEqual([3, 6])
  })
})

describe("OutbreakClientFeatureRegistry", () => {
  test("collects Lab controls, game commands, harness methods/state, and feel hooks in deterministic order", () => {
    const client = new OutbreakClientFeatureRegistry()
    const orderLog: string[] = []

    client.register({
      id: "weather",
      order: 20,
      labControls: () => [{ key: "weatherEnabled", label: "Weather", group: "Weather" }],
      gameCommands: () => [
        {
          id: "weather.strike",
          label: "Strike",
          shortLabel: "Strike",
          category: "Scene",
          undoable: false,
          enabled: () => true,
          run: () => ({ ok: true }),
        },
      ],
      harnessMethods: () => ({
        strikeLightning: () => "boom",
      }),
      harnessState: () => ({
        weather: { active: true },
      }),
      feel: {
        reset: () => {
          orderLog.push("reset:weather")
        },
        processFrame: (ctx) => {
          orderLog.push("frame:weather")
          return ctx.addCount + 2
        },
      },
    })

    client.register({
      id: "melee",
      order: 10,
      labControls: () => [{ key: "meleeDamageScale", label: "Melee Damage", group: "Melee", min: 0.5, max: 2, step: 0.1 }],
      harnessMethods: () => ({
        stageMelee: (wpn = "crowbar") => ({ weapon: wpn }),
      }),
      feel: {
        reset: () => {
          orderLog.push("reset:melee")
        },
        processFrame: (ctx) => {
          orderLog.push("frame:melee")
          return ctx.addCount + 1
        },
      },
    })

    const controls = client.collectLabControls({} as any)
    expect(controls.map((c) => c.key)).toEqual(["meleeDamageScale", "weatherEnabled"])

    const commands = client.collectGameCommands({} as any)
    expect(commands.map((c) => c.id)).toEqual(["weather.strike"])

    const methods = client.collectHarnessMethods({} as any, {} as any)
    expect(methods.stageMelee!("bat")).toEqual({ weapon: "bat" })
    expect(methods.strikeLightning!()).toBe("boom")

    const state = client.collectHarnessState({} as any)
    expect(state).toEqual({ weather: { active: true } })

    client.resetFeel({} as any, { health: 100, shoveAnim: 0, vault: null })
    const finalCount = client.processFeelFrame({
      tracker: {} as any,
      session: {} as any,
      combatFx: {} as any,
      zombieCrowd: {} as any,
      addSprites: new Float32Array(16),
      addCount: 0,
      playerGroundY: 0,
      dt: 1 / 60,
      settings: {} as any,
      cam: {} as any,
    })
    expect(finalCount).toBe(3)
    expect(orderLog).toEqual(["reset:melee", "reset:weather", "frame:melee", "frame:weather"])
  })

  test("registers the map feature in outbreakClientFeatures with Lab controls, settings group, and game commands", () => {
    const mapFeature = outbreakClientFeatures.get("map")
    expect(mapFeature).toBe(outbreakMapFeature)
    expect(mapFeature?.settingsGroup?.subsystem).toBe("map")
    const controls = mapFeature?.labControls?.({} as any) ?? []
    expect(controls.some((c) => c.key === "mapStyle")).toBe(true)
    expect(controls.some((c) => c.key === "mapMinimap")).toBe(true)
  })

  test("registers the weather feature in outbreakClientFeatures with Lab controls, commands, and harness hooks", () => {
    const weatherFeature = outbreakClientFeatures.get("weather")
    expect(weatherFeature).toBe(outbreakWeatherFeature)
    expect(weatherFeature?.settingsGroup?.subsystem).toBe("weather")
    const controls = weatherFeature?.labControls?.({} as any) ?? []
    expect(controls.some((c) => c.key === "weatherEnabled")).toBe(true)
    expect(controls.some((c) => c.key === "triggerWeatherLightning")).toBe(true)
    const commands = weatherFeature?.gameCommands?.({} as any) ?? []
    expect(commands.map((c) => c.id)).toEqual(["weather.preset", "weather.strike"])
    const methods = weatherFeature?.harnessMethods?.({} as any, {} as any) ?? {}
    expect(typeof methods.setWeatherPreset).toBe("function")
    expect(typeof methods.strikeLightning).toBe("function")
  })

  test("registers the pacing feature in both shared and client registries", () => {
    expect(outbreakSharedFeatures.get("pacing")).toBe(outbreakPacingSharedFeature)
    expect(outbreakPacingSharedFeature.tuning?.namespace).toBe("pacing")

    const pacingClient = outbreakClientFeatures.get("pacing")
    expect(pacingClient).toBe(outbreakPacingFeature)
    const controls = pacingClient?.labControls?.({} as any) ?? []
    expect(controls.some((c) => c.key === "safeRadius")).toBe(true)
    const commands = pacingClient?.gameCommands?.({} as any) ?? []
    expect(commands.map((c) => c.id)).toEqual(["pacing.stage"])
    const methods = pacingClient?.harnessMethods?.({} as any, {} as any) ?? {}
    expect(typeof methods.stagePacing).toBe("function")
  })

  test("registers the progression feature in both shared and client registries", () => {
    expect(outbreakSharedFeatures.get("progression")).toBe(outbreakProgressionSharedFeature)
    expect(outbreakProgressionSharedFeature.tuning?.namespace).toBe("progression")

    const progClient = outbreakClientFeatures.get("progression")
    expect(progClient).toBe(outbreakProgressionFeature)
    const commands = progClient?.gameCommands?.({} as any) ?? []
    expect(commands.map((c) => c.id)).toEqual(["progression.stage"])
    const methods = progClient?.harnessMethods?.({} as any, {} as any) ?? {}
    expect(typeof methods.stageProgression).toBe("function")
    expect(typeof methods.stock).toBe("function")
    expect(typeof methods.give).toBe("function")
  })

  test("registers the vehicles feature in both shared and client registries", () => {
    expect(outbreakSharedFeatures.get("vehicles")).toBe(outbreakVehiclesSharedFeature)
    expect(outbreakVehiclesSharedFeature.tuning?.namespace).toBe("vehicle")
    expect(outbreakVehiclesSharedFeature.netSection?.key).toBe("vehicles")

    const vehiclesClient = outbreakClientFeatures.get("vehicles")
    expect(vehiclesClient).toBe(outbreakVehiclesFeature)
    const commands = vehiclesClient?.gameCommands?.({} as any) ?? []
    expect(commands.map((c) => c.id)).toEqual(["vehicle.stage"])
    const methods = vehiclesClient?.harnessMethods?.({} as any, {} as any) ?? {}
    expect(typeof methods.stageVehicle).toBe("function")
  })

  test("registers the melee feature in both shared and client registries", () => {
    expect(outbreakSharedFeatures.get("melee")).toBe(outbreakMeleeSharedFeature)
    expect(outbreakMeleeSharedFeature.tuning?.namespace).toBe("melee")
    expect(outbreakMeleeSharedFeature.netSection?.key).toBe("meleeSwings")

    const meleeClient = outbreakClientFeatures.get("melee")
    expect(meleeClient).toBe(outbreakMeleeFeature)
    const commands = meleeClient?.gameCommands?.({} as any) ?? []
    expect(commands.map((c) => c.id)).toEqual(["melee.stage"])
    const methods = meleeClient?.harnessMethods?.({} as any, {} as any) ?? {}
    expect(typeof methods.stageMelee).toBe("function")
  })
})
