"""Converts one Microsoft Rocketbox avatar (MIT) into a people GLB on the MakeHuman `game_engine` bone names, for
scripts/people/build-rocketbox.ts:

  blender -b --factory-startup --python scripts/people/build-rocketbox.py -- <avatar dir> <out.glb> <texture px>
  (the avatar dir holds Export/<name>.fbx and Textures/<id>_{body,head}_{color,normal}.tga, <id>_opacity_color.tga)

The Biped skeleton is renamed (Bip01 Pelvis -> pelvis, Bip01 L Finger1 -> index_01_l, ...), its thighs move under the
pelvis and its clavicles under the chest as in UE, and the 30 face bones stay (they follow the head). The one mesh is
split by material into the kinds `personHooks` shades: clothes, skin (head, and the hands from their bone weights),
eyes (from the eye bones) and hair (the opacity cards). Each part gets a decimated LOD1 copy.
"""

import json
import math
import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT, PX = argv[0], argv[1], int(argv[2])
name = os.path.basename(os.path.normpath(SRC))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=os.path.join(SRC, "Export", f"{name}.fbx"))
for o in [o for o in bpy.data.objects if o.type not in ("ARMATURE", "MESH")]:
    bpy.data.objects.remove(o)
rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
mesh = next(o for o in bpy.data.objects if o.type == "MESH")
bpy.context.view_layer.objects.active = rig
for o in (rig, mesh):
    o.animation_data_clear()
for pb in rig.pose.bones:
    pb.matrix_basis.identity()

# --- Transforms: bake the FBX's centimetre scale and quarter turn into the rest pose and the vertices. ------------------
bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True)
bpy.context.view_layer.objects.active = mesh
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
for o in (rig, mesh):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type="OBJECT", keep_transform=True)

# --- Bones: Biped -> game_engine names; renaming a bone renames its vertex group too. ----------------------------------
FINGERS = ["thumb", "index", "middle", "ring", "pinky"]
RENAME = {
    "Bip01 Pelvis": "pelvis", "Bip01 Spine": "spine_01", "Bip01 Spine1": "spine_02", "Bip01 Spine2": "spine_03",
    "Bip01 Neck": "neck_01", "Bip01 Head": "head",
}
for side, s in (("L", "l"), ("R", "r")):
    RENAME.update({
        f"Bip01 {side} Clavicle": f"clavicle_{s}", f"Bip01 {side} UpperArm": f"upperarm_{s}",
        f"Bip01 {side} Forearm": f"lowerarm_{s}", f"Bip01 {side} Hand": f"hand_{s}",
        f"Bip01 {side} Thigh": f"thigh_{s}", f"Bip01 {side} Calf": f"calf_{s}",
        f"Bip01 {side} Foot": f"foot_{s}", f"Bip01 {side} Toe0": f"ball_{s}",
    })
    for f, finger in enumerate(FINGERS):
        for j, suffix in enumerate(("", "1", "2")):
            RENAME[f"Bip01 {side} Finger{f}{suffix}"] = f"{finger}_0{j + 1}_{s}"
for b in rig.data.bones:
    if b.name in RENAME:
        b.name = RENAME[b.name]
    elif b.name.startswith("Bip01 "):
        b.name = "face_" + b.name[6:].replace(" ", "_").lower()
missing = [v for v in RENAME.values() if v not in rig.data.bones]
if missing:
    raise SystemExit(f"missing bones: {missing}")

bpy.ops.object.mode_set(mode="EDIT")
eb = rig.data.edit_bones
for s in ("l", "r"):
    eb[f"thigh_{s}"].use_connect = False
    eb[f"thigh_{s}"].parent = eb["pelvis"]
    eb[f"clavicle_{s}"].use_connect = False
    eb[f"clavicle_{s}"].parent = eb["spine_03"]
bpy.ops.object.mode_set(mode="OBJECT")

# Unweighted vertices (a few hair cards) would get the exporter's neutral bone and stay at the origin: give each the
# weights of the nearest weighted vertex.
from mathutils import kdtree

vg = mesh.data.vertices
weighted = [v for v in vg if sum(g.weight for g in v.groups) > 1e-4]
loose = [v for v in vg if sum(g.weight for g in v.groups) <= 1e-4]
if loose:
    tree = kdtree.KDTree(len(weighted))
    for i, v in enumerate(weighted):
        tree.insert(v.co, i)
    tree.balance()
    copies = [(v.index, [(g.group, g.weight) for g in weighted[tree.find(v.co)[1]].groups]) for v in loose]
    for index, groups_ in copies:
        for g, w in groups_:
            mesh.vertex_groups[g].add([index], w, "REPLACE")
print("LOOSE", len(loose))

# --- Materials: rebuild from the source TGAs, downscaled, one per kind. -----------------------------------------------
tex_dir = os.path.join(SRC, "Textures")
tmp = os.path.join(os.path.dirname(OUT), f"{name}-tex")
os.makedirs(tmp, exist_ok=True)
images = {}


def image(file, px, data):
    key = (file, px)
    if key not in images:
        img = bpy.data.images.load(os.path.join(tex_dir, file))
        if img.size[0] > px:
            img.scale(px, px)
        path = os.path.join(tmp, os.path.splitext(file)[0] + ".png")
        img.filepath_raw = path
        img.file_format = "PNG"
        img.save()
        img = bpy.data.images.load(path)
        img.colorspace_settings.name = "Non-Color" if data else "sRGB"
        images[key] = img
    return images[key]


def material(label, color, normal=None, alpha=False):
    m = bpy.data.materials.new(label)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = image(color, PX, False)
    nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    if alpha:
        nt.links.new(t.outputs["Alpha"], bsdf.inputs["Alpha"])
    if normal:
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = image(normal, PX, True)
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(n.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = 0.8
    return m


src_mats = [m.name for m in mesh.data.materials]
tag = src_mats[0].split("_")[0]  # m009, f004
new = {
    "body": material("cloth.outfit", f"{tag}_body_color.tga", f"{tag}_body_normal.tga"),
    "hands": material("skin.hands", f"{tag}_body_color.tga", f"{tag}_body_normal.tga"),
    "head": material("skin.head", f"{tag}_head_color.tga", f"{tag}_head_normal.tga"),
    "eyes": material("eye.eyes", f"{tag}_head_color.tga", f"{tag}_head_normal.tga"),
    "opacity": material("hair.hair", f"{tag}_opacity_color.tga", None, alpha=True),
}
order = ["body", "hands", "head", "eyes", "opacity"]
kind_of = {i: next(k for k in ("body", "head", "opacity") if src_mats[i].endswith("_" + k)) for i in range(len(src_mats))}
me = mesh.data
src_index = [p.material_index for p in me.polygons]
me.materials.clear()
for k in order:
    me.materials.append(new[k])

groups = {g.index: g.name for g in mesh.vertex_groups}
HAND = {"hand_l", "hand_r"} | {f"{f}_0{j}_{s}" for f in FINGERS for j in (1, 2, 3) for s in ("l", "r")}
EYE = {"face_leye", "face_reye"}


def share(poly, names):
    total = 0.0
    for vi in poly.vertices:
        for g in me.vertices[vi].groups:
            if groups.get(g.group) in names:
                total += g.weight
    return total / len(poly.vertices)


for p, si in zip(me.polygons, src_index):
    k = kind_of[si]
    if k == "body" and share(p, HAND) > 0.5:
        k = "hands"
    elif k == "head" and share(p, EYE) > 0.5:
        k = "eyes"
    p.material_index = order.index(k)

# --- Linings: the outfit is one closed shell, and each opening (a vest's zip, armholes, hems, collars) folds 150-165°
# back under itself into a lining strip a few millimetres inside the outer panel, facing the body. Rocketbox maps
# those strips onto texels painted with the garment's contact shadow, near black, and shades them facing inward, so
# wherever an edge opens as the rig moves they show as a dark seam. Give each strip corner the UV and normal of the
# nearest panel corner facing the other way (the panel right over it), so the strip reads as the panel's own fabric.
# Deleting the strips instead shows the panel's inside at 3/4 view. Strip faces: on such a fold, facing the body
# (against their main bone's segment), grown across smooth neighbours that also face it, within 4 cm. ---------------
import bmesh
from mathutils.geometry import intersect_point_line


def dress_linings(mat_index):
    corner = [c.vector.copy() for c in me.corner_normals]
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    bm.faces.ensure_lookup_table()
    dw = bm.verts.layers.deform.active
    uvl = bm.loops.layers.uv.active
    segs = {b.name: (b.head_local, b.tail_local) for b in rig.data.bones}

    def inward(f):
        acc = {}
        for v in f.verts:
            for g, w in v[dw].items():
                acc[g] = acc.get(g, 0) + w
        a, b = segs[groups[max(acc, key=acc.get)]]
        c = f.calc_center_median()
        _, t = intersect_point_line(c, a, b)
        d = c - a.lerp(b, min(max(t, 0.0), 1.0))
        return d.length > 1e-6 and f.normal.dot(d.normalized()) < -0.2

    flap, origin = set(), {}
    for e in bm.edges:
        fs = [f for f in e.link_faces if f.material_index == mat_index]
        if len(fs) == 2 and fs[0].normal.dot(fs[1].normal) < -0.5:
            for f in fs:
                if f not in flap and inward(f):
                    flap.add(f)
                    origin[f] = f.calc_center_median()
    front = list(flap)
    while front:
        f = front.pop()
        for e in f.edges:
            for g in e.link_faces:
                if g in flap or g.material_index != mat_index or g.normal.dot(f.normal) < 0.5:
                    continue
                if (g.calc_center_median() - origin[f]).length > 0.04 or not inward(g):
                    continue
                flap.add(g)
                origin[g] = origin[f]
                front.append(g)

    outer = [(f, l) for f in bm.faces if f.material_index == mat_index and f not in flap for l in f.loops]
    tree = kdtree.KDTree(len(outer))
    for i, (_, l) in enumerate(outer):
        tree.insert(l.vert.co, i)
    tree.balance()
    normal = {}
    for f in flap:
        for l in f.loops:
            for _, i, _ in tree.find_n(l.vert.co, 32):
                g, m = outer[i]
                if g.normal.dot(f.normal) < -0.3:
                    l[uvl].uv = m[uvl].uv.copy()
                    normal[(f.index, l.vert.index)] = corner[m.index]
                    break
    bm.to_mesh(me)
    bm.free()
    me.normals_split_custom_set([normal.get((p.index, me.loops[li].vertex_index), corner[li])
                                 for p in me.polygons for li in p.loop_indices])
    return len(flap), len(normal)


print("LININGS", *dress_linings(order.index("body")))

# --- Skin colour: the median linear texel over each skin material's own UV area (area-weighted random points), for
# build-rocketbox.ts to move onto the measured skin curve (`packages/kit/people/skin.ts`). The median skips brows,
# lips, stubble and painted hair. ----------------------------------------------------------------------------------
import numpy as np


def skin_median(mat_index, img, keep=lambda centre: True):
    w, h = img.size
    px = np.asarray(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[:, :, :3]
    me.calc_loop_triangles()
    uv = me.uv_layers.active.data
    rng = np.random.default_rng(1)
    samples = []
    for t in me.loop_triangles:
        if t.material_index != mat_index or not keep(t.center):
            continue
        a, b, c = (np.array(uv[i].uv) for i in t.loops)
        n = max(1, int(abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) * 0.5 * 400_000))
        r1, r2 = rng.random(n), rng.random(n)
        s = np.sqrt(r1)
        p = np.outer(1 - s, a) + np.outer(s * (1 - r2), b) + np.outer(s * r2, c)
        x = np.clip((p[:, 0] % 1) * w, 0, w - 1).astype(int)
        y = np.clip((p[:, 1] % 1) * h, 0, h - 1).astype(int)
        samples.append(px[y, x])
    srgb = np.concatenate(samples)
    lin = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
    return [round(float(v), 4) for v in np.median(lin, axis=0)], len(lin)


# The face only: in front of the head bone and below the brows (the head atlas also paints the scalp's hair).
head_y = rig.data.bones["head"].head_local.y
brow_z = rig.data.bones["face_leye"].head_local.z + 0.02
face = lambda c: c.y < head_y - 0.02 and c.z < brow_z
skin = {}
for k, piece, keep in (("head", "head", face), ("hands", "hands", lambda c: True)):
    m = new[k]
    img = next(n.image for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image and n.image.colorspace_settings.name == "sRGB")
    skin[piece], count = skin_median(order.index(k), img, keep)
print("SKIN", json.dumps(skin))

# --- Parts and LODs ---------------------------------------------------------------------------------------------------
bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True)
bpy.context.view_layer.objects.active = mesh
bpy.ops.mesh.separate(type="MATERIAL")
LOD1 = {"cloth": 0.35, "skin": 0.4, "eye": 1.0, "hair": 0.6}
stats = {}
for o in [o for o in bpy.data.objects if o.type == "MESH"]:
    if not o.data.polygons:
        bpy.data.objects.remove(o)
        continue
    label = o.data.materials[o.data.polygons[0].material_index].name
    kind, piece = label.split(".")
    for i in reversed(range(len(o.data.materials))):
        if o.data.materials[i].name != label:
            o.data.materials.pop(index=i)
    o.name = f"LOD0.{piece}"
    stats[o.name] = sum(len(p.vertices) - 2 for p in o.data.polygons)
    dup = o.copy()
    dup.data = o.data.copy()
    bpy.context.collection.objects.link(dup)
    dup.name = f"LOD1.{piece}"
    if LOD1[kind] < 1:
        dec = dup.modifiers.new("Decimate", "DECIMATE")
        dec.ratio = LOD1[kind]
        dec.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = dup
        bpy.ops.object.modifier_move_to_index(modifier=dec.name, index=0)
        bpy.ops.object.modifier_apply(modifier=dec.name)
        # Decimate drops the custom normals, so the folds left (hems, collars, eyelids) would average front and back
        # into a dark rim; split them where the faces turn more than 120° (an inside angle under 60°).
        dup.data.set_sharp_from_angle(angle=math.radians(120))
    stats[dup.name] = sum(len(p.vertices) - 2 for p in dup.data.polygons)

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
top = max((o.matrix_world @ v.co).z for o in bpy.data.objects if o.name.startswith("LOD0.") for v in o.data.vertices)
print("PERSON", json.dumps({"name": name, "faces": stats, "height": round(top, 3), "bones": len(rig.data.bones)}))
