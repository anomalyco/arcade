import { test } from "bun:test"
import { validateWgsl } from "../test-naga"
import { withPhysicalLights } from "../lights/physical"
import { texturedSceneShader } from "../textured-mesh"
import { interiorWindowHooks, thinGlassHooks } from "./glass"
import { ROOM_ATLAS } from "./rooms"

const base = withPhysicalLights({ lampGrid: false, declarations: "struct Night { fog: vec4f, look: vec4f, light: vec4f, a: vec4f, b: vec4f, c: vec4f }\n@group(0) @binding(13) var<uniform> N: Night;", bounce: "vec3f(0.0)", directional: "vec3f(0.0)" }, { knobs: "N.light" })
const knobs = ["N.a", "N.b", "N.c"] as const
const sources = {
  glass: texturedSceneShader(thinGlassHooks(base, { knobs })),
  roomSide: texturedSceneShader(thinGlassHooks(base, { knobs, roomSide: "select(0.0, 1.0, p.x > 0.0)", roomAlbedo: "vec3f(0.5)" })),
  windows: texturedSceneShader(interiorWindowHooks(base, { knobs, layout: ROOM_ATLAS })),
  mullions: texturedSceneShader(interiorWindowHooks(base, { knobs, layout: ROOM_ATLAS, mullions: { cols: 3, width: 0.07, transom: 0.47, transomAbove: 3.9 } })),
}
for (const [name, code] of Object.entries(sources)) test(`WGSL: ${name}`, () => validateWgsl(code))
