import type { SceneHooks } from "../gpu/shaders"
import { KINDS, PEOPLE_AUX } from "./asset"

export type PeopleLook = {
  /**
   * Fibre sheen at grazing angles, as a multiple of the scene's ambient (fog/sky) light. 0 (realistic, the default):
   * an edge glow reads as a rim light the scene does not have. Raise it to make silhouettes read in the dark.
   */
  sheen: number
  /** Perceptual roughness per kind (physical-light games). */
  rough: Record<(typeof KINDS)[number], number>
  /**
   * Skin's subsurface light, as a wrap past the terminator (0 none): light scattered under the skin reddens and
   * softens the edge between lit and unlit. Only the scene's lights feed it, so unlit skin stays dark.
   */
  scatter: number
}

export const PEOPLE_LOOK: PeopleLook = {
  sheen: 0,
  rough: { skin: 0.52, cloth: 0.9, nylon: 0.48, hair: 0.45, brow: 0.8, eye: 0.1, knit: 0.96, plastic: 0.4, lens: 0.08 },
  scatter: 0.45,
}

const num = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x))
const k = (kind: (typeof KINDS)[number]) => num(PEOPLE_AUX + KINDS.indexOf(kind))

/**
 * Wraps a game's scene hooks for `PeoplePass`: per-kind roughness (skin, cloth, nylon shell, hair, eyes, knit), a
 * subsurface wrap on skin from each scene light, and an optional cloth/hair sheen lit by the scene's own ambient
 * (fog and sky), added before the game's `surface` hook (its fog).
 * Everything else, including the beams and lamps that light the jacket, is the game's lighting, except that a torch
 * beam does not light a person behind its lens.
 */
export function personHooks(game: SceneHooks, look: PeopleLook = PEOPLE_LOOK): SceneHooks {
  const physical = (game.declarations ?? "").includes("pbrRough")
  const inPeople = `(o.aux > ${num(PEOPLE_AUX - 0.5)} && o.aux < ${num(PEOPLE_AUX + KINDS.length - 0.5)})`
  const rough = KINDS.map((kind) => `if (abs(o.aux - ${k(kind)}) < 0.5) { pbrRough = ${num(look.rough[kind])}; }`).join("\n      ")
  const sheen = look.sheen <= 0 ? "" : /* wgsl */ `
  if ${inPeople} {
    let nv = max(dot(n, V), 0.0);
    let edge = pow(1.0 - nv, 3.0);
    var share = 1.0;
    if (abs(o.aux - ${k("skin")}) < 0.5) { share = 0.35; }
    if (abs(o.aux - ${k("nylon")}) < 0.5) { share = 0.55; }
    if (abs(o.aux - ${k("eye")}) < 0.5 || abs(o.aux - ${k("plastic")}) < 0.5 || abs(o.aux - ${k("lens")}) < 0.5) { share = 0.0; }
    col += mix(vec3f(1.0), texBase.rgb * o.color * 2.0, 0.5) * (${game.ambient ?? "ambientAt(n)"}) * edge * share * ${num(look.sheen)};
  }`
  // Wrapped minus plain Lambert: the light reaching past the terminator, red-weighted (blood under the skin).
  const pi = (game.diffuseTerm ?? "").includes("PI") ? " / PI" : ""
  const scatter = look.scatter <= 0 ? "" : /* wgsl */ `if (peopleSkin) {
      let wrapLit = max((ndl + ${num(look.scatter)}) / ${num(1 + look.scatter)}, 0.0) - max(ndl, 0.0);
      out.diff += L.color.rgb * att * vis * vec3f(0.62, 0.2, 0.1) * wrapLit${pi};
    }`
  return {
    ...game,
    declarations: `${game.declarations ?? ""}
var<private> peopleShaded: bool = false;
var<private> peopleSkin: bool = false;`,
    material: `${game.material ?? ""}
    peopleShaded = ${inPeople};
    peopleSkin = abs(o.aux - ${k("skin")}) < 0.5;
    if (peopleShaded) {
      ${physical ? rough : ""}
    }`,
    // A torch lights nothing behind its lens: without this the beam's wide spill burns the holder's own sleeve and chest.
    lightMask: `${game.lightMask ?? ""}
    if (peopleShaded && L.cone.w >= 4.5 && L.cone.w < 6.5 && dot(world - L.pos.xyz, L.cone.xzy) < 0.02) { continue; }`,
    // Non-PBR scenes dim direct light on upright surfaces (walls); a person is not a wall.
    wallDirectScale: game.wallDirectScale ?? "1.0",
    lightAccumulate: `${game.lightAccumulate ?? ""}
    ${scatter}`,
    surface: `${sheen}
  ${game.surface ?? ""}`,
  }
}
