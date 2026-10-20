import { TREE_LOOK_SHADE } from "@arcade/kit/gpu/foliage-looks"
import { treeCrownRadius } from "../../shared/fire/fire"
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

/**
 * Burning or burnt ground that chars the shrubs and hedges standing in it (fire on the ground, scorch marks): each
 * spot is `push(x, z, radius, burn)`. The fire feature sets the source; vegetation draws the nearest few.
 */
export type FoliageBurnSpots = (push: (x: number, z: number, r: number, burn: number) => void) => void

let spotSource: FoliageBurnSpots | null = null

/** Installs (or clears with null) the burn spots for shrubs and hedges. */
export function setFoliageBurnSpots(source: FoliageBurnSpots | null): void {
  spotSource = source
}

/** Most of the burn slots shrub and hedge spots may take (burning trees come first). */
const SPOT_SLOTS = 5
const spots: { x: number; z: number; r: number; b: number; d2: number }[] = []

/** The burn state the renderer draws for `treeId` (0..1). */
export function treeBurnState(treeId: number): number {
  const b = burnSource ? burnSource(treeId) : 0
  return b > 0 ? Math.min(1, b) : 0
}

type TreeList = { x: Float32Array; z: Float32Array; r: Float32Array; id: Uint32Array }
/** Keyed by the props array: streaming replaces `town.props` on the same Town, so the Town alone is not a key. */
const treeLists = new WeakMap<Town["props"], TreeList>()

function townTrees(town: Town): TreeList {
  let list = treeLists.get(town.props)
  if (list) return list
  const trees = town.props.filter((p) => p.kind === "tree")
  list = { x: new Float32Array(trees.length), z: new Float32Array(trees.length), r: new Float32Array(trees.length), id: new Uint32Array(trees.length) }
  trees.forEach((t, i) => {
    list!.x[i] = t.x
    list!.z[i] = t.y
    list!.r[i] = treeCrownRadius(t.variant)
    list!.id[i] = treeIdAt(t.x, t.y)
  })
  treeLists.set(town.props, list)
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
  // Shrub and hedge spots after the trees, nearest first, marked by a negative radius.
  let n = picked.n
  if (spotSource && n < TREE_BURN_SLOTS) {
    spots.length = 0
    spotSource((x, z, r, b) => {
      const d2 = (x - px) ** 2 + (z - pz) ** 2
      if (b > 0.002 && r > 0.05 && d2 < 40 * 40) spots.push({ x, z, r, b: Math.min(1, b), d2 })
    })
    spots.sort((a, b) => a.d2 - b.d2)
    for (let k = 0; k < spots.length && n < TREE_BURN_SLOTS && k < SPOT_SLOTS; k++, n++) {
      const sp = spots[k]!
      const o = offset + 4 + n * 4
      out[o] = sp.x
      out[o + 1] = sp.z
      out[o + 2] = -sp.r
      out[o + 3] = sp.b
    }
  }
  out[offset + 3] = n
  out.fill(0, offset + 4 + n * 4, offset + VEG_TREE_UNIFORM_FLOATS)
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
  vegBurn: array<vec4f, ${TREE_BURN_SLOTS}>, // burning trees: x, z, crown radius (negative: a shrub and hedge spot), burn (0..1)`

/** WGSL helpers; declare after `OL`. */
export const vegetationTreeWgsl = /* wgsl */ `
/** How much of this fragment the fog of war treats as seen because the torch lights it through the crown (A, C). */
var<private> outbreakTreeSeen: f32;
/**
 * The colour-from-light mask the torch lends a crown it lights through (A, C), scaled by "Tree colour in light". The
 * scene's colour rule reads it beside \`litMask\`, so the leaves keep their pigment instead of going moon grey.
 */
fn outbreakTreeColourLit() -> f32 {
  return outbreakTreeSeen * clamp(0.6 * OL.vegTrees.z, 0.0, 0.9);
}
/** Tree canopy (foliage 0 < aux < 2.5) or a swaying limb (timber aux >= 7.5). Shrubs and grass are not trees. */
fn outbreakIsTreePart(mat: f32, aux: f32) -> bool {
  return (mat > 21.5 && mat < 22.5 && aux > 0.0 && aux < 2.5) || (mat > 23.5 && mat < 24.5 && aux > 7.5);
}
/** Shrub and hedge foliage (FOLIAGE_BUSH_AUX 3 plus flex). */
fn outbreakIsBushPart(mat: f32, aux: f32) -> bool {
  return mat > 21.5 && mat < 22.5 && aux >= 2.5 && aux < 4.5;
}

/**
 * The strongest burn reaching \`p\`: its x, z and radius, and the burn there (0 when none). Trees take only burning
 * trees; shrubs and hedges (\`bush\`) also take the ground spots and the ground under a burning crown.
 */
fn outbreakTreeBurnAt(p: vec3f, bush: bool) -> vec4f {
  var best = vec4f(0.0);
  let count = i32(OL.vegTrees.w);
  for (var i = 0; i < ${TREE_BURN_SLOTS}; i++) {
    if (i >= count) { break; }
    let t = OL.vegBurn[i];
    if (t.z < 0.0 && !bush) { continue; }
    let r = select(t.z, select(t.z * 0.6, -t.z, t.z < 0.0), bush);
    let k = t.w * (1.0 - smoothstep(r * 0.8, r * 1.15, length(p.xz - t.xy)));
    if (k > best.w) { best = vec4f(t.xy, r, k); }
  }
  return best;
}

/**
 * Burnt-away leaves fold away (zero-area triangles, no discard) from burn 0.55 to 0.95: a tree's into its trunk below
 * ground, a shrub's down into the ground where it stood.
 */
fn outbreakTreeBurnVertex(p: vec3f, mat: f32, aux: f32) -> vec3f {
  if (OL.vegTrees.w < 0.5 || mat > 22.5) { return p; }
  let bush = aux >= 2.5;
  let b = outbreakTreeBurnAt(p, bush);
  let k = smoothstep(0.55, 0.95, b.w);
  if (bush) { return p - vec3f(0.0, 1.8 * k, 0.0); }
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
  return smoothstep(-0.2, 0.6, along) * (1.0 - smoothstep(cone * 0.75, cone * 1.3, across)) * smoothstep(0.0, 0.35, t);
}

/**
 * Tree look shading and burn, before the fog of war. Shade (Deadwood, Darkwood): outside light the canopy and limbs
 * sink to near-black, grey, a little less by day; where a flashlight, lamp, window or fire lands (\`litMask\`) they keep
 * and enrich their colour. Burn: char toward black, embers glowing while it burns.
 */
fn outbreakTreeSurface(col: vec3f, litMask: f32, sunVal: f32, world: vec3f, mat: i32, aux: f32) -> vec3f {
  let bush = outbreakIsBushPart(f32(mat), aux);
  if (bush) { return outbreakBurnChar(col, world, mat, true); }
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
    rich += select(vec3f(0.0), outbreakAlbedo * OL.u5.rgb * vec3f(1.0, 1.15, 0.7) * beam * 0.45 * shade * clamp(OL.vegTrees.z, 0.0, 1.5), leaf);
    c = mix(unlit, rich, max(smoothstep(0.04, 0.55, litMask), beam * select(0.5, 1.0, leaf)));
  }
  return outbreakBurnChar(c, world, mat, false);
}

/** Burn: char toward black, embers glowing in the leaves and bark while it burns. */
fn outbreakBurnChar(col: vec3f, world: vec3f, mat: i32, bush: bool) -> vec3f {
  if (OL.vegTrees.w < 0.5) { return col; }
  let b = outbreakTreeBurnAt(world, bush).w;
  if (b <= 0.001) { return col; }
  let lum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
  var c = mix(col, vec3f(lum * 0.1 + 0.004), smoothstep(0.08, 0.6, b));
  let ember = smoothstep(0.12, 0.35, b) * (1.0 - smoothstep(0.65, 0.95, b));
  // Embers breathe slowly and unevenly (no per-frame flicker, so TAA keeps them).
  let ph = dot(world, vec3f(3.1, 1.7, 2.3));
  let flick = 0.55 + 0.3 * sin(F.cam.w * 2.3 + ph) + 0.15 * sin(F.cam.w * 5.1 + ph * 1.7);
  c += vec3f(1.4, 0.42, 0.08) * ember * flick * select(0.3, 0.16, mat == 24);
  return c;
}
`
