import { TREE_LOOK_SHADE } from "@arcade/kit/gpu/foliage-looks"
import type { Town } from "../../shared/map"
import type { OutbreakVegetationSettings } from "./settings"

/**
 * Per-frame tree uniforms (`OL.vegTrees`, `OL.vegBurn`): which tree look is built and how it is shaded, and the burn
 * hook. Trees are baked into the static level, so burning is a shader effect over the nearest burning trees: up to
 * `TREE_BURN_SLOTS` (x, z, crown radius, burn) entries char the bark and leaves, glow embers, and fold the leaves away.
 */
export const TREE_BURN_SLOTS = 8
/** `vegTrees` (tree look, shade outside light, colour in light, burning count) then `vegBurn` × `TREE_BURN_SLOTS`. */
export const VEG_TREE_UNIFORM_FLOATS = 4 + TREE_BURN_SLOTS * 4

/** A tree's stable id from its position (quarter-metre grid): the same on every client and every rebuild. */
export function treeIdAt(x: number, z: number): number {
  const ix = Math.round(x * 4)
  const iz = Math.round(z * 4)
  let h = (Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  return (h ^ (h >>> 12)) >>> 0
}

/**
 * Burn state per tree id: 0 untouched; up to 0.6 burning (embers glow, bark and leaves char); 0.6–1 burnt (the leaves
 * are gone, the limbs are black). The fire feature sets the source; vegetation only draws it.
 */
export type TreeBurnSource = (treeId: number) => number

let burnSource: TreeBurnSource | null = null

/** Installs (or clears with null) the function the renderer asks for each nearby tree's burn state every frame. */
export function setTreeBurnSource(source: TreeBurnSource | null): void {
  burnSource = source
}

/** The burn state the renderer draws for `treeId` (0..1). */
export function treeBurnState(treeId: number): number {
  const b = burnSource ? burnSource(treeId) : 0
  return b > 0 ? Math.min(1, b) : 0
}

type TreeList = { x: Float32Array; z: Float32Array; r: Float32Array; id: Uint32Array }
const treeLists = new WeakMap<Town, TreeList>()

function townTrees(town: Town): TreeList {
  let list = treeLists.get(town)
  if (list) return list
  const trees = town.props.filter((p) => p.kind === "tree")
  list = { x: new Float32Array(trees.length), z: new Float32Array(trees.length), r: new Float32Array(trees.length), id: new Uint32Array(trees.length) }
  trees.forEach((t, i) => {
    list!.x[i] = t.x
    list!.z[i] = t.y
    list!.r[i] = 2.45 + t.variant * 0.75
    list!.id[i] = treeIdAt(t.x, t.y)
  })
  treeLists.set(town, list)
  return list
}

const picked = { i: new Int32Array(TREE_BURN_SLOTS), b: new Float32Array(TREE_BURN_SLOTS), n: 0 }

/**
 * Packs `vegTrees` and the burning trees within 48 m of the survivor. `vegBurnTest` (Lab) sets the nearest tree
 * burning without a fire, to check the hook.
 */
export function packVegetationTrees(s: Readonly<OutbreakVegetationSettings>, town: Town, px: number, pz: number, out: Float32Array, offset: number): void {
  const look = s.vegLook >= 0.5 ? Math.round(s.vegTreeLook) : 0
  out[offset] = look
  out[offset + 1] = (TREE_LOOK_SHADE[look] ?? 0) * s.vegTreeShade
  out[offset + 2] = s.vegTreeRichness
  picked.n = 0
  const test = s.vegBurnTest
  if (burnSource || test > 0) {
    const t = townTrees(town)
    let nearest = -1
    let nearestD = Infinity
    for (let i = 0; i < t.id.length; i++) {
      const dx = t.x[i]! - px
      const dz = t.z[i]! - pz
      const d2 = dx * dx + dz * dz
      if (d2 > 48 * 48) continue
      if (d2 < nearestD) {
        nearestD = d2
        nearest = i
      }
      const b = treeBurnState(t.id[i]!)
      if (b > 0.002) pick(i, b)
    }
    if (test > 0 && nearest >= 0) pick(nearest, Math.min(1, test))
    for (let k = 0; k < picked.n; k++) {
      const i = picked.i[k]!
      const o = offset + 4 + k * 4
      out[o] = t.x[i]!
      out[o + 1] = t.z[i]!
      out[o + 2] = t.r[i]!
      out[o + 3] = picked.b[k]!
    }
  }
  out[offset + 3] = picked.n
  out.fill(0, offset + 4 + picked.n * 4, offset + VEG_TREE_UNIFORM_FLOATS)
}

/** Keeps the most strongly burning trees (one entry per tree; the strongest state wins). */
function pick(i: number, b: number): void {
  for (let k = 0; k < picked.n; k++) {
    if (picked.i[k] === i) {
      picked.b[k] = Math.max(picked.b[k]!, b)
      return
    }
  }
  if (picked.n < TREE_BURN_SLOTS) {
    picked.i[picked.n] = i
    picked.b[picked.n++] = b
    return
  }
  let weakest = 0
  for (let k = 1; k < picked.n; k++) if (picked.b[k]! < picked.b[weakest]!) weakest = k
  if (b > picked.b[weakest]!) {
    picked.i[weakest] = i
    picked.b[weakest] = b
  }
}

/** Uniform fields appended to `OutbreakLightingUniforms` after `vegGust`. */
export const vegetationTreeFieldsWgsl = /* wgsl */ `
  vegTrees: vec4f, // tree look (0 lively, 1 Deadwood, 2 Fluffy, 3 Darkwood), shade outside light, colour in light, burning trees
  vegBurn: array<vec4f, ${TREE_BURN_SLOTS}>, // burning trees: x, z, crown radius, burn (0..1)`

/** WGSL helpers; declare after `OL`. */
export const vegetationTreeWgsl = /* wgsl */ `
/** Tree canopy (foliage 0 < aux < 2.5) or a swaying limb (timber aux >= 7.5). Shrubs and grass are not trees. */
fn outbreakIsTreePart(mat: f32, aux: f32) -> bool {
  return (mat > 21.5 && mat < 22.5 && aux > 0.0 && aux < 2.5) || (mat > 23.5 && mat < 24.5 && aux > 7.5);
}

/** The strongest burning tree reaching \`p\`: its x, z and radius, and the burn there (0 when none). */
fn outbreakTreeBurnAt(p: vec3f) -> vec4f {
  var best = vec4f(0.0);
  let count = i32(OL.vegTrees.w);
  for (var i = 0; i < ${TREE_BURN_SLOTS}; i++) {
    if (i >= count) { break; }
    let t = OL.vegBurn[i];
    let k = t.w * (1.0 - smoothstep(t.z * 0.8, t.z * 1.15, length(p.xz - t.xy)));
    if (k > best.w) { best = vec4f(t.xyz, k); }
  }
  return best;
}

/** Burnt-away leaves fold into the trunk below ground (zero-area triangles, no discard), from burn 0.55 to 0.95. */
fn outbreakTreeBurnVertex(p: vec3f, mat: f32) -> vec3f {
  if (OL.vegTrees.w < 0.5 || mat > 22.5) { return p; }
  let b = outbreakTreeBurnAt(p);
  let k = smoothstep(0.55, 0.95, b.w);
  return mix(p, vec3f(b.x, -1.5, b.y), k);
}

/**
 * How much of the flashlight's plan cone covers a crown point, at any height. The camera sees crown tops the torch
 * below can't reach directly, so this stands in for light through the leaves (like the leaf transmission glow).
 */
fn outbreakTreeBeam(world: vec3f) -> f32 {
  if (OL.u4.z <= 0.001) { return 0.0; }
  let rel = world.xz - OL.u3.xy;
  let along = dot(rel, OL.u3.zw);
  let range = max(2.8, OL.u4.y);
  let across = abs(dot(rel, vec2f(-OL.u3.w, OL.u3.z)));
  let cone = 0.3 + max(0.0, along) * max(0.12, OL.u4.x);
  let t = clamp(1.0 - along / range, 0.0, 1.0);
  return smoothstep(-0.2, 0.6, along) * (1.0 - smoothstep(cone * 0.75, cone * 1.3, across)) * sqrt(t) * clamp(OL.u4.z, 0.0, 1.0);
}

/**
 * Tree look shading and burn, before the fog of war. Shade (Deadwood, Darkwood): outside light the canopy and limbs
 * sink to near-black, grey, a little less by day; where a flashlight, lamp, window or fire lands (\`litMask\`) they keep
 * and enrich their colour. Burn: char toward black, embers glowing while it burns.
 */
fn outbreakTreeSurface(col: vec3f, litMask: f32, sunVal: f32, world: vec3f, mat: i32, aux: f32) -> vec3f {
  if (!outbreakIsTreePart(f32(mat), aux)) { return col; }
  var c = col;
  let shade = clamp(OL.vegTrees.y, 0.0, 1.5);
  let lum = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  if (shade > 0.001) {
    let leaf = mat == 22;
    let desat = clamp(mix(0.85, 0.5, sunVal) * shade, 0.0, 1.0);
    let dark = clamp(1.0 - mix(0.78, 0.38, sunVal) * shade, 0.05, 1.0);
    let unlit = mix(c, vec3f(lum) * vec3f(1.0, 0.97, 0.92), desat) * dark;
    let beam = outbreakTreeBeam(world);
    // Leaves enrich in light; bark keeps its own colour (a warm torch on enriched bark reads orange).
    var rich = select(c, max(mix(vec3f(lum), c, 1.0 + 0.4 * clamp(OL.vegTrees.z, 0.0, 1.5)), vec3f(0.0)), leaf);
    // Torchlight through the crown: the camera sees tops the torch below can't reach, so the beam's plan cone lends
    // the leaves their own colour, lit by the beam.
    rich += select(vec3f(0.0), outbreakAlbedo * OL.u5.rgb * vec3f(1.0, 1.15, 0.7) * beam * 0.45 * shade, leaf);
    c = mix(unlit, rich, max(smoothstep(0.04, 0.55, litMask), beam * select(0.5, 1.0, leaf)));
  }
  if (OL.vegTrees.w > 0.5) {
    let b = outbreakTreeBurnAt(world).w;
    if (b > 0.001) {
      c = mix(c, vec3f(lum * 0.1 + 0.004), smoothstep(0.08, 0.6, b));
      let ember = smoothstep(0.12, 0.35, b) * (1.0 - smoothstep(0.65, 0.95, b));
      let flick = 0.6 + 0.4 * sin(F.cam.w * 6.5 + dot(world, vec3f(3.1, 1.7, 2.3)));
      c += vec3f(1.4, 0.42, 0.08) * ember * flick * select(0.3, 0.16, mat == 24);
    }
  }
  return c;
}
`
