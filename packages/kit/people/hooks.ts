import type { SceneHooks } from "../gpu/shaders"
import { KINDS, PEOPLE_AUX } from "./asset"

export type PeopleLook = {
  /** Fibre sheen at grazing angles, as a multiple of the scene's ambient (fog/sky) light: silhouettes read in the dark. */
  sheen: number
  /** Perceptual roughness per kind (physical-light games). */
  rough: Record<(typeof KINDS)[number], number>
}

export const PEOPLE_LOOK: PeopleLook = {
  sheen: 0.6,
  rough: { skin: 0.52, cloth: 0.9, nylon: 0.48, hair: 0.45, brow: 0.8, eye: 0.1, knit: 0.96, plastic: 0.4, lens: 0.08 },
}

const num = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x))
const k = (kind: (typeof KINDS)[number]) => num(PEOPLE_AUX + KINDS.indexOf(kind))

/**
 * Wraps a game's scene hooks for `PeoplePass`: per-kind roughness (skin, cloth, nylon shell, hair, eyes, knit) and a
 * cloth/hair sheen lit by the scene's own ambient (fog and sky), added before the game's `surface` hook (its fog).
 * Everything else, including the beams and lamps that light the jacket, is the game's lighting, except that a torch
 * beam does not light a person behind its lens.
 */
export function personHooks(game: SceneHooks, look: PeopleLook = PEOPLE_LOOK): SceneHooks {
  const physical = (game.declarations ?? "").includes("pbrRough")
  const inPeople = `(o.aux > ${num(PEOPLE_AUX - 0.5)} && o.aux < ${num(PEOPLE_AUX + KINDS.length - 0.5)})`
  const rough = KINDS.map((kind) => `if (abs(o.aux - ${k(kind)}) < 0.5) { pbrRough = ${num(look.rough[kind])}; }`).join("\n      ")
  const sheen = /* wgsl */ `
  if ${inPeople} {
    let nv = max(dot(n, V), 0.0);
    let edge = pow(1.0 - nv, 3.0);
    var share = 1.0;
    if (abs(o.aux - ${k("skin")}) < 0.5) { share = 0.35; }
    if (abs(o.aux - ${k("nylon")}) < 0.5) { share = 0.55; }
    if (abs(o.aux - ${k("eye")}) < 0.5 || abs(o.aux - ${k("plastic")}) < 0.5 || abs(o.aux - ${k("lens")}) < 0.5) { share = 0.0; }
    col += mix(vec3f(1.0), texBase.rgb * o.color * 2.0, 0.5) * (${game.ambient ?? "ambientAt(n)"}) * edge * share * ${num(look.sheen)};
  }`
  return {
    ...game,
    declarations: `${game.declarations ?? ""}
var<private> peopleShaded: bool = false;`,
    material: `${game.material ?? ""}
    peopleShaded = ${inPeople};
    if (peopleShaded) {
      ${physical ? rough : ""}
    }`,
    // A torch lights nothing behind its lens: without this the beam's wide spill burns the holder's own sleeve and chest.
    lightMask: `${game.lightMask ?? ""}
    if (peopleShaded && L.cone.w >= 4.5 && L.cone.w < 6.5 && dot(world - L.pos.xyz, L.cone.xzy) < 0.02) { continue; }`,
    surface: `${sheen}
  ${game.surface ?? ""}`,
  }
}
