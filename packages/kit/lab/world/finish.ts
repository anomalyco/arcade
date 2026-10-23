import type { SceneHooks } from "../../gpu/shaders"
import { finishLook, packWear, wearFloats, wearVec4s, wearWgsl, type FinishLookId, type FinishScanId, type WearSettings } from "../../gpu/materials/wear"
import { FINISHED_LOOKS } from "./scene"

/**
 * The world's finish variant (`gpu/finish`, `materials/wear.ts`): the scene shader decodes the finishing bytes, wears
 * the finished props on the driveway (`finishedProps` preset) with their CC0 scans, and draws the albedo validator
 * over every lit surface. The world builds this variant only while the props or the validator are on, so the default
 * world compiles and draws exactly as before.
 *
 * Its uniform at binding 13 is Physical's knobs followed by the wear table and one Lab vec4 (x: 1 / exposure, so the
 * validator's false colour survives the grade). Today reads only the wear table and the Lab vec4.
 */
export const LAB_WEAR_LOOKS = FINISHED_LOOKS
/** Floats Physical's knobs and beam take at the start of the uniform. */
export const PHYSICAL_KNOB_FLOATS = 12
export const LAB_WEAR_OFFSET = PHYSICAL_KNOB_FLOATS
export const LAB_VEC4_OFFSET = LAB_WEAR_OFFSET + wearFloats(LAB_WEAR_LOOKS)
export const LAB_FINISH_FLOATS = LAB_VEC4_OFFSET + 4
/** Driveway height the props' rising damp climbs from. */
const GROUND = "0.025"

/** Scans the Lab's looks use, in texture-array order. */
export const LAB_SCANS: readonly FinishScanId[] = [...new Set(LAB_WEAR_LOOKS.map(id => finishLook(id).scan))]

export const labUniformWgsl = /* wgsl */ `struct LabUniforms { k: vec4f, beamA: vec4f, beamB: vec4f, wear: array<vec4f, ${wearVec4s(LAB_WEAR_LOOKS)}>, lab: vec4f }
@group(0) @binding(13) var<uniform> PK: LabUniforms;`

const declarationsWgsl = /* wgsl */ `
@group(0) @binding(11) var finishSampler: sampler;
@group(0) @binding(15) var finishScans: texture_2d_array<f32>;
var<private> wearDpx: vec3f;
var<private> wearDpy: vec3f;
var<private> labCheck: bool = false;
var<private> labCheckCol: vec3f;
var<private> labMetal: f32 = 0.0;
/** Notes the validator's colour for the final albedo (after floor patterns) and passes the ambient through. */
fn labAmbient(amb: vec3f, albedo: vec3f) -> vec3f {
  if (PK.wear[0].y > 0.5) { labCheck = true; labCheckCol = wearCheck(albedo, labMetal); }
  return amb;
}
${wearWgsl({
  looks: LAB_WEAR_LOOKS,
  params: "PK.wear",
  ground: () => GROUND,
  sample: (layer, uv, dx, dy) => `textureSampleGrad(finishScans, finishSampler, ${uv}, ${layer}, ${dx}, ${dy}).rgb`,
  sampleMean: layer => `textureSampleLevel(finishScans, finishSampler, vec2f(0.5), ${layer}, f32(textureNumLevels(finishScans) - 1u)).rgb`,
})}`

/** GGX roughness to the Today model's Blinn-Phong exponent and strength. */
const todayGloss = "let a2 = max(ws.rough * ws.rough, 0.03); gloss = vec2f(2.0 / (a2 * a2) - 2.0, (1.0 - ws.rough) * 0.6);"

/**
 * Scene hooks for the finish variant: `base` is the light model's own hooks (Physical's, or none for Today), whose
 * declarations and fragment start it extends. The material hook wears finished fragments, the ambient term notes the
 * validator's colour for every lit surface once floor patterns have set its albedo, and the surface hook draws it.
 */
export function labFinishHooks(base: SceneHooks, physical: boolean): SceneHooks {
  return {
    ...base,
    finish: true,
    declarations: `${labUniformWgsl}\n${declarationsWgsl}\n${base.declarations ?? ""}`,
    fragmentStart: `wearDpx = dpdx(o.world); wearDpy = dpdy(o.world);\n${base.fragmentStart ?? ""}`,
    material: `${base.material ?? ""}
    if (o.finish.w > 0.5) {
      var ws: WearSurface;
      ws.albedo = albedo; ws.rough = 0.7; ws.metal = 0.0; ws.wet = 0.0;
      ws = wearApply(ws, o.finish, o.world, normalize(o.normal), wearDpx, wearDpy);
      albedo = ws.albedo; labMetal = ws.metal;
      ${physical ? "pbrRough = ws.rough; pbrMetal = ws.metal;" : todayGloss}
    }`,
    ambient: `labAmbient(${base.ambient ?? "ambientAt(n)"}, albedo)`,
    surface: `${base.surface ?? ""}
  if (labCheck) { col = labCheckCol * PK.lab.x; }`,
  }
}

/** Packs the wear table and the Lab vec4 into the finish variant's uniform (Physical's knobs stay as packed). */
export function packLabFinish(out: Float32Array, s: Readonly<WearSettings>, exposure: number, scanLayers: Partial<Record<FinishScanId, number>> | null): void {
  const layers: Partial<Record<FinishLookId, number>> = {}
  if (scanLayers) for (const id of LAB_WEAR_LOOKS) layers[id] = scanLayers[finishLook(id).scan] ?? -1
  packWear(out, LAB_WEAR_OFFSET, LAB_WEAR_LOOKS, s, { scanLayers: layers })
  out.set([1 / Math.max(exposure, 1e-4), 0, 0, 0], LAB_VEC4_OFFSET)
}
