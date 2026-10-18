# Builds public/models/player/janitor.glb: a MakeHuman (MPFB 2) middle-aged man in a work shirt, dark work trousers and
# leather work boots, skinned to MPFB's "game_engine" skeleton (UE-style bone names). Everything here is CC0 (MakeHuman
# base mesh, targets, rig, skins and the system clothes/hair assets).
#
#   blender -b --python scripts/player/build-body.py -- <out.glb>
#
# Needs the MPFB extension installed (`blender --command extension install-file -r user_default -e mpfb.zip`) and the
# makehuman_system_assets_cc0 pack's clothes/male_casualsuit01, clothes/shoes03, skins/middleage_caucasian_male and
# hair/short02 unpacked into the extension's user data dir. scripts/player/build-body.ts does all of that.
import os
import sys

import addon_utils
import bpy
import numpy as np

out = sys.argv[sys.argv.index("--") + 1]
addon_utils.enable("bl_ext.user_default.mpfb", default_set=True)
from bl_ext.user_default.mpfb.services.humanservice import HumanService  # noqa: E402
from bl_ext.user_default.mpfb.services.locationservice import LocationService  # noqa: E402

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)

data = LocationService.get_user_data()
macro = {
    "gender": 1.0,
    "age": 0.64,  # ~43 years
    "muscle": 0.56,
    "weight": 0.62,
    "proportions": 0.5,
    "height": 0.56,
    "cupsize": 0.5,
    "firmness": 0.5,
    "race": {"caucasian": 0.8, "african": 0.1, "asian": 0.1},
}
body = HumanService.create_human(macro_detail_dict=macro)
rig = HumanService.add_builtin_rig(body, "game_engine")
assets = [
    ("clothes/male_casualsuit01/male_casualsuit01.mhclo", "Clothes"),
    ("clothes/shoes03/shoes03.mhclo", "Clothes"),
    ("hair/short02/short02.mhclo", "Hair"),
]
for rel, kind in assets:
    HumanService.add_mhclo_asset(os.path.join(data, rel), body, asset_type=kind, subdiv_levels=0, material_type="MAKESKIN")

# Bake the clothes' delete masks and the helper mask into the body, so hidden skin is gone, not just masked.
bpy.context.view_layer.objects.active = body
body.select_set(True)
if body.data.shape_keys:
    bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
for m in list(body.modifiers):
    if m.type == "MASK":
        bpy.ops.object.modifier_move_to_index(modifier=m.name, index=0)
        bpy.ops.object.modifier_apply(modifier=m.name)
for o in bpy.data.objects:
    if o.type == "MESH":
        for m in list(o.modifiers):
            if m.type == "SUBSURF":
                o.modifiers.remove(m)

# Hands: one level of smooth subdivision on the hand and finger faces only (the base mesh's fingers are 8-sided tubes
# that read as fused sausages up close; in first person the hands are the closest thing on screen). Vertex groups
# (the skin weights) are interpolated onto the new vertices.
import bmesh  # noqa: E402

HAND = ("hand_", "thumb_", "index_", "middle_", "ring_", "pinky_")
groups = {g.index for g in body.vertex_groups if g.name.startswith(HAND)}
bpy.context.view_layer.objects.active = body
bpy.ops.object.mode_set(mode="OBJECT")
for v in body.data.vertices:
    v.select = sum(g.weight for g in v.groups if g.group in groups) > 0.5
for f in body.data.polygons:
    f.select = all(body.data.vertices[i].select for i in f.vertices)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_mode(type="FACE")
bpy.ops.mesh.subdivide(number_cuts=1, smoothness=1.0, quadcorner="INNERVERT")
bpy.ops.mesh.select_all(action="DESELECT")
bpy.ops.object.mode_set(mode="OBJECT")
print("hand faces subdivided; body faces now", len(body.data.polygons))


def load(path, size):
    img = bpy.data.images.load(path)
    if max(img.size) > size:
        img.scale(size, size)
    return img


def tint(img, fn):
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    fn(px, w, h)
    img.pixels[:] = px.ravel()
    img.update()


def lum(px):
    return px[..., 0] * 0.2126 + px[..., 1] * 0.7152 + px[..., 2] * 0.0722


def suit(px, w, h):
    # UV layout: the jeans occupy the middle column (u 0.36..0.73), the shirt the rest. Trousers become dark charcoal
    # work twill (albedo ~0.06, denim fades flattened), the shirt a washed grey-green work shirt (~0.2); the weave and
    # seams stay as relative detail.
    u = np.linspace(0, 1, w)[None, :].repeat(h, 0)
    l = lum(px)
    jeans = (u > 0.36) & (u < 0.73)
    rel_j = np.clip(l / max(l[jeans].mean(), 1e-3), 0.3, 1.8)
    lj = 0.062 * (1 + (rel_j - 1) * 0.5)
    trousers = np.stack([lj * 0.98, lj * 1.0, lj * 0.94], -1)
    rel_s = np.clip(l / max(l[~jeans].mean(), 1e-3), 0.2, 1.8)
    ls = 0.2 * (1 + (rel_s - 1) * 0.85)
    shirt = np.stack([ls * 0.95, ls * 1.0, ls * 0.8], -1)
    px[..., :3] = np.where(jeans[..., None], trousers, shirt)


def skin_tone(px, w, h):
    # The MakeHuman diffuse is lit and saturated for its own renderer: desaturate a third and darken a little.
    l = lum(px)[..., None]
    px[..., :3] = (l + (px[..., :3] - l) * 0.62) * 0.82


def boots(px, w, h):
    l = lum(px)
    px[..., 0] = l * 1.25 + 0.012
    px[..., 1] = l * 0.95 + 0.006
    px[..., 2] = l * 0.72


def material(name, color, normal=None, rough=0.8, alpha=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = color
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if alpha:
        nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
        mat.blend_method = "CLIP"
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


skin = load(os.path.join(data, "skins/middleage_caucasian_male/middleage_lightskinned_male_diffuse.png"), 1024)
tint(skin, skin_tone)
suit_c = load(os.path.join(data, "clothes/male_casualsuit01/male_casualsuit01_diffuse.png"), 1024)
tint(suit_c, suit)
suit_n = load(os.path.join(data, "clothes/male_casualsuit01/male_casualsuit01_normal.png"), 1024)
boot_c = load(os.path.join(data, "clothes/shoes03/shoes03_diffuse.png"), 512)
tint(boot_c, boots)
hair_c = load(os.path.join(data, "hair/short02/short02_diffuse.png"), 512) if os.path.exists(os.path.join(data, "hair/short02/short02_diffuse.png")) else None

mats = {
    "skin": material("skin", skin, rough=0.55),
    "suit": material("suit", suit_c, suit_n, rough=0.92),
    "boots": material("boots", boot_c, rough=0.55),
}
if hair_c is not None:
    mats["hair"] = material("hair", hair_c, rough=0.7, alpha=True)

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
for o in meshes:
    n = o.name.lower()
    key = "suit" if "casualsuit" in n else "boots" if "shoes" in n else "hair" if "short02" in n else "skin"
    o.data.materials.clear()
    o.data.materials.append(mats.get(key, mats["skin"]))
    print("mesh", o.name, key, len(o.data.polygons))

bpy.ops.object.select_all(action="DESELECT")
rig.select_set(True)
for o in meshes:
    o.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    use_selection=True,
    export_skins=True,
    export_animations=False,
    export_morph=False,
    export_yup=True,
    export_image_format="JPEG",
    export_jpeg_quality=86,
    export_apply=False,
)
print("wrote", out)
