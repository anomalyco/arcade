# Body B: builds public/models/playerb/janitor_b.glb, a MakeHuman (MPFB 2) janitor skinned NATIVELY to the Quaternius
# Universal Animation Library skeleton, so the UAL clips play on it unmodified (no runtime retargeting).
#
#   blender -b --python scripts/playerb/build.py -- <out.glb> <UAL1_Standard.glb> <UAL2_Standard.glb>
#
# 1. MPFB builds the man (CC0 base mesh, clothes, skin, hair, eyes, brows) on MPFB's game_engine rig (UE bone names,
#    the same names as UAL's).
# 2. The MakeHuman rig is posed, bone by bone and top-down, into the UAL rest pose (T-pose): every bone is swung so its
#    direction to its child joint matches the UAL bone's. The meshes are frozen in that pose (armature applied).
# 3. A copy of the UAL armature keeps every UAL bone's exact rest orientation but has its joints moved onto the man's
#    joints. The meshes are skinned to it with MakeHuman's own weights (same bone names).
# 4. The UAL actions are kept as they are; only their pose translations (pelvis bob and root) are scaled to the man's
#    hip height. Exported with the selected clips.
import math
import os
import sys

import addon_utils
import bpy
import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
out, ual1_path, ual2_path = argv[0], argv[1], argv[2]
addon_utils.enable("bl_ext.user_default.mpfb", default_set=True)
from bl_ext.user_default.mpfb.services.humanservice import HumanService  # noqa: E402
from bl_ext.user_default.mpfb.services.locationservice import LocationService  # noqa: E402

KEEP = {
    # UAL1
    "Idle_Loop", "Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Crouch_Idle_Loop", "Crouch_Fwd_Loop", "Jump_Start",
    "Jump_Loop", "Jump_Land", "Interact", "Idle_Torch_Loop", "Walk_Formal_Loop", "PickUp_Table", "Push_Loop",
    "A_TPose",
    # UAL2
    "ClimbUp_1m", "Idle_Lantern_Loop", "Walk_Carry_Loop", "Idle_FoldArms_Loop", "Idle_TalkingPhone_Loop",
}
EXTRA = os.environ.get("PLAYERB_EXTRA_ACTIONS", "")

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
# 60 fps everywhere: the UAL import, the mocap keys and the exporter's sampling.
bpy.context.scene.render.fps = 60
bpy.context.scene.render.fps_base = 1
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)

data = LocationService.get_user_data()
macro = {
    "gender": 1.0,
    "age": 0.64,
    "muscle": 0.52,
    "weight": 0.6,
    "proportions": 0.55,
    "height": 0.55,
    "cupsize": 0.5,
    "firmness": 0.5,
    "race": {"caucasian": 0.8, "african": 0.1, "asian": 0.1},
}
body = HumanService.create_human(macro_detail_dict=macro)
mh_rig = HumanService.add_builtin_rig(body, "game_engine")
assets = [
    ("clothes/male_casualsuit01/male_casualsuit01.mhclo", "Clothes"),
    ("clothes/shoes03/shoes03.mhclo", "Clothes"),
    ("hair/short02/short02.mhclo", "Hair"),
    ("eyes/low-poly/low-poly.mhclo", "Eyes"),
    ("eyebrows/eyebrow001/eyebrow001.mhclo", "Eyebrows"),
    ("eyelashes/eyelashes01/eyelashes01.mhclo", "Eyelashes"),
]
for rel, kind in assets:
    p = os.path.join(data, rel)
    if os.path.exists(p):
        HumanService.add_mhclo_asset(p, body, asset_type=kind, subdiv_levels=0, material_type="MAKESKIN")
    else:
        print("missing asset", rel)

bpy.context.view_layer.objects.active = body
body.select_set(True)
if body.data.shape_keys:
    bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
for m in list(body.modifiers):
    if m.type == "MASK":
        bpy.ops.object.modifier_move_to_index(modifier=m.name, index=0)
        bpy.ops.object.modifier_apply(modifier=m.name)
mh_meshes = [o for o in bpy.data.objects if o.type == "MESH"]
for o in mh_meshes:
    for m in list(o.modifiers):
        if m.type == "SUBSURF":
            o.modifiers.remove(m)
    if o.data.shape_keys:
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)

# ---------------------------------------------------------------------------------------------------------------- UAL
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=ual1_path)
ual = next(o for o in bpy.data.objects if o.type == "ARMATURE" and o not in before)
ual_junk = [o for o in bpy.data.objects if o not in before]
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=ual2_path)
ual_junk += [o for o in bpy.data.objects if o not in before]
for a in bpy.data.actions:
    a.use_fake_user = True

U = {b.name: b for b in ual.data.bones}
M = {b.name: b for b in mh_rig.data.bones}
mh_name = lambda u: "head" if u == "Head" else ("Root" if u == "root" else u)  # noqa: E731


def ual_head(n):
    return ual.matrix_world @ U[n].head_local


def ual_end(n):
    """Point the UAL bone aims at: its chain child's head (or its tail for leaves)."""
    c = AIM.get(n)
    if c and c in U:
        return ual_head(c)
    return ual.matrix_world @ U[n].tail_local


AIM = {"pelvis": "spine_01", "spine_01": "spine_02", "spine_02": "spine_03", "spine_03": "neck_01", "neck_01": "Head"}
for s in "lr":
    AIM.update({f"clavicle_{s}": f"upperarm_{s}", f"upperarm_{s}": f"lowerarm_{s}", f"lowerarm_{s}": f"hand_{s}",
                f"hand_{s}": f"middle_01_{s}", f"thigh_{s}": f"calf_{s}", f"calf_{s}": f"foot_{s}",
                f"foot_{s}": f"ball_{s}", f"ball_{s}": f"ball_leaf_{s}"})
    for f in ("thumb", "index", "middle", "ring", "pinky"):
        for i in (1, 2, 3):
            AIM[f"{f}_0{i}_{s}"] = f"{f}_0{i + 1}_{s}" if i < 3 else f"{f}_04_leaf_{s}"

# --------------------------------------------------------------- 2. pose the MakeHuman rig into the UAL rest (T-pose)
bpy.context.view_layer.objects.active = mh_rig
bpy.ops.object.mode_set(mode="POSE")
P = mh_rig.pose.bones
mw = mh_rig.matrix_world


def mh_aim(n):
    """Posed world points of the MH bone: head and the point it aims at (chain child's head, else tail)."""
    pb = P[mh_name(n)]
    c = AIM.get(n)
    h = mw @ pb.head
    if c and mh_name(c) in P:
        return h, mw @ P[mh_name(c)].head
    return h, mw @ pb.tail


order = []


def walk(b):
    order.append(b.name)
    for c in b.children:
        walk(c)


walk(U["root"])
for n in order:
    if n not in AIM or mh_name(n) not in P:
        continue
    bpy.context.view_layer.update()
    h, e = mh_aim(n)
    cur = (e - h).normalized()
    tgt = (ual_end(n) - ual_head(n)).normalized()
    q = cur.rotation_difference(tgt)
    pb = P[mh_name(n)]
    m = mw.inverted() @ (Matrix.Translation(h) @ q.to_matrix().to_4x4() @ Matrix.Translation(-h)) @ mw @ pb.matrix
    pb.matrix = m
bpy.context.view_layer.update()

# Report how well the posed hands agree with UAL's (palm across-vector, index -> pinky knuckle).
for s in "lr":
    a = (mw @ P[f"pinky_01_{s}"].head - mw @ P[f"index_01_{s}"].head).normalized()
    b = (ual_head(f"pinky_01_{s}") - ual_head(f"index_01_{s}")).normalized()
    print(f"palm {s}: mh {tuple(round(x, 2) for x in a)} ual {tuple(round(x, 2) for x in b)} angle {math.degrees(a.angle(b)):.1f}")

# Twist the forearm (pronation) so the palm faces like UAL's: rotate lowerarm about its own axis; half the twist stays
# in the forearm mesh, which is how a real forearm carries it.
for s in "lr":
    bpy.context.view_layer.update()
    h = mw @ P[f"lowerarm_{s}"].head
    axis = (mw @ P[f"hand_{s}"].head - h).normalized()
    a = (mw @ P[f"pinky_01_{s}"].head - mw @ P[f"index_01_{s}"].head)
    b = (ual_head(f"pinky_01_{s}") - ual_head(f"index_01_{s}"))
    a = (a - axis * a.dot(axis)).normalized()
    b = (b - axis * b.dot(axis)).normalized()
    ang = math.atan2(axis.dot(a.cross(b)), a.dot(b))
    print(f"forearm twist {s}: {math.degrees(ang):.1f}")
    from mathutils import Quaternion

    q = Quaternion(axis, ang)
    pb = P[f"lowerarm_{s}"]
    pb.matrix = mw.inverted() @ (Matrix.Translation(h) @ q.to_matrix().to_4x4() @ Matrix.Translation(-h)) @ mw @ pb.matrix
bpy.context.view_layer.update()
# Re-aim the hands and fingers after the twist (twist does not move the aims, but keep the order exact).
for n in order:
    if not (n.startswith("hand_") or any(n.startswith(f) for f in ("thumb", "index", "middle", "ring", "pinky"))):
        continue
    if n not in AIM or mh_name(n) not in P:
        continue
    bpy.context.view_layer.update()
    h, e = mh_aim(n)
    q = (e - h).normalized().rotation_difference((ual_end(n) - ual_head(n)).normalized())
    pb = P[mh_name(n)]
    pb.matrix = mw.inverted() @ (Matrix.Translation(h) @ q.to_matrix().to_4x4() @ Matrix.Translation(-h)) @ mw @ pb.matrix
bpy.context.view_layer.update()

posed_head = {b.name: (mw @ b.head).copy() for b in P}
posed_tail = {b.name: (mw @ b.tail).copy() for b in P}
bpy.ops.object.mode_set(mode="OBJECT")

# Freeze the meshes in the posed rest.
for o in mh_meshes:
    bpy.context.view_layer.objects.active = o
    for m in list(o.modifiers):
        if m.type == "ARMATURE":
            bpy.ops.object.modifier_apply(modifier=m.name)

# ------------------------------------------------------------------- 3. the UAL skeleton fitted to the man's joints
bpy.ops.object.select_all(action="DESELECT")
arm = ual.copy()
arm.data = ual.data.copy()
arm.name = arm.data.name = "Janitor"
bpy.context.scene.collection.objects.link(arm)
arm.animation_data_clear()
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
inv = arm.matrix_world.inverted()
E = arm.data.edit_bones
for eb in E:
    eb.use_connect = False
moved = {}
for eb in E:
    n = eb.name
    if n == "root":
        continue
    if mh_name(n) in posed_head:
        p = posed_head[mh_name(n)]
    elif n.endswith("_leaf_l") or n.endswith("_leaf_r"):
        par = eb.parent.name
        p = posed_tail[mh_name(par)]
    else:
        print("unmatched UAL bone", n)
        continue
    moved[n] = inv @ p
for n, p in moved.items():
    eb = E[n]
    L = eb.length
    m = eb.matrix.copy()
    m.translation = p
    eb.matrix = m
    eb.length = L
bpy.ops.object.mode_set(mode="OBJECT")

hip_ratio = posed_head["pelvis"].z / ual_head("pelvis").z
print("hip ratio", hip_ratio)

for o in mh_meshes:
    o.parent = arm
    o.matrix_parent_inverse = arm.matrix_world.inverted()
    for g in o.vertex_groups:
        if g.name == "head":
            g.name = "Head"
        elif g.name == "Root":
            g.name = "root"
    mod = o.modifiers.new("Armature", "ARMATURE")
    mod.object = arm

# ------------------------------------------------------------------------------------------------ 4. the clips
def fcurves(a):
    if hasattr(a, "layers") and len(a.layers):
        for layer in a.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    yield from bag.fcurves
    elif hasattr(a, "fcurves"):
        yield from a.fcurves


keep = KEEP | set(filter(None, EXTRA.split(",")))
seen = set()
for a in list(bpy.data.actions):
    base = a.name.split(".")[0]
    if base not in keep or base in seen:
        bpy.data.actions.remove(a)
        continue
    seen.add(base)
    a.name = base
    for fc in fcurves(a):
        if fc.data_path.endswith(".location"):
            for k in fc.keyframe_points:
                k.co.y *= hip_ratio
                k.handle_left.y *= hip_ratio
                k.handle_right.y *= hip_ratio
print("actions", sorted(seen))

# ------------------------------------------------------------------------- 5. CMU mocap loops, retargeted offline
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import json  # noqa: E402

from mocap import bake  # noqa: E402

cmu_dir = argv[3] if len(argv) > 3 else ""
meta_out = argv[4] if len(argv) > 4 else ""


def action_pose(act, frame):
    pose = {}
    for fc in fcurves(act):
        if fc.data_path.endswith("rotation_quaternion"):
            bone = fc.data_path.split('"')[1]
            pose.setdefault(bone, [1.0, 0.0, 0.0, 0.0])[fc.array_index] = fc.evaluate(frame)
    from mathutils import Quaternion

    fingers = ("thumb", "index", "middle", "ring", "pinky")
    # UAL's idle hand is a loose fist; open it a third for a relaxed hand (thumb unchanged).
    return {k: Quaternion().slerp(Quaternion(v).normalized(), 1.0 if k.startswith("thumb") else 0.68) for k, v in pose.items() if k.startswith(fingers)}


# Clip name, CMU subject/take, wanted local travel direction, mirror (left<->right), optional frame window.
MOCAP = [
    ("M_Walk", "07", "07_01", "fwd", False, None),
    ("M_WalkBrisk", "07", "07_12", "fwd", False, None),
    ("M_Jog", "16", "16_35", "fwd", False, None),
    ("M_Run", "127", "127_06", "fwd", False, None),
    ("M_WalkBack", "143", "143_39", "back", False, None),
    ("M_WalkRight", "143", "143_40", "right", False, None),
    ("M_WalkLeft", "143", "143_40", "left", True, None),
]
meta = {}
if cmu_dir:
    idle = bpy.data.actions.get("Idle_Loop")
    hand = action_pose(idle, idle.frame_range[0]) if idle else {}
    for name, subj, take, want, mirror, window in MOCAP:
        try:
            meta[name] = bake(arm, name, os.path.join(cmu_dir, f"{subj}.asf"), ",".join(os.path.join(cmu_dir, f"{t}.amc") for t in take.split(",")), want,
                              mirror=mirror, window=window, finger_pose=hand)
        except Exception as e:  # noqa: BLE001
            print("mocap failed", name, e)
            if want in ("left", "right"):
                other = "right" if want == "left" else "left"
                try:
                    meta[name] = bake(arm, name, os.path.join(cmu_dir, f"{subj}.asf"), ",".join(os.path.join(cmu_dir, f"{t}.amc") for t in take.split(",")),
                                      other, mirror=True, window=window, finger_pose=hand)
                    meta[name]["mirrored"] = True
                except Exception as e2:  # noqa: BLE001
                    print("mirror failed", name, e2)
    # Jump (CMU 16_02, a standing vertical jump): push-off, flight (driven by vertical velocity), landing.
    # Idle: CMU 16_02's quiet stand before the jump, closed into a loop.
    try:
        meta["M_Idle"] = bake(arm, "M_Idle", os.path.join(cmu_dir, "16.asf"), os.path.join(cmu_dir, "16_02.amc"), "fwd",
                              finger_pose=hand, segment=(0, 156), loop=True)
    except Exception as e:  # noqa: BLE001
        print("mocap failed M_Idle", e)
    JUMPS = [("M_JumpStart", 204, 246, False), ("M_JumpAir", 228, 282, True), ("M_JumpLand", 276, 336, False)]
    for name, a0, b0, in_air in JUMPS:
        try:
            meta[name] = bake(arm, name, os.path.join(cmu_dir, "16.asf"), os.path.join(cmu_dir, "16_02.amc"), "fwd",
                              finger_pose=hand, segment=(a0, b0), air=in_air)
        except Exception as e:  # noqa: BLE001
            print("mocap failed", name, e)
    if meta_out:
        with open(meta_out, "w") as f:
            json.dump(meta, f, indent=1)

for o in ual_junk:
    if o.name in bpy.data.objects:
        bpy.data.objects.remove(o)
bpy.data.objects.remove(mh_rig)

# --------------------------------------------------------------- 6. authored flashlight carry (right arm poses)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carry import author_carry  # noqa: E402

meta["carry"] = author_carry(arm)
if meta_out:
    with open(meta_out, "w") as f:
        json.dump(meta, f, indent=1)

# ------------------------------------------------------------------------------------------------ materials
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
    u = np.linspace(0, 1, w)[None, :].repeat(h, 0)
    l = lum(px)
    jeans = (u > 0.36) & (u < 0.73)
    rel_j = np.clip(l / max(l[jeans].mean(), 1e-3), 0.3, 1.8)
    lj = 0.07 * (1 + (rel_j - 1) * 0.5)
    trousers = np.stack([lj * 0.98, lj * 1.0, lj * 0.95], -1)
    rel_s = np.clip(l / max(l[~jeans].mean(), 1e-3), 0.2, 1.8)
    ls = 0.21 * (1 + (rel_s - 1) * 0.85)
    shirt = np.stack([ls * 0.8, ls * 1.0, ls * 0.84], -1)
    px[..., :3] = np.where(jeans[..., None], trousers, shirt)


def skin_tone(px, w, h):
    l = lum(px)[..., None]
    px[..., :3] = (l + (px[..., :3] - l) * 0.62) * 0.82


def boots(px, w, h):
    l = lum(px)
    px[..., 0] = l * 1.3 + 0.03
    px[..., 1] = l * 0.98 + 0.016
    px[..., 2] = l * 0.7 + 0.006


def hair_tone(px, w, h):
    l = lum(px)
    px[..., 0] = l * 0.62
    px[..., 1] = l * 0.5
    px[..., 2] = l * 0.4


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


def opt(rel, size):
    p = os.path.join(data, rel)
    return load(p, size) if os.path.exists(p) else None


skin = opt("skins/middleage_caucasian_male/middleage_lightskinned_male_diffuse.png", 1024)
tint(skin, skin_tone)
suit_c = opt("clothes/male_casualsuit01/male_casualsuit01_diffuse.png", 1024)
tint(suit_c, suit)
suit_n = opt("clothes/male_casualsuit01/male_casualsuit01_normal.png", 1024)
boot_c = opt("clothes/shoes03/shoes03_diffuse.png", 512)
tint(boot_c, boots)
mats = {
    "skin": material("skin", skin, rough=0.55),
    "suit": material("suit", suit_c, suit_n, rough=0.92),
    "boots": material("boots", boot_c, rough=0.5),
}
for key, rel, size in (("hair", "hair/short02/short02_diffuse.png", 512), ("eyes", "eyes/materials/brown_eye.png", 256),
                       ("brows", "eyebrows/eyebrow001/eyebrow001.png", 256), ("lashes", "eyelashes/eyelashes01/eyelashes01.png", 256)):
    img = opt(rel, size)
    if img is not None and key == "hair":
        tint(img, hair_tone)
    if img is not None:
        mats[key] = material(key, img, rough=0.2 if key == "eyes" else 0.7, alpha=key != "eyes")

for o in mh_meshes:
    n = o.name.lower()
    key = ("suit" if "casualsuit" in n else "boots" if "shoes" in n else "hair" if "short02" in n
           else "eyes" if "low-poly" in n or "eye" in n and "brow" not in n and "lash" not in n
           else "brows" if "eyebrow" in n else "lashes" if "lash" in n else "skin")
    o.data.materials.clear()
    o.data.materials.append(mats.get(key, mats["skin"]))
    print("mesh", o.name, key, len(o.data.polygons))

bpy.ops.object.select_all(action="DESELECT")
arm.select_set(True)
for o in mh_meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = arm
# One NLA track per clip (exported as one glTF animation each).
ad = arm.animation_data_create()
for a in sorted(bpy.data.actions, key=lambda a: a.name):
    tr = ad.nla_tracks.new()
    tr.name = a.name
    st = tr.strips.new(a.name, int(a.frame_range[0]), a)
    if hasattr(st, "action_slot") and st.action_slot is None and len(a.slots):
        st.action_slot = a.slots[0]
    tr.mute = False
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    use_selection=True,
    export_skins=True,
    export_animations=True,
    export_animation_mode="NLA_TRACKS",
    export_force_sampling=True,
    export_morph=False,
    export_yup=True,
    export_image_format="JPEG",
    export_jpeg_quality=86,
    export_apply=False,
)
print("wrote", out)
