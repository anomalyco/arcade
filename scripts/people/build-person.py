"""Builds one person GLB for @arcade/kit/people from a cast entry (scripts/people/cast.json). Headless Blender 5.2 + MPFB 2:

  blender -b --factory-startup --python scripts/people/build-person.py -- <spec.json> <person> <look> <assets-dir> <out.glb>

Body: MakeHuman base mesh shaped by macro targets, skinned to MPFB's 53-bone `game_engine` skeleton (UE-style names).
Outfit: CC0 MakeHuman system clothes fitted to that body, split into named pieces (jacket, shirt, trousers, boots) whose
textures are stored as AO-baked luminance so the runtime tints each piece per person (`baseColorFactor` is the default).
A person's looks (woods, survivor, office, ...) dress the same body in different outfits. Procedural pieces (beanie,
backpack and its straps, headlamp) are built here and skinned to the body. Hidden skin under clothes is deleted.

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
SPEC_FILE, PERSON_ID, LOOK, ASSETS, OUT = argv[0], argv[1], argv[2], argv[3], argv[4]
cast = json.load(open(SPEC_FILE))
person = next(p for p in cast["people"] if p["id"] == PERSON_ID)
spec = {**person, **person["looks"][LOOK]}
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
    src = bpy.data.images.load(path)
    if max(src.size) <= size:
        return src
    src.scale(size, size)
    # A generated copy: the exporter writes a file-backed image's source file, ignoring the scaled pixels.
    img = bpy.data.images.new(os.path.splitext(os.path.basename(path))[0], size, size, alpha=True)
    store(img, np.array(src.pixels[:], dtype=np.float32))
    bpy.data.images.remove(src)
    return img


def pixels(img):
    w, h = img.size
    return np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)


def store(img, px):
    img.pixels[:] = np.clip(px, 0, 1).ravel()
    img.update()
    # Packed, so a later colour-space change (normal maps) reloads these pixels instead of regenerating a blank image.
    img.pack()


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
    h, w = px.shape[:2]
    v, u = np.mgrid[0:h, 0:w]
    env = {"r": r, "g": g, "b": b, "sat": sat, "l": lum(rgb), "u": (u + 0.5) / w, "v": (v + 0.5) / h, "np": np}
    for i in reversed(range(len(rules))):
        region = np.where(eval(rules[i][1], env), i, region)
    return region


MEAN = 0.72  # luminance textures are normalised so each region averages this; baseColorFactor = albedo / MEAN


def luminance_texture(px, region, n, ao=None, contrast=(1.0,), fill=False):
    """Per region: luminance normalised to MEAN, its variation scaled by that region's contrast (0 = flat). With fill,
    unpainted (black) texels take their region's mean: cloth under a dropped piece (a pocket) is plain cloth."""
    l = lum(px)
    if ao is not None:
        l = l * (0.35 + 0.65 * ao)
    if fill:
        l = l.copy()
        for i in range(n):
            m = region == i
            lit = m & (l > 0.03)
            if lit.any():
                l[m & (l <= 0.03)] = l[lit].mean()
    out = np.zeros_like(l)
    for i in range(n):
        m = region == i
        if not m.any():
            continue
        lit = m & (l > 0.03)  # ignore the black background around UV islands
        rel = l / max(l[lit].mean() if lit.any() else l[m].mean(), 1e-3)
        out = np.where(m, MEAN * (1 + (np.clip(rel, 0.15, 2.2) - 1) * contrast[min(i, len(contrast) - 1)]), out)
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


def resample(a, shape):
    """Nearest-texel resize of a 2-D map (masks and region maps onto a normal map of another size)."""
    h, w = a.shape[:2]
    return a[(np.arange(shape[0]) * h) // shape[0]][:, (np.arange(shape[1]) * w) // shape[1]]


def erode(mask, r):
    out = mask.copy()
    for _ in range(r):
        out[1:] &= out[:-1].copy()
        out[:-1] &= out[1:].copy()
        out[:, 1:] &= out[:, :-1].copy()
        out[:, :-1] &= out[:, 1:].copy()
    return out


def uv_grid(shape):
    h, w = shape
    v, u = np.mgrid[0:h, 0:w]
    return (u + 0.5) / w, (v + 0.5) / h


def pattern_height(pat, shape):
    """Height field (0..1) of a fabric pattern over a texture of `shape`, for its luminance and normals."""
    u, v = uv_grid(shape)
    kind = pat["type"]
    if kind == "quilt":
        # Puffer baffles: horizontal channels (UV v runs up the body panels), stitched flat at each join.
        ph = (v / pat.get("period", 0.045)) % 1.0
        return np.sin(np.pi * ph) ** 0.6
    if kind == "plaid":
        per = pat.get("period", 0.05)
        su = ((u / per) % 1.0) < 0.5
        sv = ((v / per) % 1.0) < 0.5
        return np.where(su & sv, 0.0, np.where(su | sv, 0.5, 1.0))
    return np.zeros(shape)


def apply_patterns(lt, region, parts, painted, nimg):
    """Fabric patterns per part, in place: luminance on lt, relief on the normal map nimg (if any).

    quilt (puffer baffles), plaid (flannel check), seams (stitched seam lines along every panel edge, with a lighter
    tape inside: a rain shell's welded seams), marks (outlined patches in UV: a hoodie's pocket).
    """
    l = lt[..., 0].copy()
    npx = pixels(nimg) if nimg is not None else None
    nreg = resample(region, npx.shape[:2]) if npx is not None else None
    for i, p in enumerate(parts):
        m = region == i
        for pat in p.get("patterns", []):
            kind = pat["type"]
            if kind in ("quilt", "plaid"):
                hgt = pattern_height(pat, l.shape)
                if kind == "quilt":
                    ph = (uv_grid(l.shape)[1] / pat.get("period", 0.045)) % 1.0
                    f = (0.8 + 0.3 * hgt) * np.where((ph < 0.035) | (ph > 0.965), 0.72, 1.0)
                else:
                    f = np.choose((hgt * 2).astype(int), [0.38, 0.78, 1.3])
                    f = f * (1 + 0.05 * np.sin(uv_grid(l.shape)[0] * 2400 + uv_grid(l.shape)[1] * 2400))
                l = np.where(m, l * f, l)
                if npx is not None and pat.get("relief", 0) > 0:
                    nh = pattern_height(pat, npx.shape[:2])
                    dx = np.gradient(nh, axis=1) * pat["relief"] * npx.shape[1] / 256
                    dy = np.gradient(nh, axis=0) * pat["relief"] * npx.shape[0] / 256
                    n = np.stack([-dx, -dy, np.ones_like(dx)], -1)
                    n /= np.linalg.norm(n, axis=-1, keepdims=True)
                    nm = nreg == i
                    npx[..., :3] = np.where(nm[..., None], n * 0.5 + 0.5, npx[..., :3])
            elif kind == "seams":
                w = max(1, int(round(pat.get("width", 0.004) * l.shape[0])))
                e1 = erode(painted, w)
                e2 = erode(e1, w)
                l = np.where(m & painted & ~e1, l * pat.get("dark", 0.78), l)
                l = np.where(m & e1 & ~e2, l * pat.get("tape", 1.1), l)
            elif kind == "marks":
                u, v = uv_grid(l.shape)
                wd = pat.get("width", 0.004)
                for r in pat["rects"]:
                    u0, v0, u1, v1 = r
                    inside = (u > u0) & (u < u1) & (v > v0) & (v < v1)
                    core = (u > u0 + wd) & (u < u1 - wd) & (v > v0 + wd) & (v < v1 - wd)
                    l = np.where(m & inside & ~core, l * pat.get("gain", 0.75), l)
                    l = np.where(m & core, l * pat.get("fillGain", 1.0), l)
    lt[..., 0] = lt[..., 1] = lt[..., 2] = l
    if npx is not None:
        store(nimg, npx)


def soften_normals(nimg, strength, flat=None):
    """Blends a normal map toward flat (strength 0 = flat) and flattens it wholly where `flat` (a source mask) is set."""
    npx = pixels(nimg)
    n = npx[..., :3] * 2 - 1
    n = np.array([0.0, 0.0, 1.0]) + (n - np.array([0.0, 0.0, 1.0])) * strength
    if flat is not None:
        n = np.where(resample(flat, npx.shape[:2])[..., None], np.array([0.0, 0.0, 1.0]), n)
    n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6)
    npx[..., :3] = n * 0.5 + 0.5
    store(nimg, npx)


def fill_holes(o, opt):
    """Closes small openings in a garment's front (where a dropped pocket was sewn over a hole), with faces that take
    the texture at `uv` (plain cloth). Openings wider than maxPerimeter (hem, cuffs, collar) or off the torso stay."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    edges = [e for e in bm.edges if e.is_boundary]
    seen, loops = set(), []
    for e in edges:
        if e in seen:
            continue
        loop, stack = [], [e]
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            loop.append(x)
            for v in x.verts:
                stack.extend(y for y in v.link_edges if y.is_boundary and y not in seen)
        loops.append(loop)
    uvl = bm.loops.layers.uv.active
    mid = sum((o.matrix_world @ v.co for v in bm.verts), Vector()) / max(1, len(bm.verts))
    filled = 0
    for loop in loops:
        per = sum(e.calc_length() for e in loop)
        vs = {v for e in loop for v in e.verts}
        wc = [o.matrix_world @ v.co for v in vs]
        at = sum(wc, Vector()) / len(wc)
        # On the front of the torso only (MPFB faces -Y): armholes at the sides and the collar stay open.
        if per > opt.get("maxPerimeter", 0.9) or max(abs(p.x) for p in wc) > opt.get("maxX", 0.3) or mid.y - at.y < opt.get("ahead", 0.05):
            continue
        new = bmesh.ops.holes_fill(bm, edges=loop, sides=0)["faces"]
        for f in new:
            f.normal_update()
            if f.normal.y > 0:  # face out of the front (-Y), like the cloth round it
                f.normal_flip()
            f.smooth = True
            for lp in f.loops:
                lp[uvl].uv = opt.get("uv", (0.12, 0.6))
        filled += 1
    bm.normal_update()
    bm.to_mesh(o.data)
    bm.free()
    print("FILLED", o.name, filled, "of", len(loops), "openings", file=sys.stderr)


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
albedos = {}  # piece -> default albedo computed here (procedural gear, skin-toned pieces); build-people.ts reads them


def srgb_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


# A piece tinted to this person's skin (bare legs above office shoes, where the shoe's sock was): the luminance
# texture averages MEAN, so this factor renders the skin's mean colour.
_lit = px[..., :3][lum(px) > 0.05]
skin_tone = [0.85 * srgb_lin(float(c)) * MEAN / srgb_lin(MEAN) for c in _lit.mean(0)]  # legs, a touch under the face
set_material(body, skin)

meshes = {}  # final name -> object, LOD0
piece_kind = {}  # clothing piece -> shading kind
for item in outfit["clothes"]:
    obj = pieces[item["asset"]]
    d = asset(item["asset"])
    size = item.get("size", 1024)
    src = load(find_tex(d, "_diffuse.png"), size)
    spx = pixels(src)
    ao_path = find_tex(d, "_ao.png")
    ao = lum(pixels(load(ao_path, size))) if ao_path else None
    normal_path = find_tex(d, "_normal.png")
    normal = load(normal_path, item.get("normalSize", size)) if normal_path and item.get("normal", True) else None
    parts = item["parts"]  # [{name, rule, albedo, kind, rough, drop, patterns, inflate}]
    rules = [[p["name"], p.get("rule", "True")] for p in parts]
    region = classify(spx, rules) if len(parts) > 1 else np.zeros(spx.shape[:2], dtype=np.int32)
    painted = lum(spx) > 0.03
    lt = luminance_texture(spx, region, len(parts), ao, [p.get("contrast", item.get("contrast", 1.0)) for p in parts], fill=True)
    if normal is not None and (item.get("normalStrength", 1.0) != 1.0 or any(p.get("drop") for p in parts)):
        # Under a dropped piece (pockets) the cloth is flat: no relief of the piece that was sewn on there.
        soften_normals(normal, item.get("normalStrength", 1.0), ~painted if any(p.get("drop") for p in parts) else None)
    if any(p.get("patterns") for p in parts):
        if normal is None and any(pt.get("relief") for p in parts for pt in p.get("patterns", [])):
            normal = bpy.data.images.new(item["asset"].split("/")[-1] + "_n", 512, 512)
            store(normal, np.tile(np.array([0.5, 0.5, 1.0, 1.0], np.float32), (512, 512, 1)))
        apply_patterns(lt, region, parts, painted, normal)
    if normal is not None and any(p.get("flatNormal") for p in parts):
        # Bare skin where a sock was: no knit relief.
        flat = np.isin(region, [i for i, p in enumerate(parts) if p.get("flatNormal")])
        soften_normals(normal, 1.0, flat)
    store(src, lt)
    src.name = item["asset"].split("/")[-1] + "_lum"
    split = split_by_region(obj, region, [p["name"] for p in parts]) if len(parts) > 1 else {parts[0]["name"]: obj}
    for p in parts:
        o = split.get(p["name"])
        if o is None:
            continue
        if p.get("drop"):
            bpy.data.objects.remove(o)
            continue
        o.name = p["name"]
        if p.get("fillHoles"):
            fill_holes(o, p["fillHoles"])
        if p.get("inflate"):
            # Puffer loft: the piece stands off the body along its normals.
            for vtx in o.data.vertices:
                vtx.co += vtx.normal * p["inflate"]
        kind = p.get("kind", "cloth")
        set_material(o, material(f"{kind}.{p['name']}", src, normal, rough=p.get("rough", 0.85)))
        meshes[p["name"]] = o
        piece_kind[p["name"]] = kind
        if p.get("skinTone"):
            albedos[p["name"]] = skin_tone

if hair is not None and spec["hair"].get("trimFringe"):
    # A fringe that hangs over the eyes is lifted to just above the brows, so the face reads at a distance.
    ez = [eyes.matrix_world @ v.co for v in eyes.data.vertices]
    brow = max(q.z for q in ez) + 0.018
    ex = (min(q.x for q in ez), max(q.x for q in ez))
    front = min(q.y for q in ez)  # MPFB faces -Y
    for v in hair.data.vertices:
        q = hair.matrix_world @ v.co
        if q.z < brow and q.y < front + 0.05 and ex[0] - 0.03 < q.x < ex[1] + 0.03 and q.z > brow - 0.09:
            q.z = brow + (q.z - brow) * 0.15
            v.co = hair.matrix_world.inverted() @ q

if hair is not None:
    d = asset(spec["hair"]["asset"])
    himg = load(find_tex(d, "_diffuse.png"), 512)
    hpx = pixels(himg)
    alpha = hpx[..., 3].copy()
    region = np.zeros(hpx.shape[:2], dtype=np.int32)
    lt = luminance_texture(hpx, region, 1, None, (1.15,))
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
        # Every strand above the rim goes, however far it stands off the head (a bob's volume would otherwise sit round
        # the beanie like a helmet); below the rim, hair is drawn in to the beanie's radius and flares out with depth.
        scale = Vector((half.x * 1.1, half.y * 1.08, half.z * (1.0 + slouch * 0.6)))
        centre = Vector((c.x, c.y, c.z + 0.012))
        inside = []
        inv = hair.matrix_world.inverted()
        for v in bm.verts:
            q = hair.matrix_world @ v.co
            e = Vector(((q.x - centre.x) / scale.x, (q.y - centre.y) / scale.y, (q.z - centre.z) / scale.z))
            depth = cut + 0.18 * e.y + 0.03 - e.z
            if depth < 0 and e.length < 1.8:
                inside.append(v)
            elif depth < 0.3:
                h = math.hypot(e.x, e.y)
                limit = 0.97 + depth * 0.6
                if h > limit:
                    k = limit / h
                    e = Vector((e.x * k, e.y * k, e.z))
                    v.co = inv @ Vector((centre.x + e.x * scale.x, centre.y + e.y * scale.y, centre.z + e.z * scale.z))
        bmesh.ops.delete(bm, geom=inside, context="VERTS")
        bm.to_mesh(hair.data)
        bm.free()
    kimg, knorm = knit_texture("knit")
    set_material(o, material("knit.beanie", kimg, knorm, rough=0.95))
    weight_all(o, "head")
    meshes["beanie"] = o


# --- carried gear: backpack and straps, headlamp ---------------------------------------------------------------------
from mathutils import kdtree  # noqa: E402

bone_w = {b.name: rig.matrix_world @ b.head_local for b in rig.data.bones}
fwd = bone_w["ball_l"] - bone_w["foot_l"]
fwd.z = 0
fwd.normalize()  # the way the person faces (MPFB: -Y)
side = Vector((1, 0, 0))
up = Vector((0, 0, 1))
neck_z = bone_w["neck_01"].z


def surface_points(objs):
    return [o.matrix_world @ v.co for o in objs for v in o.data.vertices]


def weave_texture(name, size=256, cells=64):
    """Ripstop nylon: a fine weave with a heavier grid every few cells; luminance around MEAN, plus its normal map."""
    u = np.linspace(0, 1, size, endpoint=False)[None, :].repeat(size, 0)
    v = np.linspace(0, 1, size, endpoint=False)[:, None].repeat(size, 1)
    weave = 0.5 * np.sin(u * math.pi * 2 * cells) * np.sin(v * math.pi * 2 * cells)
    grid = np.maximum(np.cos(u * math.pi * 2 * cells / 5) ** 40, np.cos(v * math.pi * 2 * cells / 5) ** 40)
    height = 0.5 * weave + 0.25 * grid
    img = bpy.data.images.new(name, size, size)
    px = np.ones((size, size, 4), np.float32)
    px[..., 0] = px[..., 1] = px[..., 2] = MEAN * (1 + 0.06 * (height - height.mean()))
    store(img, px)
    dx, dy = np.gradient(height, axis=1) * 2.5, np.gradient(height, axis=0) * 2.5
    n = np.stack([-dx, -dy, np.ones_like(dx)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    nimg = bpy.data.images.new(name + "_n", size, size)
    npx = np.ones((size, size, 4), np.float32)
    npx[..., :3] = n * 0.5 + 0.5
    store(nimg, npx)
    return img, nimg


def box_uvs(bm, scale):
    """Tiled box projection (the sampler repeats), for procedural gear."""
    layer = bm.loops.layers.uv.get("UVMap") or bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        n = f.normal
        a = max(range(3), key=lambda i: abs(n[i]))
        i, j = [k for k in range(3) if k != a]
        for loop in f.loops:
            loop[layer].uv = (loop.vert.co[i] * scale, loop.vert.co[j] * scale)


def mesh_object(name, bm):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    o = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(o)
    for poly in mesh.polygons:
        poly.use_smooth = True
    return o


def skin_like_body(o):
    """Copies each vertex's bone weights from the nearest body vertex, so straps and bands follow the body."""
    o.parent = rig
    bverts = body.data.vertices
    tree = kdtree.KDTree(len(bverts))
    for i, v in enumerate(bverts):
        tree.insert(body.matrix_world @ v.co, i)
    tree.balance()
    names = {g.index: g.name for g in body.vertex_groups}
    groups = {}
    for v in o.data.vertices:
        _, bi, _ = tree.find(o.matrix_world @ v.co)
        for g in bverts[bi].groups:
            if g.weight <= 0.0:
                continue
            name = names[g.group]
            if name not in groups:
                groups[name] = o.vertex_groups.new(name=name)
            groups[name].add([v.index], g.weight, "REPLACE")
    mod = o.modifiers.new("Armature", "ARMATURE")
    mod.object = rig


def solidify(o, t):
    mod = o.modifiers.new("Solidify", "SOLIDIFY")
    mod.thickness = t
    mod.offset = 1.0
    mod.use_even_offset = True
    # Ahead of the armature modifier, so it is applied with the others before export.
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_move_to_index(modifier=mod.name, index=0)


def outer_radius(pts, centre, dirs, axis_a, axis_b, keep, window=0.05):
    """Per direction (in the plane of axis_a, axis_b about centre), the farthest point of pts within `window` rad."""
    out = []
    for d in dirs:
        best = 0.0
        for p in pts:
            q = p - centre
            if not keep(p):
                continue
            a, b = q.dot(axis_a), q.dot(axis_b)
            r = math.hypot(a, b)
            if r < 1e-4:
                continue
            ang = math.atan2(b, a) - d
            ang = (ang + math.pi) % (2 * math.pi) - math.pi
            if abs(ang) < window and r > best:
                best = r
        out.append(best)
    return out



def skin_from(o, sources, anchors, k=14):
    """Bone weights per vertex: the inverse-distance mean of the k source vertices (body and clothes) nearest its
    anchor on the body, so a piece lying on the back bends with it and cannot sink through it."""
    o.parent = rig
    pool, tree_pts = [], []
    for src in sources:
        names = {g.index: g.name for g in src.vertex_groups}
        for v in src.data.vertices:
            ws = {names[g.group]: g.weight for g in v.groups if g.weight > 0 and g.group in names}
            if ws:
                pool.append(ws)
                tree_pts.append(src.matrix_world @ v.co)
    tree = kdtree.KDTree(len(tree_pts))
    for i, q in enumerate(tree_pts):
        tree.insert(q, i)
    tree.balance()
    groups = {}
    for v, at in zip(o.data.vertices, anchors):
        acc = {}
        for _, i, d in tree.find_n(at, k):
            w = 1.0 / (d + 0.01)
            for n, x in pool[i].items():
                acc[n] = acc.get(n, 0.0) + x * w
        top = sorted(acc.items(), key=lambda kv: -kv[1])[:4]
        tot = sum(x for _, x in top) or 1.0
        for n, x in top:
            if n not in groups:
                groups[n] = o.vertex_groups.new(name=n)
            groups[n].add([v.index], x / tot, "REPLACE")
    mod = o.modifiers.new("Armature", "ARMATURE")
    mod.object = rig


def pack_texture(size=512):
    """The daypack's luminance and relief, in its own UV layout: front panel (u < 0.5) with a zipped lid arc and a
    zipped front pocket; padded back panel (0.5..0.74); the rim (u > 0.76, v round the outline) with the main zip
    and two compression straps down each side. Ripstop weave throughout."""
    u, v = uv_grid((size, size))
    cells = 96
    weave = 0.5 * np.sin(u * math.pi * 2 * cells) * np.sin(v * math.pi * 2 * cells)
    grid = np.maximum(np.cos(u * math.pi * 2 * cells / 5) ** 40, np.cos(v * math.pi * 2 * cells / 5) ** 40)
    hgt = 0.5 * weave + 0.25 * grid
    lgain = np.ones((size, size))
    groove = np.zeros((size, size))
    # Front panel: local (fu -1..1 across, fv 0 top .. 1 bottom).
    fu, fv = (u - 0.02) / 0.46 * 2 - 1, 1 - (v - 0.02) / 0.96
    front = (u < 0.5)
    lid = np.abs((np.abs(fu) / 0.82) ** 4 + ((fv - 0.6) / 0.5) ** 4 - 1) < 0.06
    lid &= front & (fv < 0.6)
    pocket = front & (np.abs(fu) < 0.66) & (fv > 0.56) & (fv < 0.93)
    pocket_edge = pocket & ~((np.abs(fu) < 0.63) & (fv > 0.585) & (fv < 0.91))
    pocket_zip = front & (np.abs(fu) < 0.6) & (np.abs(fv - 0.62) < 0.008)
    for m, g in ((lid, 0.45), (pocket_edge, 0.62), (pocket_zip, 0.45)):
        lgain = np.where(m, g, lgain)
        groove = np.where(m, 1.0, groove)
    lgain = np.where(pocket & ~pocket_edge, lgain * 0.92, lgain)
    # Back panel: padded mesh, darker, in vertical channels.
    backp = (u >= 0.5) & (u < 0.75)
    chan = np.cos((u - 0.5) / 0.25 * math.pi * 6) ** 8
    lgain = np.where(backp, 0.62 + 0.1 * chan, lgain)
    hgt = np.where(backp, chan, hgt)
    # Rim: t across the wall (0 back .. 1 front), s round the outline (0 top-left, clockwise).
    rim = u >= 0.76
    t, sp = (u - 0.76) / 0.22, v
    zip_line = rim & (np.abs(t - 0.55) < 0.03) & ((sp < 0.42) | (sp > 0.93))
    straps = rim & (np.minimum.reduce([np.abs(sp - c) for c in (0.33, 0.43, 0.82, 0.92)]) < 0.012)
    for m, g in ((zip_line, 0.42), (straps, 0.4)):
        lgain = np.where(m, g, lgain)
        groove = np.where(m, 1.0, groove)
    hgt = hgt - 0.8 * groove + 0.6 * straps
    img = bpy.data.images.new("pack", size, size)
    px = np.ones((size, size, 4), np.float32)
    px[..., 0] = px[..., 1] = px[..., 2] = MEAN * lgain * (1 + 0.06 * (hgt - hgt.mean()))
    store(img, px)
    dx, dy = np.gradient(hgt, axis=1) * 2.5, np.gradient(hgt, axis=0) * 2.5
    n = np.stack([-dx, -dy, np.ones_like(dx)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    nimg = bpy.data.images.new("pack_n", size, size)
    npx = np.ones((size, size, 4), np.float32)
    npx[..., :3] = n * 0.5 + 0.5
    store(nimg, npx)
    return img, nimg


def daypack(pts, W, H, D, z_top, away):
    """A daypack W wide, H tall and D deep whose back panel follows the wearer's back (sampled from the clothes, a
    little flattened across, so it rests on the shoulder blades and lower back), narrower at the top and fuller at
    the bottom, with rounded walls and a mesh pocket bulging on each side. Returns the object and, per vertex, its
    anchor on the back (for skin_from)."""
    NX, NZ, RINGS = 13, 17, 6
    zone = [p for p in pts if abs(p.x) < W / 2 + 0.04 and z_top - H - 0.04 < p.z < z_top + 0.04]
    mid = (max(p.dot(away) for p in zone) + min(p.dot(away) for p in zone)) / 2
    zone = [p for p in zone if p.dot(away) > mid]

    def rounded(a, b, r=0.32):
        # Grid square (a, b in -1..1) onto a rectangle with round corners.
        ca, cb = abs(a) - (1 - r), abs(b) - (1 - r)
        if ca > 0 and cb > 0:
            d = math.hypot(ca, cb) / r
            if d > 1:
                ca, cb = ca / d, cb / d
            a = math.copysign(1 - r + ca, a)
            b = math.copysign(1 - r + cb, b)
        return a, b

    grid = []
    for j in range(NZ):
        row = []
        for i in range(NX):
            a, b = rounded(i / (NX - 1) * 2 - 1, j / (NZ - 1) * 2 - 1)
            vv = (b + 1) / 2  # 0 top .. 1 bottom
            x = a * W / 2 * (0.84 + 0.16 * vv)
            z = z_top - vv * H
            row.append((a, vv, x, z))
        grid.append(row)

    raw = [[None] * NX for _ in range(NZ)]
    for j in range(NZ):
        for i in range(NX):
            _, _, x, z = grid[j][i]
            near = [p.dot(away) for p in zone if abs(p.x - x) < 0.03 and abs(p.z - z) < 0.03]
            raw[j][i] = max(near) if near else None
    known = [x for r in raw for x in r if x is not None]
    fallback = max(known) if known else mid + 0.1
    for j in range(NZ):
        for i in range(NX):
            if raw[j][i] is None:
                nb = [raw[jj][ii] for jj in range(max(0, j - 2), min(NZ, j + 3)) for ii in range(max(0, i - 2), min(NX, i + 3)) if raw[jj][ii] is not None]
                raw[j][i] = max(nb) if nb else fallback
    panel = [r[:] for r in raw]
    for _ in range(2):
        panel = [[sum(panel[jj][ii] for jj in range(max(0, j - 1), min(NZ, j + 2)) for ii in range(max(0, i - 1), min(NX, i + 2)))
                  / len([1 for jj in range(max(0, j - 1), min(NZ, j + 2)) for ii in range(max(0, i - 1), min(NX, i + 2))]) for i in range(NX)] for j in range(NZ)]
    for j in range(NZ):
        rowmax = max(panel[j])
        for i in range(NX):
            # Flattened across (a padded panel bridges the spine), never inside the clothes.
            # The bottom stands off a little more: the hips swing under it in the walk.
            vv = grid[j][i][1]
            panel[j][i] = max(0.88 * panel[j][i] + 0.12 * rowmax, raw[j][i]) + 0.01 + 0.009 * max(0.0, (vv - 0.7) / 0.3)

    def thick(a, vv):
        across = (1 - min(1.0, abs(a)) ** 3) ** (1 / 3)
        down = (1 - min(1.0, abs(vv * 2 - 1)) ** 3) ** (1 / 3)
        return D * (0.42 + 0.58 * across * down) * (0.78 + 0.22 * vv)

    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("UVMap")
    anchors = []

    def vert(x, z, depth, anchor_depth):
        anchors.append(side * x + up * z + away * (anchor_depth - 0.01))
        return bm.verts.new(side * x + up * z + away * depth)

    front, back = [], []
    for j in range(NZ):
        fr, br = [], []
        for i in range(NX):
            a, vv, x, z = grid[j][i]
            pd = panel[j][i]
            fr.append(vert(x, z, pd + thick(a, vv), pd))
            br.append(vert(x, z, pd, pd))
        front.append(fr)
        back.append(br)

    def quad(vs, uvs):
        f = bm.faces.new(vs)
        for loop, uv in zip(f.loops, uvs):
            loop[uvl].uv = uv
        return f

    fuv = lambda i, j: (0.02 + 0.46 * i / (NX - 1), 0.98 - 0.96 * j / (NZ - 1))
    buv = lambda i, j: (0.51 + 0.23 * (NX - 1 - i) / (NX - 1), 0.98 - 0.96 * j / (NZ - 1))
    for j in range(NZ - 1):
        for i in range(NX - 1):
            quad([front[j][i], front[j + 1][i], front[j + 1][i + 1], front[j][i + 1]], [fuv(i, j), fuv(i, j + 1), fuv(i + 1, j + 1), fuv(i + 1, j)])
            quad([back[j][i], back[j][i + 1], back[j + 1][i + 1], back[j + 1][i]], [buv(i, j), buv(i + 1, j), buv(i + 1, j + 1), buv(i, j + 1)])

    # The rim: the outline, clockwise from the top-left, walled in RINGS steps from the back panel to the front.
    loop_ij = [(i, 0) for i in range(NX - 1)] + [(NX - 1, j) for j in range(NZ - 1)] + [(i, NZ - 1) for i in range(NX - 1, 0, -1)] + [(0, j) for j in range(NZ - 1, 0, -1)]
    L = len(loop_ij)
    outline = [Vector((grid[j][i][2], grid[j][i][3])) for i, j in loop_ij]
    rings = []
    for k, (i, j) in enumerate(loop_ij):
        prev, nxt = outline[k - 1], outline[(k + 1) % L]
        tng = (nxt - prev).normalized()
        nrm = Vector((tng.y, -tng.x))  # outward in (x, z) for a clockwise outline seen from behind
        if nrm.dot(outline[k] - Vector((0, z_top - H / 2))) < 0:
            nrm = -nrm
        a, vv, x, z = grid[j][i]
        pd, fd = panel[j][i], panel[j][i] + thick(a, vv)
        sp = k / L
        # Mesh side pockets: the lower half of each side wall bulges out.
        side_low = (i in (0, NX - 1)) and vv > 0.5
        col = []
        for r in range(RINGS + 1):
            t = r / RINGS
            if r == 0:
                col.append(back[j][i])
                continue
            if r == RINGS:
                col.append(front[j][i])
                continue
            bulge = 0.012 * math.sin(math.pi * t) ** 0.7 + (0.028 * math.sin(math.pi * min(1.0, t * 1.3)) * min(1.0, (vv - 0.5) * 5) if side_low else 0.0)
            q = outline[k] + nrm * bulge
            col.append(vert(q.x, q.y, pd + (fd - pd) * t, pd))
        rings.append((col, sp))
    for k in range(L):
        (ca, sa), (cb, sb) = rings[k], rings[(k + 1) % L]
        if k == L - 1:
            sb = 1.0
        for r in range(RINGS):
            t0, t1 = r / RINGS, (r + 1) / RINGS
            quad([ca[r], cb[r], cb[r + 1], ca[r + 1]], [(0.76 + 0.22 * t0, sa), (0.76 + 0.22 * t0, sb), (0.76 + 0.22 * t1, sb), (0.76 + 0.22 * t1, sa)])
    bm.verts.index_update()
    bm.normal_update()
    # Faces point out of the pack (away from its middle).
    centre = sum((v.co for v in bm.verts), Vector()) / len(bm.verts)
    for f in bm.faces:
        if f.normal.dot(f.calc_center_median() - centre) < 0:
            f.normal_flip()
    bm.normal_update()
    order = [v.index for v in bm.verts]
    o = mesh_object("backpack", bm)
    img, nimg = pack_texture()
    set_material(o, material("nylon.backpack", img, nimg, rough=0.55))
    return o, [anchors[i] for i in order]

torso_objs = [body] + [o for k, o in meshes.items() if k not in ("hair", "eyes", "brows", "beanie")]
backpack = spec.get("backpack")
if backpack:
    W, H, D = backpack.get("size", [0.3, 0.45, 0.18])
    pts = surface_points(torso_objs)
    # Straight back from the body (MPFB faces -Y), not from the feet, whose toes turn out.
    away = Vector((0, 1, 0))
    z_top = neck_z - 0.07
    band = [p for p in pts if abs(p.x) < W / 2 and z_top - H < p.z < z_top]
    pack, anchors = daypack(pts, W, H, D, z_top, away)
    skin_from(pack, torso_objs, anchors)
    meshes["backpack"] = pack
    albedos["backpack"] = backpack.get("albedo", [0.08, 0.08, 0.08])
    wimg, wnorm = weave_texture("ripstop")

    # Shoulder straps: ribbons over each shoulder, from the top of the pack to the bottom of the ribs, on the clothes.
    straps = bmesh.new()
    sweep = [math.radians(a) for a in range(-55, 251, 5)]  # angle in the (−fwd, up) plane: 0 is straight back
    torso_mid = (max(p.dot(fwd) for p in band) + min(p.dot(fwd) for p in band)) / 2
    xs0 = min(0.1, W * 0.32)
    # Top of the shoulder at the strap's slice (below the neck, so not the ears).
    shoulder_top = max(p.z for p in pts if abs(abs(p.x) - xs0) < 0.02 and abs(p.dot(fwd) - torso_mid) < 0.06 and p.z < neck_z + 0.04)
    for sx in (-1, 1):
        xs = sx * xs0
        c = Vector((xs, 0, shoulder_top - 0.13)) + fwd * torso_mid
        # The torso round this slice only: not the neck, head or collar above the shoulder line.
        mid = [p for p in pts if abs(p.x - xs) < 0.018 and p.z < shoulder_top + 0.01 and (p - c).length < 0.3]
        r = outer_radius(mid, c, sweep, -fwd, up, lambda p: True)
        # Behind, the strap runs down between the back and the pack (hidden); in front it ends at the bottom of the ribs.
        path = [(c + (-fwd * math.cos(a) + up * math.sin(a)) * (ri + 0.008)) for a, ri in zip(sweep, r) if ri > 0]
        verts = []
        for p in path:
            verts.append((straps.verts.new(p - side * 0.022), straps.verts.new(p + side * 0.022)))
        for (a0, a1), (b0, b1) in zip(verts, verts[1:]):
            straps.faces.new((a0, a1, b1, b0))
    bmesh.ops.recalc_face_normals(straps, faces=list(straps.faces))
    box_uvs(straps, 8.0)
    so = mesh_object("straps", straps)
    solidify(so, 0.006)
    set_material(so, material("cloth.straps", wimg, wnorm, rough=0.8))
    skin_like_body(so)
    meshes["straps"] = so
    albedos["straps"] = [0.03, 0.03, 0.03]

hood = outfit.get("hood")
if hood:
    # A hood lying down: a soft, bunched sheet round the back of the neck, draped down the upper back (short under a
    # pack), traced over the clothes like the straps and skinned to the body. Same cloth and tint as its garment.
    on = hood.get("on", "jacket")
    pts = surface_points(torso_objs)
    ring = [p for p in pts if abs(p.z - neck_z) < 0.02]
    nc = Vector((sum(p.x for p in ring) / len(ring), sum(p.y for p in ring) / len(ring), neck_z))
    c = nc - up * 0.12
    length = hood.get("length", 0.2) if not backpack else hood.get("packLength", 0.07)
    bunch = hood.get("bunch", 0.03)
    elev = [math.radians(e) for e in range(82, -40, -3)]
    rows = []
    azimuths = list(range(-115, 116, 10))
    for az in azimuths:
        a = math.radians(az)
        d = -fwd * math.cos(a) + side * math.sin(a)
        perp = up.cross(d)
        sl = [p for p in pts if abs((p - c).dot(perp)) < 0.015 and (p - c).dot(d) > 0 and p.z < neck_z + 0.03 and (p - c).length < 0.32]
        r = outer_radius(sl, c, elev, d, up, lambda p: True, window=0.06)
        path = [c + (d * math.cos(e) + up * math.sin(e)) * ri for e, ri in zip(elev, r) if ri > 0]
        if len(path) < 3:
            rows.append(None)
            continue
        back = max(0.0, math.cos(a))
        L = length * (0.2 + 0.8 * back * back) + 0.02
        # Resample the first L metres of the path into N points, standing off by the bunched thickness.
        N = 9
        cum = [0.0]
        for p0, p1 in zip(path, path[1:]):
            cum.append(cum[-1] + (p1 - p0).length)
        row = []
        for k in range(N):
            t = k / (N - 1)
            target = min(cum[-1], t * L)
            j = max(i for i in range(len(cum)) if cum[i] <= target)
            j = min(j, len(path) - 2)
            f = (target - cum[j]) / max(cum[j + 1] - cum[j], 1e-6)
            q = path[j].lerp(path[j + 1], f)
            out = (q - c).normalized()
            th = 0.008 + bunch * (0.35 + 0.65 * back) * math.sin(math.pi * min(1.0, t * 1.15)) ** 0.7
            row.append((q + out * th, (az + 115) / 230, t))
        rows.append(row)
    hb = bmesh.new()
    uvl = hb.loops.layers.uv.new("UVMap")
    verts = [[(hb.verts.new(p), u, t) for p, u, t in row] if row else None for row in rows]
    for ra, rb in zip(verts, verts[1:]):
        if ra is None or rb is None:
            continue
        for k in range(len(ra) - 1):
            quad = [ra[k], rb[k], rb[k + 1], ra[k + 1]]
            f = hb.faces.new([q[0] for q in quad])
            for loop, q in zip(f.loops, quad):
                loop[uvl].uv = (q[1], q[2])
    bmesh.ops.recalc_face_normals(hb, faces=list(hb.faces))
    ho = mesh_object("hood", hb)
    solidify(ho, 0.005)
    # Cloth: plain, with the centre seam down the back and a hemmed rim.
    size = 128
    u, v = uv_grid((size, size))
    hl = np.full((size, size), MEAN)
    hl = np.where(np.abs(u - 0.5) < 0.008, MEAN * 0.78, hl)
    hl = np.where(v > 0.9, MEAN * 0.88, hl)
    hl = np.where((v > 0.88) & (v < 0.9), MEAN * 0.75, hl)
    himg = bpy.data.images.new("hood", size, size)
    hpx = np.ones((size, size, 4), np.float32)
    hpx[..., 0] = hpx[..., 1] = hpx[..., 2] = hl
    store(himg, hpx)
    kind = piece_kind.get(on, "cloth")
    set_material(ho, material(f"{kind}.hood", himg, rough=next((p.get("rough", 0.85) for cl in outfit["clothes"] for p in cl["parts"] if p["name"] == on), 0.85)))
    skin_like_body(ho)
    meshes["hood"] = ho
    albedos["hood"] = spec.get("tints", {}).get(on) or next(p["albedo"] for cl in outfit["clothes"] for p in cl["parts"] if p["name"] == on)

headlamp = spec.get("headlamp")
if headlamp:
    lo, hi = head_box()
    c = (lo + hi) / 2
    half = (hi - lo) / 2
    zb = c.z + half.z * 0.28
    heads = [body] + [meshes[k] for k in ("hair", "beanie") if k in meshes]
    hp = [p for p in surface_points(heads) if abs(p.z - zb) < 0.02]
    ring = [i * 2 * math.pi / 48 for i in range(48)]
    r = outer_radius(hp, Vector((c.x, c.y, zb)), ring, side, fwd, lambda p: True, window=0.08)
    rmin = min(x for x in r if x > 0)
    band = bmesh.new()
    rows = []
    for a, ri in zip(ring, r):
        ri = max(ri, rmin) + 0.006
        d = side * math.cos(a) + fwd * math.sin(a)
        # The band rides lower at the back of the head.
        drop = 0.02 * max(0.0, -math.sin(a))
        p = Vector((c.x, c.y, zb - drop)) + d * ri
        rows.append((band.verts.new(p - up * 0.013), band.verts.new(p + up * 0.013)))
    for k in range(len(rows)):
        a0, a1 = rows[k]
        b0, b1 = rows[(k + 1) % len(rows)]
        band.faces.new((a0, b0, b1, a1))
    bmesh.ops.recalc_face_normals(band, faces=list(band.faces))
    box_uvs(band, 8.0)
    bo = mesh_object("headband", band)
    solidify(bo, 0.004)
    wimg, wnorm = weave_texture("webbing", cells=32)
    set_material(bo, material("cloth.headband", wimg, wnorm, rough=0.85))
    weight_all(bo, "head")
    meshes["headband"] = bo
    albedos["headband"] = [0.03, 0.03, 0.035]
    # The lamp: a small housing on the forehead, its lens facing forward.
    front = r[12] if r[12] > 0 else rmin  # ring[12] = +fwd
    at = Vector((c.x, c.y, zb)) + fwd * (front + 0.006 + 0.014)
    hm = bmesh.new()
    bmesh.ops.create_cube(hm, size=1.0)
    for v in hm.verts:
        v.co = at + side * v.co.x * 0.052 + fwd * v.co.y * 0.026 + up * v.co.z * 0.034
    bmesh.ops.bevel(hm, geom=list(hm.edges), offset=0.006, segments=2, affect="EDGES")
    box_uvs(hm, 10.0)
    ho = mesh_object("headlamp", hm)
    set_material(ho, material("plastic.headlamp", None, rough=0.4))
    weight_all(ho, "head")
    meshes["headlamp"] = ho
    albedos["headlamp"] = headlamp.get("albedo", [0.05, 0.05, 0.05])
    lm = bmesh.new()
    bmesh.ops.create_circle(lm, cap_ends=True, segments=16, radius=0.012)
    for v in lm.verts:
        v.co = at + fwd * 0.0135 + side * v.co.x + up * v.co.y
    bmesh.ops.recalc_face_normals(lm, faces=list(lm.faces))
    for f in lm.faces:
        if f.normal.dot(fwd) < 0:
            f.normal_flip()
    box_uvs(lm, 10.0)
    lo_ = mesh_object("lens", lm)
    set_material(lo_, material("lens.lens", None, rough=0.08))
    weight_all(lo_, "head")
    meshes["lens"] = lo_
    albedos["lens"] = [0.7, 0.72, 0.75]

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
    if base in ("brows", "lens"):
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
print("PERSON", json.dumps({"id": PERSON_ID, "look": LOOK, "faces": stats, "albedos": albedos}))
