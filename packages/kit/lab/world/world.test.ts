import { describe, expect, test } from "bun:test"
import { cloneFoliageParams } from "../../gpu/foliage"
import type { LabContext } from "../types"
import { WORLD_PRESETS } from "./presets"
import { writeOrbitCamera } from "../stage"
import { CHARACTER_AT, SCREEN_AT, SCREEN_CAMERA, SCREEN_CHAIR, WORLD_ORIGIN, buildWorld, worldClock, worldLights } from "./scene"
import { WORLD_TABS, createWorldSection } from "./section"
import { postShader } from "../../gpu/shaders"
import { validateWgsl } from "../../gpu/test-naga"
import { WORLD_DEFAULTS, WORLD_POST, createDebugWorld } from "./world"

const context = { device: {}, stage: { eye: new Float32Array(3), viewProj: new Float32Array(16), frameTarget() {}, updateCamera() {} }, particles: { count: 0 }, sync() {} } as unknown as LabContext
const make = () => {
  const world = createDebugWorld(context)
  return { world, section: createWorldSection(context, world) }
}

describe("the base debug world", () => {
  test("builds the street, house corner, tree, bush, grass, car and figure on the kit mesh", () => {
    const g = buildWorld({ ...WORLD_DEFAULTS, vegetation: cloneFoliageParams() })
    expect(g.vertices).toBeGreaterThan(5000)
    expect(g.level.chunks.length).toBe(1)
    expect(g.level.glass.length).toBe(1)
    // Walls, window sills and the car cast light shadows; the tree, lamp pole and figure are round casters.
    expect(g.boxes.length).toBeGreaterThanOrEqual(10)
    expect(g.casters.map(c => [c.x, c.y])).toContainEqual([CHARACTER_AT[0] - WORLD_ORIGIN[0], CHARACTER_AT[1] - WORLD_ORIGIN[1]])
    const bare = buildWorld({ ...WORLD_DEFAULTS, tree: false, bush: false, grass: false, vegetation: cloneFoliageParams() })
    expect(bare.vertices).toBeLessThan(g.vertices)
  })

  test("the clock: noon is day with the lamps off, midnight is night with the lamps on, dusk is between", () => {
    const noon = worldClock(13), dusk = worldClock(19.4), night = worldClock(23.5)
    expect(noon.day).toBe(1)
    expect(noon.lamps).toBe(0)
    expect(night.day).toBe(0)
    expect(night.lamps).toBe(1)
    expect(dusk.day).toBeGreaterThan(0)
    expect(dusk.day).toBeLessThan(1)
    expect(worldLights(night, { lampPower: 1, headlights: false, flashlight: false, porch: true }).length).toBe(4)
    expect(worldLights(noon, { lampPower: 1, headlights: false, flashlight: false, porch: true }).length).toBe(1)
  })
})

describe("the Look and world lab", () => {
  test("one tab per idea, and every setting has exactly one control", () => {
    const { section } = make()
    expect(WORLD_TABS.map(t => t.label)).toEqual(["Look", "Light", "Sky", "Weather", "Materials", "Vegetation", "Screen"])
    const groups = new Set(section.controls.map(c => c.group))
    expect([...groups].sort()).toEqual(["Clock & light", "Look", "Materials", "Preset", "Screen", "Sky", "Vegetation", "Weather"])
    const keys = section.controls.filter(c => c.type !== "action").map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect({ key, bound: key in section.settings }).toEqual({ key, bound: true })
  })

  test("every preset is a valid set of knob values and applies over the defaults", () => {
    for (const p of WORLD_PRESETS) {
      const { world, section } = make()
      section.applyPreset(p.id)
      expect(section.settings.worldPreset).toBe(p.id)
      for (const [k, v] of Object.entries(p.values)) expect({ preset: p.id, key: k, value: section.settings[k] }).toEqual({ preset: p.id, key: k, value: v })
      if (!("hour" in p.values)) expect(world.state.hour).toBe(WORLD_DEFAULTS.hour)
    }
  })

  test("Reset goes back to Clear day: Current look, clear weather, Oak and Lawn", () => {
    const { world, section } = make()
    section.applyPreset("noir-rain")
    expect(world.look.preset).toBe("noir")
    section.applyPreset("day")
    expect({ look: world.look.preset, weather: world.weather.preset, tree: world.vegetation.treePreset, grass: world.vegetation.grassPreset, hour: world.state.hour }).toEqual({ look: "current", weather: "clear", tree: "oak", grass: "lawn", hour: 13 })
  })

  test("leaving the screen bench's indoor camera goes back to the street view", () => {
    const targets: number[][] = []
    const stage = { ...context.stage, frameTarget: (x: number, y: number, z: number, d: number) => { targets.push([x, y, z, d]) } }
    const ctx = { ...context, stage } as unknown as LabContext
    const world = createDebugWorld(ctx)
    const section = createWorldSection(ctx, world)
    section.applyPreset("screen-bench")
    section.applyPreset("night-lamps")
    expect(targets.length).toBe(2)
    expect(targets[1]![3]).toBeGreaterThan(5)
    section.applyPreset("dusk")
    expect(targets.length).toBe(2)
  })

  test("the screen bench frames the set on the right third and the chair's lit front three-quarter on", () => {
    const vp = new Float32Array(16), eye = new Float32Array(3)
    const c = SCREEN_CAMERA
    writeOrbitCamera(708, 564, vp, new Float32Array(16), eye, c.target, c.yaw, c.pitch, c.dist)
    const ndc = (x: number, y: number, z: number) => {
      const w = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!
      return [(vp[0]! * x + vp[4]! * y + vp[8]! * z + vp[12]!) / w, (vp[1]! * x + vp[5]! * y + vp[9]! * z + vp[13]!) / w]
    }
    const [ox, oz] = WORLD_ORIGIN
    const [tvX, tvY] = ndc(SCREEN_AT.center[0], SCREEN_AT.center[1], SCREEN_AT.center[2])
    expect(tvX).toBeGreaterThan(0.25)
    expect(tvX).toBeLessThan(0.45)
    expect(Math.abs(tvY!)).toBeLessThan(0.5)
    const [chairX] = ndc(SCREEN_CHAIR.x - ox, 0.7, SCREEN_CHAIR.z - oz)
    expect(chairX).toBeLessThan(-0.3)
    expect(chairX).toBeGreaterThan(-0.75)
    // The chair faces the glass less its turn; the camera sits 30–60° off that front.
    const face = Math.atan2(SCREEN_AT.center[2] + oz - SCREEN_CHAIR.z, SCREEN_AT.center[0] + ox - SCREEN_CHAIR.x) + SCREEN_CHAIR.turn
    const toEye = Math.atan2(eye[2]! + oz - SCREEN_CHAIR.z, eye[0]! + ox - SCREEN_CHAIR.x)
    const off = Math.abs(Math.atan2(Math.sin(toEye - face), Math.cos(toEye - face))) * 180 / Math.PI
    expect(off).toBeGreaterThan(30)
    expect(off).toBeLessThan(60)
  })

  test("the world's composite is the kit's, with a shadow lift the screen bench turns off", () => {
    validateWgsl(WORLD_POST)
    const base = postShader(false)
    expect(WORLD_POST).not.toMatch(/\bG\./)
    // Only the uniform's name, its declaration and the lift line differ from the kit's composite.
    const strip = (code: string) => code.replace(/grade\.frame\./g, "G.").split("\n").filter(l => !/binding\(4\)|struct Grade|frame:vec4f|look:vec4f|reservedLook|custom:vec4f|^\}$/.test(l))
    const a = strip(base), b = strip(WORLD_POST)
    expect(b.length).toBe(a.length)
    expect(b.filter((l, i) => l !== a[i])).toEqual([expect.stringContaining("select(vec3f(0.006, 0.011, 0.028), vec3f(0.006, 0.011, 0.028) * grade.custom.y, grade.custom.x > 0.5)")])
    expect(WORLD_DEFAULTS.shadowLift).toBe(1)
    expect(WORLD_PRESETS.find(p => p.id === "screen-bench")!.values.shadowLift).toBe(0)
    expect(WORLD_PRESETS.filter(p => "shadowLift" in p.values).map(p => p.id)).toEqual(["screen-bench"])
  })

  test("export and import round-trip a versioned preset, and a bad file changes nothing", () => {
    const a = make()
    a.section.applyPreset("autumn")
    a.section.set("hour", 7.5)
    const file = a.section.exportPreset()
    expect(file).toMatchObject({ version: 1, kind: "arcade.lab.world", preset: "autumn" })
    const b = make()
    expect(b.section.importPreset(JSON.stringify(file))).toEqual({ ok: true })
    expect(b.section.exportPreset().values).toEqual(file.values)

    const before = b.section.exportPreset()
    expect(b.section.importPreset({ ...file, version: 2 }).ok).toBe(false)
    expect(b.section.importPreset({ ...file, values: { ...file.values, hour: "late" } }).ok).toBe(false)
    expect(b.section.importPreset({ ...file, values: { ...file.values, nope: 1 } }).ok).toBe(false)
    expect(b.section.importPreset({ ...file, values: { ...file.values, wall: "plaid" } }).ok).toBe(false)
    expect(b.section.exportPreset()).toEqual(before)
  })

  test("set clamps ranges and rejects unknown keys and choices", () => {
    const { section } = make()
    expect(section.set("hour", 40).value).toBe(24)
    expect(() => section.set("nope", 1)).toThrow()
    expect(() => section.set("street", 42)).toThrow()
  })

  test("rain and adaptation are independent opt-ins, survive preset export, and reset to Today", () => {
    const { world, section } = make()
    expect([world.rainLighting.mode, world.exposure.mode]).toEqual(["today", "today"])
    section.applyPreset("rain-volumes")
    expect([world.rainLighting.mode, world.exposure.mode]).toEqual(["volume", "today"])
    section.applyPreset("storm-adaptation")
    expect([world.rainLighting.mode, world.exposure.mode]).toEqual(["today", "adapt"])
    section.set("rainLight.mode", "volume")
    section.set("exposure.recovery", 4)
    const saved = section.exportPreset(), other = make()
    expect(other.section.importPreset(saved)).toEqual({ ok: true })
    expect([other.world.rainLighting.mode, other.world.exposure.mode, other.world.exposure.recovery]).toEqual(["volume", "adapt", 4])
    expect(other.section.importPreset({ ...saved, values: { ...saved.values, "exposure.mode": "automatic" } }).ok).toBe(false)
    expect(other.section.exportPreset()).toEqual(saved)
    section.applyPreset("storm")
    expect([world.rainLighting.mode, world.exposure.mode]).toEqual(["today", "today"])
  })
})
