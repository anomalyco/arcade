"""Builds one person GLB for @arcade/kit/people from a cast entry (scripts/people/cast.json). Headless Blender 5.2 + MPFB 2:

  blender -b --factory-startup --python scripts/people/build-person.py -- <spec.json> <id> <assets-dir> <out.glb>

Body: MakeHuman base mesh shaped by macro targets, skinned to MPFB's 53-bone `game_engine` skeleton (UE-style names).
Outfit: CC0 MakeHuman system clothes fitted to that body, split into named pieces (jacket, shirt, trousers, boots) whose
textures are stored as AO-baked luminance so the runtime tints each piece per person (`baseColorFactor` is the default).
Procedural pieces (beanie) are built here and weighted to one bone. Hidden skin under clothes is deleted.

Two levels of detail share the skeleton: `LOD0.*` (full) and `LOD1.*` (decimated) mesh nodes. Material names carry the
shading kind the runtime reads: `skin`, `cloth.<piece>`, `nylon.<piece>`, `hair`, `brow`, `eye`, `knit.<piece>`.
"""

import json
import math
import os
import sys

import addon_utils
import bmesh
import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
SPEC_FILE, PERSON_ID, ASSETS, OUT = argv[0], argv[1], argv[2], argv[3]
cast = json.load(open(SPEC_FILE))
spec = next(p for p in cast["people"] if p["id"] == PERSON_ID)
outfit = cast["outfits"][spec["outfit"]]

addon_utils.enable("bl_ext.user_default.mpfb", default_set=True)
from bl_ext.user_default.mpfb.services.humanservice import HumanService  # noqa: E402

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)

# --- body and skeleton ---------------------------------------------------------------------------------------------
macro = {"gender": 0.5, "age": 0.5, "muscle": 0.5, "weight": 0.5, "proportions": 0.5, "height": 0.5, "cupsize": 0.5,
         "firmness": 0.5, "race": {"caucasian": 0.34, "african": 0.33, "asian": 0.33}}
macro.update(spec.get("macro", {}))
body = HumanService.create_human(macro_detail_dict=macro)
rig = HumanService.add_builtin_rig(body, "game_engine")


def asset(rel):
    return os.path.join(ASSETS, rel)


def mhclo(rel):
    d = asset(rel)
    return os.path.join(d, [f for f in os.listdir(d) if f.endswith(".mhclo")][0])


pieces = {}  # name -> object
for item in outfit["clothes"]:
    pieces[item["asset"]] = HumanService.add_mhclo_asset(mhclo(item["asset"]), body, asset_type="Clothes", subdiv_levels=0, material_type="NONE")
hair = HumanService.add_mhclo_asset(mhclo(spec["hair"]["asset"]), body, asset_type="Hair", subdiv_levels=0, material_type="NONE") if spec.get("hair") else None
eyes = HumanService.add_mhclo_asset(mhclo("eyes/low-poly"), body, asset_type="Eyes", subdiv_levels=0, material_type="NONE")
brows = HumanService.add_mhclo_asset(mhclo(spec.get("brows", "eyebrows/eyebrow001")), body, asset_type="Eyebrows", subdiv_levels=0, material_type="NONE")

# Bake the clothes' delete masks and the helper mask into the body, so hidden skin is gone, not just masked.
bpy.context.view_layer.objects.active = body
for o in bpy.data.objects:
    o.select_set(o == body)
if body.data.shape_keys:
    bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
for m in list(body.modifiers):
    if m.type == "MASK":
        bpy.ops.object.modifier_move_to_index(modifier=m.name, index=0)
        bpy.ops.object.modifier_apply(modifier=m.name)
for o in bpy.data.objects:
    if o.type == "MESH":
        if o.data.shape_keys and o != body:
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
        for m in list(o.modifiers):
            if m.type == "SUBSURF":
                o.modifiers.remove(m)


# --- textures --------------------------------------------------------------------------------------------------------
def load(path, size):
    img = bpy.data.images.load(path)
    if max(img.size) > size:
        img.scale(size, size)
        img.pixels[:] = img.pixels[:]  # mark dirty so the exporter writes the scaled pixels, not the source file
        img.update()
    return img


def pixels(img):
    w, h = img.size
    return np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)


def store(img, px):
    img.pixels[:] = np.clip(px, 0, 1).ravel()
    img.update()


def lum(px):
    return px[..., 0] * 0.2126 + px[..., 1] * 0.7152 + px[..., 2] * 0.0722


def blur(a, r):
    """Separable box blur (r px), twice: a cheap Gaussian for region classification."""
    for _ in range(2):
        for axis in (0, 1):
            c = np.cumsum(np.pad(a, [(r + 1, r) if i == axis else (0, 0) for i in range(a.ndim)], mode="edge"), axis=axis)
            a = (np.take(c, range(2 * r + 1, c.shape[axis]), axis=axis) - np.take(c, range(0, c.shape[axis] - 2 * r - 1), axis=axis)) / (2 * r + 1)
    return a


def classify(px, rules):
    """Per-pixel region index from the blurred source colour. rules: list of [name, test]; first match wins."""
    rgb = blur(px[..., :3], max(2, px.shape[0] // 128))
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1e-3)
    region = np.full(px.shape[:2], len(rules) - 1, dtype=np.int32)
    env = {"r": r, "g": g, "b": b, "sat": sat, "l": lum(rgb), "np": np}
    for i in reversed(range(len(rules))):
        region = np.where(eval(rules[i][1], env), i, region)
    return region


MEAN = 0.72  # luminance textures are normalised so each region averages this; baseColorFactor = albedo / MEAN


def luminance_texture(px, region, n, ao=None, contrast=1.0):
    l = lum(px)
    if ao is not None:
        l = l * (0.35 + 0.65 * ao)
    out = np.zeros_like(l)
    for i in range(n):
        m = region == i
        if not m.any():
            continue
        lit = m & (l > 0.03)  # ignore the black background around UV islands
        rel = l / max(l[lit].mean() if lit.any() else l[m].mean(), 1e-3)
        out = np.where(m, MEAN * (1 + (np.clip(rel, 0.15, 2.2) - 1) * contrast), out)
    res = np.ones_like(px)
    res[..., 0] = res[..., 1] = res[..., 2] = out
    return res


def material(name, image=None, normal=None, rough=0.8, alpha=False):
    """Plain textured Principled material. Tints (baseColorFactor) and alpha modes are set after export from cast.json."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    if image is not None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = image
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if alpha:
            nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    if normal is not None:
        normal.colorspace_settings.name = "Non-Color"
        nt_tex = nt.nodes.new("ShaderNodeTexImage")
        nt_tex.image = normal
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(nt_tex.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = 0
    return mat


def set_material(o, mat):
    o.data.materials.clear()
    o.data.materials.append(mat)


def split_by_region(obj, region, names):
    """Separates obj into one object per region, by sampling the region map at each face's UV centroid."""
    h, w = region.shape
    uvl = obj.data.uv_layers.active.data
    face_region = []
    for poly in obj.data.polygons:
        u = sum(uvl[i].uv[0] for i in poly.loop_indices) / poly.loop_total
        v = sum(uvl[i].uv[1] for i in poly.loop_indices) / poly.loop_total
        x = min(w - 1, max(0, int(u * w)))
        y = min(h - 1, max(0, int(v * h)))  # Blender pixels are bottom-up, like UV v
        face_region.append(int(region[y, x]))
    out = {}
    for i, name in enumerate(names):
        if i not in face_region:
            continue
        dup = obj.copy()
        dup.data = obj.data.copy()
        bpy.context.collection.objects.link(dup)
        bm = bmesh.new()
        bm.from_mesh(dup.data)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if face_region[f.index] != i], context="FACES")
        bm.to_mesh(dup.data)
        bm.free()
        dup.name = name
        out[name] = dup
    bpy.data.objects.remove(obj)
    return out


def find_tex(d, suffix):
    for f in os.listdir(d):
        if f.endswith(suffix):
            return os.path.join(d, f)
    return None


# Skin: the MakeHuman diffuse is lit and saturated for its own renderer: desaturate a little and darken a touch.
skin_img = load(asset(spec["skin"]), 1024)
px = pixels(skin_img)
l = lum(px)[..., None]
px[..., :3] = (l + (px[..., :3] - l) * spec.get("skinSaturation", 0.72)) * spec.get("skinGain", 0.86)
store(skin_img, px)
skin = material("skin", skin_img, rough=0.5)
set_material(body, skin)

meshes = {}  # final name -> object, LOD0
for item in outfit["clothes"]:
    obj = pieces[item["asset"]]
    d = asset(item["asset"])
    size = item.get("size", 1024)
    src = load(find_tex(d, "_diffuse.png"), size)
    spx = pixels(src)
    ao_path = find_tex(d, "_ao.png")
    ao = lum(pixels(load(ao_path, size))) if ao_path else None
    normal_path = find_tex(d, "_normal.png")
    normal = load(normal_path, size) if normal_path and item.get("normal", True) else None
    parts = item["parts"]  # [{name, rule, albedo, kind, rough}]
    rules = [[p["name"], p.get("rule", "True")] for p in parts]
    region = classify(spx, rules) if len(parts) > 1 else np.zeros(spx.shape[:2], dtype=np.int32)
    store(src, luminance_texture(spx, region, len(parts), ao, item.get("contrast", 1.0)))
    src.name = item["asset"].split("/")[-1] + "_lum"
    split = split_by_region(obj, region, [p["name"] for p in parts]) if len(parts) > 1 else {parts[0]["name"]: obj}
    for p in parts:
        o = split.get(p["name"])
        if o is None:
            continue
        o.name = p["name"]
        kind = p.get("kind", "cloth")
        set_material(o, material(f"{kind}.{p['name']}", src, normal, rough=p.get("rough", 0.85)))
        meshes[p["name"]] = o

if hair is not None:
    d = asset(spec["hair"]["asset"])
    himg = load(find_tex(d, "_diffuse.png"), 512)
    hpx = pixels(himg)
    alpha = hpx[..., 3].copy()
    region = np.zeros(hpx.shape[:2], dtype=np.int32)
    lt = luminance_texture(hpx, region, 1, None, 1.15)
    lt[..., 3] = alpha
    store(himg, lt)
    set_material(hair, material("hair", himg, rough=0.6, alpha=True))
    meshes["hair"] = hair

eye_img = load(asset(f"eyes/materials/{spec.get('eyes', 'brown')}_eye.png"), 256)
set_material(eyes, material("eye", eye_img, rough=0.15))
meshes["eyes"] = eyes
bimg = load(find_tex(asset(spec.get("brows", "eyebrows/eyebrow001")), ".png"), 256)
bpx = pixels(bimg)
bpx[..., :3] = np.array(spec.get("browColor", spec["hair"]["albedo"] if spec.get("hair") else [0.05, 0.04, 0.03]))
store(bimg, bpx)
set_material(brows, material("brow", bimg, rough=0.7, alpha=True))
meshes["brows"] = brows


# --- procedural pieces -----------------------------------------------------------------------------------------------
def head_box():
    gi = body.vertex_groups["head"].index
    pts = [body.matrix_world @ v.co for v in body.data.vertices if any(g.group == gi and g.weight > 0.8 for g in v.groups)]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def weight_all(o, bone):
    o.parent = rig
    vg = o.vertex_groups.new(name=bone)
    vg.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
    mod = o.modifiers.new("Armature", "ARMATURE")
    mod.object = rig


def knit_texture(name, rib=48, size=256):
    """Ribbed knit: vertical ribs (u) with a fine stitch row pattern (v), luminance around MEAN, plus its normal map."""
    u = np.linspace(0, 1, size, endpoint=False)[None, :].repeat(size, 0)
    v = np.linspace(0, 1, size, endpoint=False)[:, None].repeat(size, 1)
    ribs = np.sin(u * math.pi * 2 * rib)
    stitch = np.sin(v * math.pi * 2 * rib * 1.6 + np.sign(ribs) * 1.2)
    height = 0.6 * ribs + 0.25 * stitch * (0.5 + 0.5 * np.abs(ribs))
    l = MEAN * (1 + 0.16 * height)
    img = bpy.data.images.new(name, size, size)
    px = np.ones((size, size, 4), np.float32)
    px[..., 0] = px[..., 1] = px[..., 2] = l
    store(img, px)
    dx = np.gradient(height, axis=1) * 6
    dy = np.gradient(height, axis=0) * 6
    n = np.stack([-dx, -dy, np.ones_like(dx)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    nimg = bpy.data.images.new(name + "_n", size, size)
    npx = np.ones((size, size, 4), np.float32)
    npx[..., :3] = n * 0.5 + 0.5
    store(nimg, npx)
    return img, nimg


beanie = spec.get("beanie")
if beanie:
    lo, hi = head_box()
    c = (lo + hi) / 2
    half = (hi - lo) / 2
    bm = bmesh.new()
    bm.loops.layers.uv.new("UVMap")
    bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=20, radius=1.0, calc_uvs=True)
    # Cut the lower part: the rim sits just above the brow, lower at the back, covering the tops of the ears.
    cut = beanie.get("rim", 0.12)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < cut + 0.18 * v.co.y], context="VERTS")
    mesh = bpy.data.meshes.new("beanie")
    bm.to_mesh(mesh)
    bm.free()
    o = bpy.data.objects.new("beanie", mesh)
    bpy.context.collection.objects.link(o)
    slouch = beanie.get("slouch", 0.08)
    for v in mesh.vertices:
        p = v.co
        top = max(0.0, p.z)
        v.co = Vector((c.x + p.x * half.x * 1.1, c.y + p.y * half.y * 1.08 + slouch * top * top * half.y,
                       c.z + 0.012 + p.z * half.z * (1.0 + slouch * 0.6)))
    for poly in mesh.polygons:
        poly.use_smooth = True
    # Hair inside the beanie is gone (what sticks out below the rim stays).
    if hair is not None:
        bm = bmesh.new()
        bm.from_mesh(hair.data)
        inside = []
        for v in bm.verts:
            q = hair.matrix_world @ v.co
            e = Vector(((q.x - c.x) / (half.x * 1.1), (q.y - c.y) / (half.y * 1.08), (q.z - c.z - 0.012) / (half.z * (1.0 + slouch * 0.6))))
            if e.length < 1.02 and e.z > cut + 0.18 * e.y + 0.04:
                inside.append(v)
        bmesh.ops.delete(bm, geom=inside, context="VERTS")
        bm.to_mesh(hair.data)
        bm.free()
    kimg, knorm = knit_texture("knit")
    set_material(o, material("knit.beanie", kimg, knorm, rough=0.95))
    weight_all(o, "head")
    meshes["beanie"] = o

# --- LODs and export -------------------------------------------------------------------------------------------------
lod0 = [o for o in bpy.data.objects if o.type == "MESH"]
for o in lod0:
    for m in list(o.modifiers):
        if m.type not in ("ARMATURE",):
            bpy.context.view_layer.objects.active = o
            try:
                bpy.ops.object.modifier_apply(modifier=m.name)
            except RuntimeError:
                o.modifiers.remove(m)
LOD1 = cast.get("lod1", {"body": 0.22, "default": 0.3, "hair": 0.35, "eyes": 1.0})
stats = {}
for o in list(lod0):
    base = "body" if o == body else next((k for k, v in meshes.items() if v == o), o.name)
    o.name = f"LOD0.{base}"
    stats[o.name] = len(o.data.polygons)
    if base in ("brows",):
        continue
    dup = o.copy()
    dup.data = o.data.copy()
    bpy.context.collection.objects.link(dup)
    dup.name = f"LOD1.{base}"
    ratio = LOD1.get(base, LOD1["default"])
    if ratio < 1:
        dec = dup.modifiers.new("Decimate", "DECIMATE")
        dec.ratio = ratio
        dec.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = dup
        bpy.ops.object.modifier_move_to_index(modifier=dec.name, index=0)
        bpy.ops.object.modifier_apply(modifier=dec.name)
    stats[dup.name] = len(dup.data.polygons)

bpy.ops.object.select_all(action="DESELECT")
rig.select_set(True)
for o in bpy.data.objects:
    if o.type == "MESH":
        o.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", use_selection=True, export_skins=True, export_animations=False,
    export_morph=False, export_yup=True, export_image_format="WEBP", export_image_quality=86, export_apply=False,
    export_tangents=False, export_extras=False,
)
print("PERSON", json.dumps({"id": PERSON_ID, "faces": stats}))
