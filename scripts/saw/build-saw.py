"""Builds TIMBER's chainsaw from Lassi Kaukonen's photogrammetry scan "Chainsaw" (CC BY 4.0, Sketchfab 052d0c1d...) for
scripts/saw/build-saw.ts:

  blender -b --factory-startup --python scripts/saw/build-saw.py -- <source.glb> <out.glb> <scratch dir> [preview dir]

The scan's powerhead (housing, wrap handle, rear handle and trigger, hand guard, vents, clutch cover and bar nuts) is
kept; its short, blobby bar and chain and its starter grip are cut away. Everything else here is made: an 18" bar with
a sprocket nose, a 3/8" chain of real links (drive links, tie straps, left and right cutters with ground edges), a
T-handle starter grip with its cord, and the lumberjack's work gloves and flannel sleeves gripping the two handles.

The scan is repainted from bakes of itself (mask, position, normal, curvature, ambient occlusion): two-tone orange cover
over a dark grey crankcase and handles, scuffed bare at the edges, sawdust and bar oil in the crevices, dried blood
flecked over the front, the yellow sticker and labels gone. LOD0 is decimated from the 246k-triangle scan with its
detail baked into a normal map; LOD1 (third person) is a much lower copy with the paint in vertex colours.

Saw metres while building: X right, Y forward along the bar, Z up; glTF out is Y up, the bar along -Z, right +X.
Prints `SAW {json}`: triangle counts and the landmarks the game animates and emits effects from (glTF coordinates).
"""

import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT, TMP = argv[0], argv[1], argv[2]
PREVIEW = argv[3] if len(argv) > 3 else ""
os.makedirs(TMP, exist_ok=True)
QUICK = os.environ.get("SAW_QUICK") == "1"

#: Scan units to metres, and the turn that puts the bar along +Y.
SCALE = 0.07
#: Housing maps (px) and bake samples.
PX = 512 if QUICK else 2048
AO_SAMPLES = 16 if QUICK else 48
#: Boxes (saw metres, lo/hi corners) round the scan's label plates, painted over.
LABELS = []
#: Triangle targets.
LOD0_TRIS = 16000
LOD1_TRIS = 4500
#: The bar: chain path round a drive sprocket inside the clutch cover and a sprocket nose, in the bar plane x = BAR_X.
BAR_X = 0.062
BAR_Z = 0.088
REAR = (0.058, 0.031)   # centre y, radius (m)
NOSE = (0.578, 0.0205)  # 18" out from the powerhead's front
BAR_T = 0.0048          # plate thickness
#: Chain: drive links over the loop (an even number) and link dimensions (m).
DRIVE_LINKS = 66
GAUGE = 0.0013
SIDE_T = 0.0011
SIDE_GAP = GAUGE / 2 + SIDE_T / 2 + 0.0002

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 1

# --- Scan: flatten, metres, bar along +Y. --------------------------------------------------------------------------------
bpy.ops.import_scene.gltf(filepath=SRC)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
for o in meshes:
    w = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = w
for o in [o for o in bpy.data.objects if o.type != "MESH"]:
    bpy.data.objects.remove(o)
bpy.ops.object.select_all(action="SELECT")
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.object.join()
scan = bpy.context.view_layer.objects.active
scan.name = "scan"
scan.data.transform(Matrix.Scale(SCALE, 4) @ Matrix.Rotation(math.pi, 4, "Z"))
src_mat = scan.data.materials[0]


def src_image(role):
    bsdf = next(n for n in src_mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    for n in src_mat.node_tree.nodes:
        if n.type != "TEX_IMAGE":
            continue
        for link in n.outputs["Color"].links:
            to = link.to_node
            if role == "base" and to == bsdf:
                return n.image
            if role == "normal" and to.type == "NORMAL_MAP":
                return n.image
    return None


SRC_BASE = src_image("base")

# Cut the scanned bar and chain, and the starter's T-grip (rebuilt as its own part so the hand can pull it).
bm = bmesh.new()
bm.from_mesh(scan.data)
# The scan comes in three pieces split along unwelded seams, many triangles wound backwards: weld, then wind outward.
bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])


def on_bar(c):
    return c.y > 0.1435 and 0.051 < c.x < 0.0735 and c.z < 0.1435


def on_grip(c):
    return c.x < -0.104 and -0.095 < c.y < -0.012 and c.z > 0.153


kill = [f for f in bm.faces if all(on_bar(v.co) or on_grip(v.co) for v in f.verts)]
bmesh.ops.delete(bm, geom=kill, context="FACES")
# Loose crumbs left behind.
bm.verts.ensure_lookup_table()
islands, seen = [], set()
for f in bm.faces:
    if f.index in seen:
        continue
    stack, isl = [f], []
    seen.add(f.index)
    while stack:
        g = stack.pop()
        isl.append(g)
        for e in g.edges:
            for h in e.link_faces:
                if h.index not in seen:
                    seen.add(h.index)
                    stack.append(h)
    islands.append(isl)
islands.sort(key=len, reverse=True)
crumbs = [f for isl in islands if len(isl) < 200 for f in isl]
bmesh.ops.delete(bm, geom=crumbs, context="FACES")
bm.to_mesh(scan.data)
bm.free()
scan.data.update()

# --- Paint mask per vertex: orange cover, dark crankcase and handles, bare steel. ------------------------------------------
WRAP = [Vector(p) for p in ((-0.19, 0.063, -0.01), (-0.19, 0.063, 0.18), (-0.175, 0.06, 0.24), (-0.14, 0.055, 0.268), (-0.06, 0.046, 0.276),
                             (0.02, 0.035, 0.278), (0.07, 0.026, 0.272), (0.105, 0.022, 0.258), (0.115, 0.02, 0.225))]


def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (a + ab * t - p).length


def sstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def paint_class(c):
    """(orange, steel) shares at c; the rest is dark grey plastic and rubber."""
    steel = 0.0
    # The bar plate and its two nuts on the clutch side; the muffler; the bucking spikes.
    if c.x > 0.045 and 0.0 < c.y < 0.14 and 0.03 < c.z < 0.115:
        steel = 1.0
    if c.x > 0.06 and c.y > 0.1 and 0.14 < c.z < 0.215:
        steel = 1.0
    if c.y > 0.14 and c.z < 0.12 and c.x < 0.05:
        steel = 1.0
    dark = 0.0
    dark = max(dark, sstep(-0.165, -0.18, c.y))                                   # rear handle
    dark = max(dark, sstep(0.026, 0.02, min(seg_dist(c, WRAP[i], WRAP[i + 1]) for i in range(len(WRAP) - 1))))
    dark = max(dark, sstep(0.142, 0.15, c.y) * sstep(0.18, 0.19, c.z))           # hand guard
    dark = max(dark, sstep(0.07, 0.058, c.z))                                    # crankcase below the cover line
    dark = max(dark, sstep(-0.13, -0.145, c.y) * sstep(0.14, 0.13, c.z))         # fuel/oil tank block at the back
    dark *= 1 - steel
    return (1 - dark) * (1 - steel), steel


me = scan.data
mask = me.color_attributes.new("mask", "FLOAT_COLOR", "POINT")
for v in me.vertices:
    o, s = paint_class(v.co)
    mask.data[v.index].color = (o, s, 1, 1)

# --- LOD0 and LOD1 housings, decimated before baking; every LOD0 map is baked from the full scan onto the scan's own
# UVs, which the decimation keeps. -----------------------------------------------------------------------------------------


def decimated(name, tris, voxel=0.0):
    dup = scan.copy()
    dup.data = scan.data.copy()
    dup.name = name
    scene.collection.objects.link(dup)
    if voxel:
        # Third person: a closed voxel shell first, so the heavy decimation doesn't tear the open scan into shards.
        rm = dup.modifiers.new("remesh", "REMESH")
        rm.mode = "VOXEL"
        rm.voxel_size = voxel
        bpy.context.view_layer.objects.active = dup
        bpy.ops.object.select_all(action="DESELECT")
        dup.select_set(True)
        bpy.ops.object.modifier_apply(modifier=rm.name)
    dec = dup.modifiers.new("dec", "DECIMATE")
    dec.ratio = tris / max(1, len(dup.data.polygons))
    dec.use_collapse_triangulate = True
    dec.delimit = {"UV"}
    bpy.context.view_layer.objects.active = dup
    bpy.ops.object.select_all(action="DESELECT")
    dup.select_set(True)
    bpy.ops.object.modifier_apply(modifier=dec.name)
    for n in list(dup.data.color_attributes):
        dup.data.color_attributes.remove(n)
    bm = bmesh.new()
    bm.from_mesh(dup.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(dup.data)
    bm.free()
    dup.data.shade_smooth()
    dup.data.materials.clear()
    return dup


lod0 = decimated("LOD0_housing", LOD0_TRIS)
lod1 = decimated("LOD1_housing", LOD1_TRIS)


def float_image(name, px):
    img = bpy.data.images.new(name, px, px, alpha=True, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.zeros(px * px * 4, np.float32))
    return img


def emission_material(label, build):
    m = bpy.data.materials.new(label)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(build(nt.nodes, nt.links), em.inputs["Color"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return m


def target_material(img):
    m = bpy.data.materials.new("bake-target")
    m.use_nodes = True
    t = m.node_tree.nodes.new("ShaderNodeTexImage")
    t.image = img
    m.node_tree.nodes.active = t
    return m


def bake_from_scan(img, kind="EMIT", high_mat=None):
    """Bakes the scan (with high_mat) onto LOD0's UVs."""
    if high_mat is not None:
        scan.data.materials.clear()
        scan.data.materials.append(high_mat)
    lod0.data.materials.clear()
    lod0.data.materials.append(target_material(img))
    bpy.ops.object.select_all(action="DESELECT")
    scan.select_set(True)
    lod0.select_set(True)
    bpy.context.view_layer.objects.active = lod0
    b = scene.render.bake
    b.use_selected_to_active = True
    b.cage_extrusion = 0.008
    b.max_ray_distance = 0.03
    b.margin = 8
    b.normal_space = "TANGENT"
    bpy.ops.object.bake(type=kind)
    return np.asarray(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)


def attr_node(nodes, name):
    a = nodes.new("ShaderNodeAttribute")
    a.attribute_name = name
    return a.outputs["Color"]


def geom(nodes, socket):
    return nodes.new("ShaderNodeNewGeometry").outputs[socket]


def src_base(nodes, links):
    t = nodes.new("ShaderNodeTexImage")
    t.image = SRC_BASE
    return t.outputs["Color"]


bake = {}
for label, build in (("mask", lambda n, l: attr_node(n, "mask")), ("pos", lambda n, l: geom(n, "Position")),
                     ("nrm", lambda n, l: geom(n, "Normal")), ("curv", lambda n, l: geom(n, "Pointiness")), ("base", src_base)):
    bake[label] = bake_from_scan(float_image(f"bake-{label}", PX), "EMIT", emission_material(f"bake-{label}", build))
# Ambient occlusion over 2 cm: the crevices sawdust and oil collect in.
bpy.data.worlds.new("w")
scene.world = bpy.data.worlds["w"]
scene.world.light_settings.distance = 0.02
scene.cycles.samples = AO_SAMPLES
bake["ao"] = bake_from_scan(float_image("bake-ao", PX), "AO")
scene.cycles.samples = 1
# Tangent-space normals from the scan's geometry and its own normal map.
scan.data.materials.clear()
scan.data.materials.append(src_mat)
nrm = bake_from_scan(float_image("bake-normal", PX), "NORMAL")[..., :3]
scene.render.bake.use_selected_to_active = False

# --- Repaint (numpy over the atlas). ------------------------------------------------------------------------------------
H = W = PX
valid = bake["mask"][..., 2] > 0.5  # the mask's blue channel is 1 wherever the bake (or its margin) wrote
P = bake["pos"][..., :3]
Nw = bake["nrm"][..., :3]
O = bake["mask"][..., 0]
S = bake["mask"][..., 1]
D = np.clip(1 - O - S, 0, 1)
src = bake["base"][..., :3]
AO = bake["ao"][..., 0]
CURV = bake["curv"][..., 0]


def hash3(ix, iy, iz, seed):
    h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (seed * 2654435761)
    h = (h ^ (h >> 13)) * 1274126177
    return ((h ^ (h >> 16)) & 0xFFFF).astype(np.float32) / 65535.0


def vnoise3(p, freq, seed):
    q = p * freq
    i = np.floor(q).astype(np.int64)
    f = q - i
    u = f * f * (3 - 2 * f)
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (u[..., 0] if dx else 1 - u[..., 0]) * (u[..., 1] if dy else 1 - u[..., 1]) * (u[..., 2] if dz else 1 - u[..., 2])
                out = out + w * hash3(i[..., 0] + dx, i[..., 1] + dy, i[..., 2] + dz, seed)
    return out


def fbm3(p, freq, seed, octaves=4):
    out, amp, total = 0, 1.0, 0.0
    for k in range(octaves):
        out = out + amp * vnoise3(p, freq * (2 ** k), seed + k)
        total += amp
        amp *= 0.5
    return out / total


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    t = t[..., None] if np.ndim(t) == 2 else t
    return a * (1 - t) + b * t




def box_blur(x, r):
    for ax in (0, 1):
        x = sum(np.roll(x, d, axis=ax) for d in range(-r, r + 1)) / (2 * r + 1)
    return x


CURV = np.where(valid, box_blur(np.where(valid, CURV, 0.5), max(1, PX // 512)), 0.5)
AO = np.where(valid, box_blur(np.where(valid, AO, 1.0), max(1, PX // 512)), 1.0)
lum = src @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
mid = float(np.median(lum[valid])) if valid.any() else 0.05
detail = np.clip(lum / max(mid, 1e-4), 0.3, 4.0)
mx, mn = src.max(axis=2), src.min(axis=2)
sat = (mx - mn) / np.maximum(mx, 1e-4)
# The yellow sticker, red and blue bits, and the label plates' lettering: painted out.
label = smooth(0.35, 0.55, sat) * smooth(0.02, 0.06, mx)
for (lo, hi) in LABELS:
    inside = np.all((P > np.array(lo, np.float32)) & (P < np.array(hi, np.float32)), axis=-1)
    label = np.maximum(label, inside.astype(np.float32))
detail = detail * (1 - label) + label
if os.environ.get("SAW_DEBUG") == "1":
    m_ = valid & (Nw[..., 0] < -0.5) & (detail > 2.2)
    print("LABEL? x", np.percentile(P[m_][:, 0], [5, 95]) if m_.any() else None, "y", np.percentile(P[m_][:, 1], [5, 50, 95]) if m_.any() else None,
          "z", np.percentile(P[m_][:, 2], [5, 50, 95]) if m_.any() else None)
big = fbm3(P, 9.0, 1)
fine = fbm3(P, 160.0, 7, 3)
ORANGE = np.array((0.40, 0.075, 0.014), np.float32)
FADED = np.array((0.36, 0.105, 0.045), np.float32)
REDDER = np.array((0.30, 0.036, 0.012), np.float32)
GREY = np.array((0.028, 0.028, 0.03), np.float32)
STEEL = np.array((0.30, 0.29, 0.28), np.float32)
RUST = np.array((0.16, 0.06, 0.025), np.float32)
DUST = np.array((0.30, 0.25, 0.18), np.float32)
SAWDUST = np.array((0.52, 0.38, 0.20), np.float32)
OIL = np.array((0.012, 0.009, 0.006), np.float32)
BLOOD = np.array((0.075, 0.006, 0.004), np.float32)

orange = mix(mix(ORANGE, FADED, smooth(0.45, 0.8, big) * smooth(0.0, 0.6, Nw[..., 2])), REDDER, smooth(0.55, 0.25, big) * 0.6)
orange = orange * (0.82 + 0.3 * fine)[..., None]
grey = GREY * (0.8 + 0.5 * fine)[..., None]
steel = mix(STEEL * (0.6 + 0.6 * fine)[..., None], RUST, smooth(0.5, 0.8, fbm3(P, 60.0, 11)) * 0.7)
col = orange * O[..., None] + grey * D[..., None] + steel * S[..., None]
# The scan's own grime: darker patches stay darker; dust-lightened ones go to dust instead of brighter paint.
col = col * (1 + 0.22 * np.clip(np.log2(detail), -1.2, 0.8))[..., None]
dusty = smooth(2.0, 3.4, detail) * smooth(-0.2, 0.5, Nw[..., 2])
col = mix(col, DUST * (0.7 + 0.5 * fine)[..., None], dusty * 0.5)
# Scuffs: convex edges rubbed bare, the orange paler and chalky, the grey worn lighter, steel bright.
edge = smooth(0.505, 0.56, CURV) * smooth(0.35, 0.65, fbm3(P, 90.0, 21, 3))
col = mix(col, mix(np.array((0.55, 0.22, 0.09), np.float32), np.array((0.09, 0.088, 0.085), np.float32), D) * (1 - S[..., None]) + np.array((0.6, 0.6, 0.6), np.float32) * S[..., None], edge * 0.65)
# Crevices: sawdust packed in, darkened with bar oil at the bottom of the deepest ones; worse near the clutch and bar.
cav = np.clip(smooth(0.49, 0.43, CURV) * 0.7 + smooth(0.35, 0.8, 1 - AO) * 0.5, 0, 1)
near_bar = smooth(-0.05, 0.12, P[..., 1]) * smooth(0.2, 0.02, P[..., 2])
dust_k = np.clip(cav * (0.55 + 0.6 * near_bar) * smooth(0.25, 0.6, fbm3(P, 70.0, 31)) + near_bar * 0.25 * smooth(0.55, 0.7, fbm3(P, 120.0, 33)), 0, 1)
col = mix(col, SAWDUST * (0.75 + 0.4 * fine)[..., None], dust_k * 0.85)
oily = np.clip(cav * 0.5 * smooth(0.45, 0.7, fbm3(P, 25.0, 42)) + near_bar * smooth(0.5, 0.8, fbm3(P, 25.0, 41)) * 0.5, 0, 1)
col = mix(col, OIL, oily * 0.6)
# Dried blood: a spray across the front (hand guard, clutch side, top), fine flecks and a few smears.
front = smooth(0.0, 0.16, P[..., 1]) * (0.4 + 0.6 * smooth(-0.1, 0.5, Nw[..., 1]))
fleck = smooth(0.78, 0.86, vnoise3(P, 900.0, 51)) + smooth(0.8, 0.9, vnoise3(P, 380.0, 52)) * 0.8
smear = smooth(0.62, 0.75, fbm3(P, 30.0, 53)) * smooth(0.4, 0.7, vnoise3(P, 200.0, 54))
blood = np.clip((fleck + smear) * front * smooth(0.3, 0.6, fbm3(P, 8.0, 55)), 0, 1)
col = mix(col, BLOOD * (0.7 + 0.6 * fine)[..., None], blood * 0.9)

AOm = np.clip(0.45 + 0.55 * AO, 0, 1)
rough = 0.52 + 0.18 * fine - 0.12 * S
rough = rough + dusty * 0.25 + edge * 0.12 + dust_k * 0.3 - oily * 0.32 - blood * 0.15
rough = np.where(S > 0.5, np.clip(rough, 0.25, 0.7), np.clip(rough, 0.3, 0.92))
metal = np.clip(S * (1 - dust_k) * (1 - blood) * (1 - oily * 0.5), 0, 1)


def save(label, rgb, srgb, alpha=None):
    if srgb:
        rgb = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(np.clip(rgb, 0, None), 1 / 2.4) - 0.055)
    h, w = rgb.shape[:2]
    a = np.ones((h, w, 1), np.float32) if alpha is None else alpha[..., None]
    img = bpy.data.images.new(label, w, h, alpha=alpha is not None)
    img.pixels.foreach_set(np.concatenate([np.clip(rgb, 0, 1), a], axis=2).astype(np.float32).ravel())
    img.filepath_raw = os.path.join(TMP, label + ".png")
    img.file_format = "PNG"
    img.save()
    out = bpy.data.images.load(img.filepath_raw)
    out.name = label
    out.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
    bpy.data.images.remove(img)
    return out


if os.environ.get("SAW_DEBUG") == "1":
    for k, v in (("dbg-ao", AO), ("dbg-curv", np.clip((CURV - 0.4) * 5, 0, 1)), ("dbg-detail", np.clip(detail / 3, 0, 1)), ("dbg-O", O), ("dbg-S", S),
                 ("dbg-label", label), ("dbg-oily", oily), ("dbg-dust", dust_k), ("dbg-edge", edge), ("dbg-src", lum / max(mid, 1e-4) / 4)):
        save(k, np.repeat(np.clip(v, 0, 1)[..., None], 3, axis=2), False)
# Fill the background so mips don't pull black into chart edges.


def pushpull(x, ok):
    """Fills texels outside ok from the valid ones around them (mip pyramid down, then back up), so seams, mips and any
    texel the bake missed take their neighbours' colour instead of a flat fill."""
    x = np.where(ok[..., None], x, 0).astype(np.float32)
    w = ok.astype(np.float32)
    levels = [(x, w)]
    while levels[-1][0].shape[0] > 1:
        a, b = levels[-1]
        h, ww = a.shape[0] // 2, a.shape[1] // 2
        a = a[:h * 2, :ww * 2].reshape(h, 2, ww, 2, -1).sum(axis=(1, 3))
        b = b[:h * 2, :ww * 2].reshape(h, 2, ww, 2).sum(axis=(1, 3))
        levels.append((a, b))
    up = levels[-1][0] / np.maximum(levels[-1][1], 1e-6)[..., None]
    for a, b in reversed(levels[:-1]):
        up = np.repeat(np.repeat(up, 2, axis=0), 2, axis=1)
        # Odd sizes: the halving dropped a row or column, so the doubled level is short by one.
        up = np.pad(up, ((0, max(0, a.shape[0] - up.shape[0])), (0, max(0, a.shape[1] - up.shape[1])), (0, 0)), mode="edge")[:a.shape[0], :a.shape[1]]
        here = a / np.maximum(b, 1e-6)[..., None]
        up = np.where((b > 0)[..., None], here, up)
    return up


nrm = pushpull(nrm, valid)
col = pushpull(col, valid)
orm = pushpull(np.stack([AOm, rough, metal], axis=2), valid)
housing_base = save("housing-base", col, True)
housing_orm = save("housing-orm", orm, False)


def material(label, base=None, orm=None, normal=None, color=(1, 1, 1), rough=1.0, metal=0.0, occlusion=False):
    m = bpy.data.materials.new(label)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if base:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = base
        nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    if orm:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = orm
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(t.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
        if occlusion:
            # The glTF exporter's occlusion convention: a "glTF Material Output" group with an Occlusion input.
            grp = bpy.data.node_groups.get("glTF Material Output") or bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
            if "Occlusion" not in [s.name for s in grp.interface.items_tree]:
                grp.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
            g = nt.nodes.new("ShaderNodeGroup")
            g.node_tree = grp
            nt.links.new(sep.outputs["Red"], g.inputs["Occlusion"])
    if normal:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = normal
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    return m


housing_normal = save("housing-normal", nrm, False)
housing = material("housing", housing_base, housing_orm, housing_normal, occlusion=True)
lod0.data.materials.clear()
lod0.data.materials.append(housing)

# LOD1 carries the paint per vertex (third person draws it untextured): each vertex takes the albedo at the nearest
# point of LOD0, blurred a little so the low mesh doesn't alias the scuffs.
alb = np.asarray(housing_base.pixels[:], dtype=np.float32).reshape(PX, PX, 4)[..., :3]
alb = np.where(alb <= 0.04045, alb / 12.92, ((alb + 0.055) / 1.055) ** 2.4)
k_ = max(1, PX // 128)
alb_blur = alb.copy()
for ax in (0, 1):
    alb_blur = sum(np.roll(alb_blur, d, axis=ax) for d in range(-k_, k_ + 1)) / (2 * k_ + 1)
lod0.data.calc_loop_triangles()
bvh = BVHTree.FromObject(lod0, bpy.context.evaluated_depsgraph_get())
uv0 = lod0.data.uv_layers.active.data
tri_of_poly = {}
for lt in lod0.data.loop_triangles:
    tri_of_poly.setdefault(lt.polygon_index, lt)
attr = lod1.data.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
for v in lod1.data.vertices:
    loc, _, pi, _ = bvh.find_nearest(v.co)
    lt = tri_of_poly[pi]
    a_, b_, c_ = (lod0.data.vertices[i].co for i in lt.vertices)
    w = barycentric_transform(loc, a_, b_, c_, Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
    uv = sum((uv0[li].uv * w[k] for k, li in enumerate(lt.loops)), Vector((0, 0)))
    x = min(PX - 1, max(0, int(uv.x * PX)))
    y = min(PX - 1, max(0, int(uv.y * PX)))
    attr.data[v.index].color = (*alb_blur[y, x], 1)
lod1.data.color_attributes.active_color = attr
bpy.data.objects.remove(scan)

# --- The bar. -------------------------------------------------------------------------------------------------------------
y1, r1 = REAR
y2, r2 = NOSE
D_ = y2 - y1
PHI = math.asin((r1 - r2) / D_)
STRAIGHT = math.sqrt(D_ * D_ - (r1 - r2) ** 2)
ARC2 = r2 * (math.pi - 2 * PHI)
ARC1 = r1 * (math.pi + 2 * PHI)
LOOP = 2 * STRAIGHT + ARC1 + ARC2


def path(s, inset=0.0):
    """Chain path in the bar plane: (y, z), unit tangent (dy, dz), outward normal. s from the top of the drive
    sprocket, the top run moving towards the nose. inset moves the point in along the normal."""
    s = s % LOOP
    n_up = (math.sin(PHI), math.cos(PHI))
    if s < STRAIGHT:
        a = (y1 + r1 * n_up[0], BAR_Z + r1 * n_up[1])
        d = (math.cos(PHI), -math.sin(PHI))
        p = (a[0] + d[0] * s, a[1] + d[1] * s)
        n = n_up
    elif s < STRAIGHT + ARC2:
        th = (math.pi / 2 - PHI) - (s - STRAIGHT) / r2
        n = (math.cos(th), math.sin(th))
        p = (y2 + r2 * n[0], BAR_Z + r2 * n[1])
        d = (math.sin(th), -math.cos(th))
    elif s < 2 * STRAIGHT + ARC2:
        n_dn = (math.sin(PHI), -math.cos(PHI))
        a = (y2 + r2 * n_dn[0], BAR_Z + r2 * n_dn[1])
        d = (-math.cos(PHI), -math.sin(PHI))
        q = s - STRAIGHT - ARC2
        p = (a[0] + d[0] * q, a[1] + d[1] * q)
        n = n_dn
    else:
        th = -(math.pi / 2 - PHI) - (s - 2 * STRAIGHT - ARC2) / r1
        n = (math.cos(th), math.sin(th))
        p = (y1 + r1 * n[0], BAR_Z + r1 * n[1])
        d = (math.sin(th), -math.cos(th))
    return (p[0] - n[0] * inset, p[1] - n[1] * inset), d, n


def new_obj(name, me):
    o = bpy.data.objects.new(name, me)
    scene.collection.objects.link(o)
    return o


# Plate outline: the chain path pulled in to the rails' edge; the tail ends square inside the clutch cover.
BAR_IN = 0.0035
outline = []
steps = 220
for k in range(steps):
    s = k / steps * LOOP
    (py, pz), _, _ = path(s, BAR_IN)
    if py < 0.105:
        continue
    outline.append((py, pz))
# Close the tail with a straight edge at y = 0.105 (hidden in the powerhead).
top = [p for p in outline]
bm = bmesh.new()
uvs = {}
front, back = [], []
for (py, pz) in top:
    front.append(bm.verts.new((BAR_X + BAR_T / 2, py, pz)))
    back.append(bm.verts.new((BAR_X - BAR_T / 2, py, pz)))
fF = bm.faces.new(front)
fB = bm.faces.new(list(reversed(back)))
n = len(front)
sides = []
for i in range(n):
    j = (i + 1) % n
    sides.append(bm.faces.new((front[i], back[i], back[j], front[j])))
bmesh.ops.triangulate(bm, faces=[fF, fB])
bm.normal_update()
bar_me = bpy.data.meshes.new("bar")
bm.to_mesh(bar_me)
bm.free()
bar = new_obj("LOD0_bar", bar_me)
# UVs: both faces by (y, z) over the texture's top 15/16; the rail edges along the bottom strip.
BAR_Y0, BAR_Y1 = 0.10, y2 + r2 + 0.002
BAR_Z0, BAR_Z1 = BAR_Z - r1 - 0.002, BAR_Z + r1 + 0.002
uvl = bar_me.uv_layers.new(name="UV").data
for p in bar_me.polygons:
    side = abs(p.normal.x) < 0.5
    for li in p.loop_indices:
        c = bar_me.vertices[bar_me.loops[li].vertex_index].co
        u = (c.y - BAR_Y0) / (BAR_Y1 - BAR_Y0)
        if side:
            v = 0.008 + (c.x - (BAR_X - BAR_T / 2)) / BAR_T * 0.045
        else:
            v = 1 / 16 + (c.z - BAR_Z0) / (BAR_Z1 - BAR_Z0) * (15 / 16)
        uvl[li].uv = (u, v)
for p in bar_me.polygons:
    p.use_smooth = False

# Bar maps: 2048 x 256 brushed steel, polished rails, a sprocket nose with rivets, oil, sawdust, resin and blood.
BW, BH = (1024, 128) if QUICK else (2048, 256)
uu = (np.arange(BW)[None, :] + 0.5) / BW
vv = (np.arange(BH)[:, None] + 0.5) / BH
by = BAR_Y0 + uu * (BAR_Y1 - BAR_Y0)
bz = BAR_Z0 + (vv - 1 / 16) / (15 / 16) * (BAR_Z1 - BAR_Z0)
is_edge = np.broadcast_to(vv < 1 / 16, (BH, BW))
# Distance in from the outline: rails are the outer ~6 mm.
# Signed distance to the tapered stadium (rails within 6 mm of the edge).
t_ = np.clip((by - y1) / D_, 0, 1)
rr = r1 + (r2 - r1) * t_
dist_c = np.sqrt((by - (y1 + t_ * D_)) ** 2 + (bz - BAR_Z) ** 2)
sd = (np.where(by > y2, np.sqrt((by - y2) ** 2 + (bz - BAR_Z) ** 2) - r2, np.abs(bz - BAR_Z) - rr)) + BAR_IN
rng = np.random.default_rng(3)


def p3(y, z, x=0.0):
    return np.stack(np.broadcast_arrays(np.asarray(x, np.float32), y.astype(np.float32), z.astype(np.float32)), axis=-1)


Pb = p3(by, bz)
streak = vnoise3(np.stack(np.broadcast_arrays(by * 4.0, bz * 600.0, np.zeros_like(by)), axis=-1), 1.0, 61)
streak = 0.6 * streak + 0.4 * vnoise3(np.stack(np.broadcast_arrays(by * 9.0, bz * 1800.0, np.zeros_like(by)), axis=-1), 1.0, 62)
rail = smooth(-0.0065, -0.0045, sd)
scratch = smooth(0.82, 0.95, vnoise3(np.stack(np.broadcast_arrays(by * 30.0, bz * 2500.0, np.zeros_like(by)), axis=-1), 1.0, 63))
col_b = np.zeros((BH, BW, 3), np.float32) + np.array((0.26, 0.265, 0.27), np.float32)
col_b = col_b * (0.75 + 0.45 * streak)[..., None]
col_b = mix(col_b, np.array((0.62, 0.62, 0.63), np.float32) * (0.85 + 0.25 * streak)[..., None], rail)
col_b = mix(col_b, np.array((0.75, 0.75, 0.76), np.float32), scratch * (0.3 + 0.7 * rail))
# Nose sprocket: a riveted disc and its ring.
nose_d = np.sqrt((by - y2) ** 2 + (bz - BAR_Z) ** 2)
ring = smooth(0.0012, 0.0004, np.abs(nose_d - 0.0175))
riv = np.zeros_like(nose_d)
for a in (0.0, 2.1, 4.2):
    riv = np.maximum(riv, smooth(0.0026, 0.0018, np.sqrt((by - (y2 - 0.009 * math.cos(a))) ** 2 + (bz - (BAR_Z + 0.009 * math.sin(a))) ** 2)))
riv = np.maximum(riv, smooth(0.0034, 0.0026, np.sqrt((by - (y2 - 0.034)) ** 2 + (bz - BAR_Z) ** 2)))
col_b = mix(col_b, np.array((0.12, 0.12, 0.12), np.float32), ring * 0.8)
col_b = mix(col_b, np.array((0.5, 0.5, 0.5), np.float32), riv)
# Oil: dark wet streaks along the rails and a sheen everywhere; sawdust and resin caked at the tail and nose.
oil_b = np.clip(rail * 0.7 + 0.5 * smooth(0.5, 0.8, fbm3(Pb, 40.0, 64)), 0, 1)
col_b = mix(col_b, col_b * 0.45, oil_b * 0.6)
tail = smooth(0.22, 0.12, by) + smooth(y2 - 0.08, y2, by) * 0.6
caked = np.clip(tail * smooth(0.35, 0.65, fbm3(Pb, 90.0, 65)) + rail * 0.3 * smooth(0.62, 0.8, fbm3(Pb, 120.0, 66)), 0, 1)
col_b = mix(col_b, np.array((0.45, 0.32, 0.16), np.float32) * (0.7 + 0.5 * fbm3(Pb, 400.0, 67))[..., None], caked * 0.85)
resin = smooth(0.7, 0.8, fbm3(Pb, 35.0, 68)) * smooth(0.3, 0.45, by)
col_b = mix(col_b, np.array((0.18, 0.09, 0.02), np.float32), resin * 0.7)
bloodb = np.clip((smooth(0.86, 0.94, fbm3(Pb, 500.0, 69, 2)) * 0.7 + smooth(0.68, 0.8, fbm3(Pb, 25.0, 70)) * 0.8) * smooth(0.2, 0.35, by) * smooth(0.6, 0.45, by), 0, 1)
col_b = mix(col_b, np.array((0.07, 0.006, 0.004), np.float32), bloodb * 0.85)
# Rail edges (the strip): bright ground steel, scuffed.
edge_col = np.array((0.7, 0.7, 0.71), np.float32) * (0.8 + 0.3 * streak)[..., None]
col_b = np.where(is_edge[..., None], mix(edge_col, np.array((0.4, 0.3, 0.18), np.float32), caked * 0.5), col_b)
rough_b = 0.42 - 0.12 * rail - 0.2 * oil_b + 0.15 * streak + 0.45 * caked - 0.1 * scratch - 0.1 * bloodb
rough_b = np.where(is_edge, 0.28 + 0.3 * caked, rough_b)
metal_b = np.clip(1 - caked - bloodb * 0.8 - resin * 0.6, 0, 1)
height = 0.4 * streak + 0.6 * riv - 0.5 * ring + 0.3 * caked * fbm3(Pb, 500.0, 71)
gy, gx = np.gradient(height)
nb = np.stack([-gx * 1.2, -gy * 1.2, np.ones_like(gx)], axis=-1)
nb /= np.linalg.norm(nb, axis=-1, keepdims=True)
# Saved below, with the gloves' leather packed under the bar in the same maps.
bar_maps = (col_b, np.stack([np.ones_like(rough_b), np.clip(rough_b, 0.08, 1), metal_b], axis=2), nb)

# --- The chain: real links, each rigid at its own spot on the path (TEXCOORD_1.x). ----------------------------------------
GAPS = DRIVE_LINKS * 2
G = LOOP / GAPS
cbm = bmesh.new()
s_of_face = []  # (face, s, palette cell)
# Palette cells (4 x 4 of a 64 px texture): 0 oily steel, 1 ground chrome, 2 drive link, 3 rivet, 4 sawdust-caked.
CELLS = {0: (0.22, 0.22, 0.225, 0.34, 1), 1: (0.86, 0.86, 0.87, 0.12, 1), 2: (0.11, 0.11, 0.115, 0.4, 1), 3: (0.42, 0.42, 0.43, 0.28, 1),
         4: (0.40, 0.29, 0.15, 0.8, 0.2), 5: (0.08, 0.008, 0.005, 0.35, 0.2)}


def link_mesh(s, profile, x0, x1, cell, edge_cell=None, crown=None):
    """Extrudes a 2D profile ((t, n) in metres: t along the chain, n outward) at path spot s, between x0 and x1 off the
    bar plane. Returns its faces."""
    (py, pz), d, nrm = path(s)
    vs_a, vs_b = [], []
    for (tt, nn) in profile:
        y = py + d[0] * tt + nrm[0] * nn
        z = pz + d[1] * tt + nrm[1] * nn
        vs_a.append(cbm.verts.new((BAR_X + x0, y, z)))
        vs_b.append(cbm.verts.new((BAR_X + x1, y, z)))
    faces = []
    try:
        fa = cbm.faces.new(vs_a)
        fb = cbm.faces.new(list(reversed(vs_b)))
    except ValueError:
        return []
    faces += [(fa, cell), (fb, cell)]
    m = len(vs_a)
    for i in range(m):
        j = (i + 1) % m
        f = cbm.faces.new((vs_a[i], vs_a[j], vs_b[j], vs_b[i]))
        faces.append((f, edge_cell if edge_cell is not None else cell))
    for f, c in faces:
        s_of_face.append((f, s, c))
    return faces


def rounded(t0, t1, n0, n1, r, k=3):
    """A rounded rectangle profile."""
    pts = []
    for (cx, cy, a0) in ((t1 - r, n1 - r, 0), (t0 + r, n1 - r, 90), (t0 + r, n0 + r, 180), (t1 - r, n0 + r, 270)):
        for i in range(k + 1):
            a = math.radians(a0 + 90 * i / k)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


for i in range(GAPS):
    s = (i + 0.5) * G
    if i % 2 == 0:
        # Drive link: a centre plate whose tang dips into the groove.
        prof = [(-G * 0.55, 0.0028), (G * 0.55, 0.0028), (G * 0.6, -0.0005), (G * 0.25, -0.0045), (-G * 0.25, -0.0045), (-G * 0.6, -0.0005)]
        link_mesh(s, prof, -GAUGE / 2, GAUGE / 2, 2)
    else:
        kind = (i // 2) % 4  # 0 tie strap pair, 1 left cutter, 2 tie straps, 3 right cutter
        strap = rounded(-G * 0.72, G * 0.72, -0.0018, 0.0036, 0.0016)
        for side in (-1, 1):
            cutter = (kind == 1 and side < 0) or (kind == 3 and side > 0)
            x0, x1 = side * SIDE_GAP - SIDE_T / 2, side * SIDE_GAP + SIDE_T / 2
            if not cutter:
                link_mesh(s, strap, x0, x1, 0, 0)
                continue
            # Cutter side plate: depth gauge hump at the front (toward -t: the chain runs towards +t on top), the
            # tooth rising behind it.
            prof = [(-G * 0.72, -0.0018), (G * 0.75, -0.0018), (G * 0.78, 0.0035), (G * 0.62, 0.0064), (G * 0.05, 0.0066),
                    (-G * 0.05, 0.0052), (-G * 0.3, 0.0050), (-G * 0.45, 0.0057), (-G * 0.62, 0.0050), (-G * 0.72, 0.0030)]
            link_mesh(s, prof, x0, x1, 0, 1)
            # The top plate: bent over the chain towards the other side, its leading edge ground bright.
            top = [(G * 0.05, 0.0058), (G * 0.62, 0.0058), (G * 0.62, 0.0068), (G * 0.05, 0.0068)]
            xs = sorted((side * SIDE_GAP + side * SIDE_T / 2, -side * (SIDE_GAP + SIDE_T / 2)))
            link_mesh(s, top, xs[0], xs[1], 1, 1)
    # Rivet heads at each gap end, both sides.
bmesh.ops.recalc_face_normals(cbm, faces=cbm.faces[:])
cbm.normal_update()
chain_me = bpy.data.meshes.new("chain")
cbm.to_mesh(chain_me)
chain = new_obj("LOD0_chain", chain_me)
face_s = {f.index: (s, c) for f, s, c in s_of_face if f.is_valid}
cbm.free()
uvc = chain_me.uv_layers.new(name="UV").data
uvs = chain_me.uv_layers.new(name="S").data
for p in chain_me.polygons:
    s, c = face_s.get(p.index, (0.0, 0))
    cu, cv = (c % 4 + 0.5) / 4, (c // 4 + 0.5) / 4
    for li in p.loop_indices:
        uvc[li].uv = (cu, cv)
        uvs[li].uv = (s / LOOP, 0.0)
    p.use_smooth = False
# The game shades the chain from its own palette by the cell in UV; no maps.
chain_mat = material("chain", color=CELLS[0][:3], rough=CELLS[0][3], metal=CELLS[0][4])
chain_me.materials.append(chain_mat)

# --- Starter grip and cord. -----------------------------------------------------------------------------------------------
GRIP = Vector((-0.121, -0.052, 0.168))
CORD_EXIT = Vector((-0.113, -0.05, 0.150))
bpy.ops.mesh.primitive_cube_add(size=1)
grip = bpy.context.object
grip.name = "LOD0_grip"
grip.scale = (0.02, 0.074, 0.017)
bpy.ops.object.transform_apply(scale=True)
bev = grip.modifiers.new("bev", "BEVEL")
bev.width = 0.0065
bev.segments = 4
bpy.ops.object.modifier_apply(modifier=bev.name)
# The stem down to the cord.
bm = bmesh.new()
bm.from_mesh(grip.data)
bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=0.006, radius2=0.0075, depth=0.016, matrix=Matrix.Translation((0.003, 0, -0.012)))
bm.to_mesh(grip.data)
bm.free()
grip.data.transform(Matrix.Translation(GRIP))
grip.data.shade_smooth()
grip.data.materials.append(material("grip", color=(0.025, 0.024, 0.023), rough=0.75))
# The cord: exit to the grip's stem; S.x runs 0 at the exit to 1 at the grip so the game can stretch it as the hand pulls.
CORD_END = GRIP + Vector((0.003, 0.0, -0.019))
bm = bmesh.new()
q = Vector((0, 0, 1)).rotation_difference(CORD_END - CORD_EXIT)
rings = []
for j in range(7):
    t_ = j / 6
    p = CORD_EXIT.lerp(CORD_END, t_)
    rings.append([bm.verts.new(p + q @ Vector((0.0022 * math.cos(2 * math.pi * k / 8), 0.0022 * math.sin(2 * math.pi * k / 8), 0))) for k in range(8)])
for ra, rb in zip(rings, rings[1:]):
    for k in range(8):
        bm.faces.new((ra[k], ra[(k + 1) % 8], rb[(k + 1) % 8], rb[k]))
cord_me = bpy.data.meshes.new("cord")
bm.to_mesh(cord_me)
bm.free()
cord = new_obj("LOD0_cord", cord_me)
cord_me.uv_layers.new(name="UV")
cs = cord_me.uv_layers.new(name="S").data
for p_ in cord_me.polygons:
    p_.use_smooth = True
    for li in p_.loop_indices:
        co = cord_me.vertices[cord_me.loops[li].vertex_index].co
        cs[li].uv = ((co - CORD_EXIT).dot(CORD_END - CORD_EXIT) / (CORD_END - CORD_EXIT).length_squared, 0.0)
cord_me.materials.append(material("cord", color=(0.32, 0.30, 0.22), rough=0.85))

# --- Gloves and sleeves: fists closed round the handles. ------------------------------------------------------------------
# Fingers and thumb are tubes wrapped round the handle, palm and back of the hand ellipsoids, the wrist and gauntlet cuff
# tubes; one voxel remesh welds them into a single smooth glove.


def tube_into(bm, pts, radii, seg=12):
    """Appends a capped tube along pts (Vectors) with per-point radii to bm, rounded ends."""
    rings = []
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        q = Vector((0, 0, 1)).rotation_difference(t)
        rings.append([bm.verts.new(p + q @ Vector((radii[i] * math.cos(2 * math.pi * k / seg), radii[i] * math.sin(2 * math.pi * k / seg), 0))) for k in range(seg)])
    for r0, r1 in zip(rings, rings[1:]):
        for k in range(seg):
            bm.faces.new((r0[k], r0[(k + 1) % seg], r1[(k + 1) % seg], r1[k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    for p, r in ((pts[0], radii[0]), (pts[-1], radii[-1])):
        bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=8, radius=r, matrix=Matrix.Translation(p))


def ellipsoid_into(bm, centre, axes, half):
    """axes: three unit Vectors; half: half-lengths along them."""
    m = Matrix((axes[0] * half[0], axes[1] * half[1], axes[2] * half[2])).transposed().to_4x4()
    m.translation = centre
    bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=12, radius=1.0, matrix=m)


def fist(name, centre, axis, up, left, r_up, r_side, arm):
    """A gloved fist round a handle through centre along axis (unit; the index finger at +axis). up: the back of the
    hand's side. The fingers wrap from the up side over V (V = axis x up for a right hand, up x axis for a left) and
    under; the thumb wraps the other way; the wrist leaves on the -V side and the forearm goes off along arm."""
    a = Vector(axis).normalized()
    U = Vector(up)
    U = (U - a * U.dot(a)).normalized()
    V = (U.cross(a) if left else a.cross(U)).normalized()
    c = Vector(centre)
    bm = bmesh.new()

    def ring(theta, rf, along):
        return c + a * along + U * ((r_up + rf) * math.cos(theta)) + V * ((r_side + rf) * math.sin(theta))

    # Fingers: index, middle, ring, little; proximal, middle, distal lengths (m) round the handle.
    fingers = ((0.030, (0.046, 0.027, 0.022), 0.0098), (0.010, (0.050, 0.030, 0.024), 0.0102),
               (-0.010, (0.047, 0.029, 0.023), 0.0097), (-0.029, (0.038, 0.022, 0.020), 0.0088))
    for along, lens, rf in fingers:
        th = math.radians(38)
        pts, radii = [ring(th, rf + 0.006, along)], [rf * 1.08]
        circ = 1.0
        for k, L in enumerate(lens):
            steps = 4
            for j in range(steps):
                rr = (r_up + r_side) / 2 + rf
                th += L / steps / rr
                pts.append(ring(th, rf, along * (1 - 0.05 * k)))
                radii.append(rf * (1.0 - 0.06 * k - 0.02 * j / steps))
        tube_into(bm, pts, radii)
    # Palm and back of the hand: a slab over the up side, reaching down the -V side to the heel.
    ellipsoid_into(bm, c + U * (r_up + 0.014) - V * 0.006, (a, V, U), (0.046, 0.036, 0.016))
    ellipsoid_into(bm, c + U * (r_up * 0.55 + 0.01) - V * (r_side + 0.016), (a, V, U), (0.042, 0.016, 0.026))
    # Thumb: from the heel on the index side, round the -V side and under.
    th0 = math.radians(-40)
    tp = [c + a * 0.036 + U * (r_up + 0.012) - V * (r_side * 0.4)]
    for k in range(7):
        th = th0 - math.radians(22) * k
        tp.append(ring(th, 0.0105, 0.038 - 0.002 * k))
    tube_into(bm, tp, [0.0125, 0.0122, 0.0118, 0.0112, 0.0106, 0.0101, 0.0097, 0.0094])
    # Wrist and gauntlet cuff, then up the forearm.
    arm = Vector(arm).normalized()
    heel = c + U * (r_up * 0.6 + 0.014) - V * (r_side + 0.022)
    wrist = heel + arm * 0.035
    tube_into(bm, [heel, wrist, wrist + arm * 0.045, wrist + arm * 0.09], [0.028, 0.029, 0.036, 0.04], seg=16)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = new_obj(name, me)
    rm = obj.modifiers.new("remesh", "REMESH")
    rm.mode = "VOXEL"
    rm.voxel_size = 0.0016 if QUICK else 0.0011
    sm = obj.modifiers.new("smooth", "SMOOTH")
    sm.factor = 0.6
    sm.iterations = 6
    dec = obj.modifiers.new("dec", "DECIMATE")
    dec.ratio = 1.0
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    for m in ("remesh", "smooth"):
        bpy.ops.object.modifier_apply(modifier=m)
    dec.ratio = min(1.0, 2600 / max(1, len(obj.data.polygons) * 2))
    bpy.ops.object.modifier_apply(modifier="dec")
    obj.data.shade_smooth()
    return obj, wrist, arm


def sleeve(name, wrist, arm, length=0.5):
    """A flannel sleeve pushed up over the gauntlet, out along the forearm (the view never sees its far end)."""
    q = Vector((0, 0, 1)).rotation_difference(arm)
    bm = bmesh.new()
    seg = 18
    rings = [(0.062, 0.041), (0.075, 0.0475), (0.095, 0.05), (0.12, 0.048), (0.16, 0.047), (0.3, 0.052), (length, 0.058)]
    prev = None
    for (d, r) in rings:
        ring_ = []
        for i in range(seg + 1):
            ang = 2 * math.pi * i / seg
            wob = 1 + 0.05 * math.sin(3 * ang + d * 40) * (1 if d < 0.13 else 0.4)
            ring_.append(bm.verts.new(wrist + q @ Vector((r * wob * math.cos(ang), r * wob * math.sin(ang), d))))
        if prev:
            for i in range(seg):
                bm.faces.new((prev[i], prev[i + 1], ring_[i + 1], ring_[i]))
        prev = ring_
    bm.faces.new(prev[:-1])
    uvl = bm.loops.layers.uv.new("UV")
    qi = q.inverted()
    for f in bm.faces:
        for lp in f.loops:
            co = qi @ (lp.vert.co - wrist)
            lp[uvl].uv = ((math.atan2(co.y, co.x) / (2 * math.pi)) % 1.0, co.z * 4)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    return new_obj(name, me)


GLOVE = material("glove", color=(0.075, 0.05, 0.032), rough=0.68)
SLEEVE = material("sleeve", color=(0.16, 0.025, 0.018), rough=0.95)
HANDS = {
    # Right: over the rear handle, index finger on the trigger, the forearm back and up towards the right shoulder.
    "R": dict(centre=(0.004, -0.232, 0.141), axis=(0, 0.95, 0.31), up=(0, 0, 1), left=False, r_up=0.015, r_side=0.012, arm=(-0.25, -0.8, 0.55)),
    # Left: over the wrap handle's top bar, thumb hooked under, the forearm back and down towards the elbow at the hip, so
    # it leaves the bottom of the view instead of reaching across it to the left edge.
    "L": dict(centre=(-0.066, 0.045, 0.277), axis=(1, -0.12, 0), up=(0, -0.35, 1), left=True, r_up=0.012, r_side=0.012, arm=(-0.4, -0.75, -0.5)),
}
SLEEVE_LEN = {"R": 0.5, "L": 0.34}
hands_info = {}
gloves = {}
for side, args in HANDS.items():
    glove, wrist, arm = fist(f"LOD0_glove{side}", **args)
    glove.data.materials.append(GLOVE)
    gloves[side] = glove
    sl = sleeve(f"LOD0_sleeve{side}", wrist, arm, SLEEVE_LEN[side])
    sl.data.materials.append(SLEEVE)
    hands_info[side] = {"centre": list(args["centre"]), "axis": list(Vector(args["axis"]).normalized()), "up": list(args["up"]), "wrist": list(wrist)}

# Glove and grip UVs (the gloves' leather is baked onto them; the grip's shading is procedural from position).
for o in [o for o in bpy.data.objects if o.type == "MESH" and not o.data.uv_layers]:
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.01)
    bpy.ops.object.mode_set(mode="OBJECT")

# --- Glove leather: worn tan work gloves baked onto the gloves' UVs and packed under the bar in its three maps (the view
# binds no more textures). Creases across the fingers where the fist closes, grime in the crevices and the creases, oil-dark
# smoother palms with a slight sheen, knuckles rubbed pale, a few dried flecks. -----------------------------------------------
GS = BW * 3 // 8
AH = BH + GS


def self_bake(obj, kind, build=None):
    """Bakes obj onto its own UVs (EMIT of build's socket, or AO)."""
    img = float_image(f"bake-{obj.name}-{kind}-{len(bpy.data.images)}", GS)
    m = emission_material("self-bake", build) if build else bpy.data.materials.new("self-bake")
    m.use_nodes = True
    t = m.node_tree.nodes.new("ShaderNodeTexImage")
    t.image = img
    m.node_tree.nodes.active = t
    saved = list(obj.data.materials)
    obj.data.materials.clear()
    obj.data.materials.append(m)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    b = scene.render.bake
    b.use_selected_to_active = False
    b.margin = 6
    bpy.ops.object.bake(type=kind)
    obj.data.materials.clear()
    for sm in saved:
        obj.data.materials.append(sm)
    return np.asarray(img.pixels[:], dtype=np.float32).reshape(GS, GS, 4)


def leather(side, glove):
    h = HANDS[side]
    pos = self_bake(glove, "EMIT", lambda n, l: geom(n, "Position"))
    ok = pos[..., 3] > 0.5
    Pg = pos[..., :3]
    Ng = self_bake(glove, "EMIT", lambda n, l: geom(n, "Normal"))[..., :3]
    Ng = Ng / np.maximum(np.linalg.norm(Ng, axis=-1, keepdims=True), 1e-6)
    scene.cycles.samples = AO_SAMPLES
    ao = self_bake(glove, "AO")[..., 0]
    scene.cycles.samples = 1
    a = np.array(Vector(h["axis"]).normalized())
    U = Vector(h["up"])
    U = np.array((U - Vector(a) * U.dot(Vector(a))).normalized())
    V = np.cross(U, a) if h["left"] else np.cross(a, U)
    rel = Pg - np.array(h["centre"])
    along = rel @ a
    ru, rv = rel @ U, rel @ V
    theta = np.arctan2(rv, ru)
    radial = np.sqrt(ru * ru + rv * rv)
    seed = 80 if side == "L" else 90
    # Creases run along the handle across each curled finger: fine lines bunched at the joints, warped so none is straight.
    warp = 0.9 * vnoise3(Pg, 120.0, seed) + 0.4 * vnoise3(Pg, 300.0, seed + 1)
    lines = 1 - np.abs(2 * np.mod(theta / 0.17 + warp, 1.0) - 1)
    joint = smooth(0.45, 0.75, vnoise3(Pg, 45.0, seed + 2))
    fingers = smooth(0.04, 0.03, radial) * smooth(-0.045, -0.03, along) * smooth(0.05, 0.035, along)
    crease = smooth(0.84, 0.98, lines) * joint * fingers
    # The gauntlet: a darker, stiffer split-leather cuff from the wrist, its hem stitched.
    armd = np.array(Vector(h["arm"]).normalized())
    da = (Pg - np.array(hands_info[side]["wrist"])) @ armd
    cuff = smooth(-0.003, 0.002, da)
    e1 = np.cross(armd, (0, 0, 1) if abs(armd[2]) < 0.9 else (1, 0, 0))
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(armd, e1)
    ring = np.arctan2(rel @ e2, rel @ e1)
    stitch = smooth(0.0011, 0.0004, np.abs(da + 0.001)) * smooth(0.35, 0.6, np.abs(np.mod(ring * 40, 2.0) - 1.0))
    seam = smooth(0.0008, 0.0002, np.abs(da + 0.001))
    grain = fbm3(Pg, 700.0, seed + 4, 2)
    pebble = vnoise3(Pg, 2200.0, seed + 10)
    tone = fbm3(Pg, 18.0, seed + 5, 3)
    # Palms: the side facing the handle, oil-dark and worn smooth.
    palm = smooth(0.1, 0.6, -np.einsum("ijk,ijk->ij", Ng, rel / np.maximum(np.linalg.norm(rel, axis=-1, keepdims=True), 1e-6))) * smooth(0.06, 0.03, radial)
    cav = smooth(0.985, 0.7, ao)
    rub = smooth(0.99, 1.0, ao) * smooth(0.55, 0.8, fbm3(Pg, 60.0, seed + 6, 3)) * (1 - palm)
    col = mix(np.array((0.1, 0.06, 0.032), np.float32), np.array((0.19, 0.115, 0.058), np.float32), smooth(0.3, 0.7, tone))
    col = mix(col, np.array((0.07, 0.05, 0.035), np.float32) * (0.85 + 0.3 * tone)[..., None], cuff)
    col = col * (0.82 + 0.22 * grain + 0.1 * pebble)[..., None]
    # Sweat and oil soaked in in blotches; knuckles rubbed pale and dry.
    soak = smooth(0.5, 0.75, fbm3(Pg, 35.0, seed + 7, 3))
    col = col * (1 - 0.4 * np.maximum(soak, palm))[..., None]
    col = mix(col, np.array((0.36, 0.25, 0.15), np.float32), rub * 0.4)
    dirt = smooth(0.5, 0.8, fbm3(Pg, 50.0, seed + 3, 3))
    grime = np.clip(cav * 0.9 + crease * 0.7 + palm * 0.3 + dirt * 0.45, 0, 1)
    col = mix(col, np.array((0.035, 0.022, 0.012), np.float32), grime * 0.8)
    fleck = smooth(0.84, 0.9, fbm3(Pg, 400.0, seed + 8, 2)) * smooth(0.55, 0.7, fbm3(Pg, 20.0, seed + 9, 2)) * (1 - palm)
    col = mix(col, np.array((0.05, 0.005, 0.003), np.float32), fleck * 0.8)
    col = mix(col, np.array((0.02, 0.014, 0.01), np.float32), seam * 0.8)
    col = mix(col, np.array((0.3, 0.26, 0.2), np.float32), stitch * 0.7)
    rough = np.clip(0.7 + 0.12 * cuff + 0.12 * crease - 0.2 * np.maximum(soak, palm) - 0.1 * rub - 0.06 * grain - 0.15 * fleck, 0.3, 0.9)
    height = 0.25 * grain + 0.15 * pebble - 0.6 * crease - 0.8 * seam + 0.4 * stitch
    col = pushpull(col, ok)
    orm = pushpull(np.stack([np.clip(0.35 + 0.65 * ao, 0, 1), rough, np.zeros_like(rough)], axis=2), ok)
    height = pushpull(height[..., None], ok)[..., 0]
    gy, gx = np.gradient(height)
    n = np.stack([-gx * 1.5, -gy * 1.5, np.ones_like(gx)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return col, orm, n


col_a = np.zeros((AH, BW, 3), np.float32) + np.array((0.2, 0.12, 0.06), np.float32)
orm_a = np.zeros((AH, BW, 3), np.float32) + np.array((1, 0.7, 0), np.float32)
nrm_a = np.zeros((AH, BW, 3), np.float32) + np.array((0, 0, 1), np.float32)
col_a[:BH], orm_a[:BH], nrm_a[:BH] = bar_maps
for side, x0 in (("L", 0), ("R", GS)):
    gc, go, gn = leather(side, gloves[side])
    col_a[BH:, x0:x0 + GS], orm_a[BH:, x0:x0 + GS], nrm_a[BH:, x0:x0 + GS] = gc, go, gn
    uv = gloves[side].data.uv_layers.active.data
    for lu in uv:
        lu.uv = ((x0 + lu.uv[0] * GS) / BW, (BH + lu.uv[1] * GS) / AH)
for lu in bar_me.uv_layers["UV"].data:
    lu.uv = (lu.uv[0], lu.uv[1] * BH / AH)
bar_imgs = (save("bar-base", col_a, True), save("bar-orm", orm_a, False), save("bar-normal", nrm_a * 0.5 + 0.5, False))
bar_me.materials.append(material("bar", *bar_imgs))
glove_mat = material("glove", *bar_imgs)
for g in gloves.values():
    g.data.materials[0] = glove_mat

# --- LOD1: housing with a low bar and chain, one vertex-coloured mesh. ----------------------------------------------------
bm = bmesh.new()
bm.from_mesh(lod1.data)
col_l = bm.verts.layers.float_color.get("Col")
bar_lo = []
for k in range(16):
    s = k / 16 * LOOP
    (py, pz), _, _ = path(s, -0.004)
    if py >= 0.105:
        bar_lo.append((py, pz))
for x, c in ((BAR_X + 0.0035, (0.07, 0.07, 0.072)), (BAR_X - 0.0035, (0.07, 0.07, 0.072)), (BAR_X + 0.0025, (0.42, 0.42, 0.43)), (BAR_X - 0.0025, (0.42, 0.42, 0.43))):
    inset = 0.0 if c[0] < 0.1 else 0.006
    pts = []
    for k in range(24):
        s = k / 24 * LOOP
        (py, pz), _, _ = path(s, inset)
        if py >= 0.105:
            pts.append((py, pz))
    vs = [bm.verts.new((x, py, pz)) for py, pz in pts]
    for v in vs:
        v[col_l] = (*c, 1)
    f = bm.faces.new(vs if x > BAR_X else list(reversed(vs)))
bmesh.ops.triangulate(bm, faces=bm.faces[:])
bm.to_mesh(lod1.data)
bm.free()
lod1.name = "LOD1_saw"
lod1.data.materials.append(material("saw-lod1", color=(1, 1, 1), rough=0.6))
_m1 = lod1.data.materials[0]
_vn = _m1.node_tree.nodes.new("ShaderNodeVertexColor")
_vn.layer_name = "Col"
_m1.node_tree.links.new(_vn.outputs["Color"], _m1.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
lod1.data.color_attributes.active_color_name = "Col"
lod1.data.color_attributes.render_color_index = lod1.data.color_attributes.find("Col")
lod1.data.uv_layers.clear() if hasattr(lod1.data.uv_layers, "clear") else None

# --- Landmarks (glTF coordinates: (x, z, -y)). ----------------------------------------------------------------------------


def gl(v):
    v = Vector(v)
    return [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]


stats = {}
for o in bpy.data.objects:
    if o.type == "MESH":
        o.data.calc_loop_triangles()
        stats[o.name] = len(o.data.loop_triangles)
info = {
    "tris": stats,
    "lod0": sum(v for k, v in stats.items() if k.startswith("LOD0")),
    "lod1": sum(v for k, v in stats.items() if k.startswith("LOD1")),
    "chain": {"x": BAR_X, "z": BAR_Z, "rear": [REAR[0], REAR[1]], "nose": [NOSE[0], NOSE[1]], "loop": round(LOOP, 5), "links": DRIVE_LINKS},
    "nose": gl((BAR_X, NOSE[0] + NOSE[1], BAR_Z)),
    "barUnder": gl((BAR_X, 0.4, BAR_Z - 0.03)),
    "muffler": gl((0.092, 0.135, 0.188)),
    "grip": gl(GRIP),
    "cordExit": gl(CORD_EXIT),
    "handL": gl(hands_info["L"]["centre"]),
    "handR": gl(hands_info["R"]["centre"]),
    "rearGrip": gl((0.005, -0.25, 0.14)),
}

if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 16
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.05, 0.055, 0.06, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    scene.view_settings.view_transform = "AgX"
    for nm, rot, energy in (("key", (0.9, 0.2, 0.6), 3.5), ("rim", (-1.0, 0.0, 3.6), 2.0)):
        L = bpy.data.objects.new(nm, bpy.data.lights.new(nm, "SUN"))
        L.data.energy = energy
        L.data.angle = 0.2
        L.rotation_euler = rot
        scene.collection.objects.link(L)
    scene.render.resolution_x, scene.render.resolution_y = 1400, 900
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    for o in bpy.data.objects:
        if o.name.startswith("LOD1"):
            o.hide_render = True
    for name, at, to, lens in (("fp", (0.22, -0.62, 0.62), (0.0, 0.15, 0.1), 32), ("left", (-0.9, 0.12, 0.35), (0, 0.12, 0.12), 40),
                               ("right", (0.9, 0.12, 0.35), (0, 0.12, 0.12), 40), ("close", (0.35, -0.05, 0.42), (0.0, 0.05, 0.15), 40),
                               ("nose", (0.25, 0.45, 0.2), (BAR_X, 0.55, BAR_Z), 50),
                               ("chain", (0.16, 0.30, 0.24), (BAR_X, 0.36, BAR_Z + 0.03), 70), ("gloveR", (0.25, -0.42, 0.3), (0.0, -0.23, 0.14), 55),
                               ("gloveL", (-0.05, -0.22, 0.42), (-0.06, 0.04, 0.27), 55)):
        cam.location = at
        cam.data.lens = lens
        cam.data.clip_start = 0.01
        cam.rotation_euler = (Vector(to) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, name + ".png")
        bpy.ops.render.render(write_still=True)
    for o in bpy.data.objects:
        o.hide_render = o.name.startswith("LOD0")
    cam.location, cam.data.lens = (0.7, -0.5, 0.5), 40
    cam.rotation_euler = (Vector((0, 0.15, 0.1)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    vm = bpy.data.materials.new("vcol")
    vm.use_nodes = True
    vn = vm.node_tree.nodes.new("ShaderNodeVertexColor")
    vn.layer_name = "Col"
    vm.node_tree.links.new(vn.outputs["Color"], vm.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
    lod1_mats = list(lod1.data.materials)
    lod1.data.materials.clear()
    lod1.data.materials.append(vm)
    scene.render.filepath = os.path.join(PREVIEW, "lod1.png")
    bpy.ops.render.render(write_still=True)
    lod1.data.materials.clear()
    for m in lod1_mats:
        lod1.data.materials.append(m)
    for o in bpy.data.objects:
        o.hide_render = False

for o in bpy.data.objects:
    if o.type == "MESH":
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        bm.to_mesh(o.data)
        bm.free()
bpy.ops.object.select_all(action="DESELECT")
for o in bpy.data.objects:
    if o.type == "MESH":
        o.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", use_selection=True, export_skins=False, export_animations=False,
    export_morph=False, export_yup=True, export_image_format="WEBP", export_image_quality=88, export_apply=False,
    export_tangents=False, export_extras=False, export_vertex_color="MATERIAL", export_all_vertex_colors=False,
)
print("SAW " + json.dumps(info))
