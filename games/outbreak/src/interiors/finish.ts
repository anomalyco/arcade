import { MAT, type Mesh } from "@arcade/kit/gpu/mesh"
import { finishTagged } from "@arcade/kit/gpu/finish"
import { lookIndex, wearFloats, wearVec4s, wearWgsl, type FinishLookId } from "@arcade/kit/gpu/materials/wear"
import { interiorSettings } from "./plan"

/**
 * Finished props indoors (`@arcade/kit/gpu/finish`): the fitted kitchen is built with chamfered edges and tagged with a
 * wear look, the level bakes AO and curvature into the spare vertex bytes before packing, and the scene shader wears
 * the walnut from them: rubbed edges, grime in the reveals, dust on the tops. Lab › Rugs & interiors › Finished props;
 * off is Today's square boxes.
 */

/** Looks Outbreak packs into `OL.finish`, in table order. */
export const OUTBREAK_WEAR_LOOKS = ["old-wood"] as const satisfies readonly FinishLookId[]
export const FINISH_UNIFORM_FLOATS = wearFloats(OUTBREAK_WEAR_LOOKS)

/** House floors stand 0.13 m above the town's ground: rising damp climbs from there. */
const FLOOR = 0.13

/**
 * Builds `build`'s cabinetry as finished timber when the setting is on (chamfered, tagged old wood); the steel and
 * laminate it also draws stay plain and only shade it.
 */
export function finishedCabinetry(m: Mesh, build: () => void): void {
  if (!interiorSettings.finish) { build(); return }
  const first = m.count
  m.finishPart(lookIndex("old-wood"), build, "auto")
  for (let i = first; i < m.count; i++) if (Math.round(m.v[i * 11 + 9]!) !== MAT.timber) delete m.finishLooks[i]
}

/** Bakes a level mesh's tagged vertices before it is packed (indoors: sheltered, so dust rather than rain streaks). */
export function bakeFinishedProps(m: Mesh): Mesh {
  return finishTagged(m, { exposure: 0, ground: FLOOR, rays: 16 })
}

export const finishUniformFieldsWgsl = /* wgsl */ `
  finish: array<vec4f, ${wearVec4s(OUTBREAK_WEAR_LOOKS)}>, // finished props: on, albedo check, wetness, -; then each look`

export const finishDeclarationsWgsl = /* wgsl */ `
var<private> wearDpx: vec3f;
var<private> wearDpy: vec3f;
/** The albedo validator view is on: the surface shows its false colour (\`outbreakCheckCol\`). */
var<private> outbreakCheck: bool = false;
var<private> outbreakCheckCol: vec3f;
${wearWgsl({ looks: OUTBREAK_WEAR_LOOKS, params: "OL.finish", ground: () => FLOOR.toFixed(2) })}
`

export const finishFragmentStartWgsl = "wearDpx = dWorldX; wearDpy = dWorldY;"

/** After Outbreak's surface materials (postLightMaterial): wear finished props, then the validator. */
export const finishMaterialWgsl = /* wgsl */ `
    if (o.finish.w > 0.5) {
      var ws: WearSurface;
      ws.albedo = albedo; ws.rough = 0.7; ws.metal = 0.0; ws.wet = 0.0;
      albedo = wearApply(ws, o.finish, o.world, n, wearDpx, wearDpy).albedo;
    }
    if (OL.finish[0].y > 0.5) { outbreakCheck = true; outbreakCheckCol = wearCheck(albedo, 0.0); }`

/** End of the surface hook: the validator replaces the shaded colour. */
export const finishSurfaceWgsl = "if (outbreakCheck) { col = outbreakCheckCol; }"
