import { describe, expect, test } from "bun:test"
import { validateWgsl } from "../test-naga"
import { withPhysicalLights } from "../lights/physical"
import { texturedSceneShader } from "../textured-mesh"
import {
  GLASS_DEFAULTS,
  GLASS_KNOB_FLOATS,
  ROOM_DEFAULTS,
  createGlassSettings,
  createRoomSettings,
  glassControls,
  glassF0,
  interiorWindowHooks,
  packGlassKnobs,
  roomControls,
  schlick,
  slabReflectance,
  thinGlassHooks,
} from "./glass"
import { ROOM_ATLAS, roomKindIndex, windowAux } from "./rooms"

describe("thin glass optics", () => {
  test("crown glass reflects about 4 % per interface, a slab about 8 %", () => {
    const f0 = glassF0(1.52)
    expect(f0).toBeCloseTo(0.0426, 3)
    expect(slabReflectance(f0)).toBeCloseTo(0.0817, 3)
  })

  test("the slab sums both interfaces and their inter-reflections", () => {
    const r = 0.2
    let sum = r
    let t = (1 - r) ** 2
    for (let i = 0; i < 64; i++) {
      sum += t * r
      t *= r * r
    }
    expect(slabReflectance(r)).toBeCloseTo(sum, 9)
  })

  test("Schlick runs from F0 head-on to 1 at grazing", () => {
    const f0 = glassF0(1.52)
    expect(schlick(f0, 1)).toBeCloseTo(f0, 9)
    expect(schlick(f0, 0)).toBe(1)
    expect(schlick(f0, 0.5)).toBeGreaterThan(f0)
    expect(schlick(f0, 0.5)).toBeLessThan(schlick(f0, 0.2))
  })
})

describe("settings", () => {
  test("Today is the default and the first row", () => {
    expect(GLASS_DEFAULTS.mode).toBe("today")
    expect(ROOM_DEFAULTS.mode).toBe("today")
    expect(glassControls()[0]?.key).toBe("glass.mode")
    expect(roomControls()[0]?.key).toBe("rooms.mode")
    const mode = glassControls()[0]
    expect(mode && "options" in mode ? mode.options?.[0]?.value : undefined).toBe("today")
  })

  test("knobs pack F0, not the IOR", () => {
    const glass = createGlassSettings({ ior: 1.5, grime: 0.25 })
    const rooms = createRoomSettings({ depth: 4 })
    const out = packGlassKnobs(glass, rooms, new Float32Array(GLASS_KNOB_FLOATS + 4), 4)
    expect(out[4]).toBeCloseTo(0.04, 6)
    expect(out[6]).toBeCloseTo(0.25, 6)
    expect(out[4 + 8]).toBe(4)
    // Mullion edges: Today (smoothstep) packs 0, box filtering 1.
    expect(out[4 + 11]).toBe(0)
    expect(packGlassKnobs(glass, createRoomSettings({ mullions: "box" }))[11]).toBe(1)
  })

  test("window aux keeps kind and brightness apart", () => {
    for (const kind of ROOM_ATLAS.kinds) {
      const aux = windowAux(kind, 2.5)
      expect(Math.floor(aux / 4)).toBe(roomKindIndex(kind))
      expect(aux % 4).toBeCloseTo(2.5, 6)
    }
    expect(windowAux("lab", 9) % 4).toBeLessThan(4)
    expect(ROOM_ATLAS.gains.length as number).toBe(ROOM_ATLAS.kinds.length * ROOM_ATLAS.variants)
  })
})

describe("WGSL validates with naga", () => {
  const base = withPhysicalLights(
    {
      lampGrid: false,
      declarations: "struct Night { fog: vec4f, look: vec4f, light: vec4f, a: vec4f, b: vec4f, c: vec4f }\n@group(0) @binding(13) var<uniform> N: Night;",
      bounce: "vec3f(0.0)",
      directional: "vec3f(0.0)",
    },
    { knobs: "N.light" },
  )
  const knobs = ["N.a", "N.b", "N.c"] as const
  const sources: Record<string, string> = {
    "thin glass": texturedSceneShader(thinGlassHooks(base, { knobs })),
    "thin glass, room side": texturedSceneShader(thinGlassHooks(base, { knobs, roomSide: "select(0.0, 1.0, p.x > 0.0)", roomAlbedo: "vec3f(0.5)" })),
    "interior windows": texturedSceneShader(interiorWindowHooks(base, { knobs, layout: ROOM_ATLAS })),
    "interior windows, mullions": texturedSceneShader(interiorWindowHooks(base, { knobs, layout: ROOM_ATLAS, mullions: { cols: 3, width: 0.07, transom: 0.47, transomAbove: 3.9 } })),
  }
  for (const [name, code] of Object.entries(sources)) {
    test(name, () => {
      validateWgsl(code)
    })
  }
})
