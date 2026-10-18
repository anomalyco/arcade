# Character roster pipeline (run in Blender by scripts/playerb/characters.ts).
#
#   blender -b --python mixamo.py -- character <Character.fbx> <reference anim .fbx> <out.glb> <meta.json>
#   blender -b --python mixamo.py -- anims <anim dir> <out.glb> <meta.json>
#
# One shared skeleton: every character is re-bound so each bone's rest orientation equals the animation skeleton's
# (Remy's) rest orientation, keeping the character's own joint positions. Step 1 swings each bone's direction onto the
# reference's (the mesh follows, then that pose becomes the rest); step 2 sets the bone roll to the reference's in
# edit mode (rest only, the mesh does not move). The clips then play on any character unmodified, apart from the Hips
# translation, which the runtime scales by the character's hip height. Bone names lose the "mixamorigN:" prefix.
#
# Clips: in-place loops have any linear travel removed (their ground velocity is measured from the planted foot and
# written to the meta); stairs and ladder loops also lose their linear rise; one-shots (turns, door, button, climb to
# top) have their horizontal root path and yaw extracted into the meta (per frame) and removed from the Hips.
import json
import math
import os
import re
import sys

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
mode = argv[0]
PREFIX = re.compile(r"^mixamorig\d*:")
# Remy (the clips' skeleton) is authored at about twice human size (hips 2.09 m). Everything ships in metres with a
# Y-up, unscaled armature: Remy and the clips are scaled so his hips stand at REMY_HIPS.
REMY_HIPS = 0.98
TRUNK = re.compile(r"^(Hips|Spine\d?|Neck|Head|HeadTop_End|LeftEye|RightEye|LeftShoulder|RightShoulder)$")


def apply_transforms(objs):
    """Bake object rotation and scale into the data (armature bones, meshes), so the armature node is identity."""
    bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = 30
    bpy.context.scene.render.fps_base = 1


def import_fbx(path):
    before = set(bpy.data.objects)
    acts = set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False, ignore_leaf_bones=False)
    objs = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in objs if o.type == "ARMATURE")
    new_acts = [a for a in bpy.data.actions if a not in acts]
    return arm, objs, new_acts


def fcurves(a):
    if hasattr(a, "layers") and len(a.layers):
        for layer in a.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    yield from bag.fcurves
    elif hasattr(a, "fcurves"):
        yield from a.fcurves


def strip_names(arm, meshes=()):
    for b in arm.data.bones:
        b.name = PREFIX.sub("", b.name)
    for o in meshes:
        for g in o.vertex_groups:
            g.name = PREFIX.sub("", g.name)


def strip_action(act):
    for fc in fcurves(act):
        fc.data_path = re.sub(r'pose\.bones\["mixamorig\d*:', 'pose.bones["', fc.data_path)


def order_of(arm):
    out = []

    def walk(b):
        out.append(b.name)
        for c in b.children:
            walk(c)

    for b in arm.data.bones:
        if b.parent is None:
            walk(b)
    return out


# ------------------------------------------------------------------------------------------------------- character
def rebind(arm, meshes, ref_rot):
    """Make arm's rest bone orientations equal ref_rot (armature space 3x3 per bone name), keeping joint positions."""
    bpy.context.view_layer.objects.active = arm
    for o in meshes:
        o.select_set(False)
    bpy.ops.object.mode_set(mode="POSE")
    P = arm.pose.bones
    for pb in P:
        pb.rotation_mode = "QUATERNION"
    order = order_of(arm)
    for n in order:
        # Only limbs are swung onto the reference: their rest directions differ by pose (arm and leg angles). The
        # trunk, neck, head and shoulders differ by anatomy (posture, neck forward of the spine); swinging those
        # tipped James's head back behind his hood. They keep their geometry and only take the reference frame.
        if n not in ref_rot or TRUNK.match(n):
            continue
        bpy.context.view_layer.update()
        pb = P[n]
        m = pb.matrix.copy()
        cur = (m.to_3x3() @ Vector((0, 1, 0))).normalized()
        tgt = (ref_rot[n] @ Vector((0, 1, 0))).normalized()
        q = cur.rotation_difference(tgt)
        h = m.translation.copy()
        pb.matrix = Matrix.Translation(h) @ q.to_matrix().to_4x4() @ Matrix.Translation(-h) @ m
    bpy.context.view_layer.update()
    bpy.ops.object.mode_set(mode="OBJECT")
    for o in meshes:
        bpy.context.view_layer.objects.active = o
        if o.data.shape_keys:
            bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
        for md in list(o.modifiers):
            if md.type == "ARMATURE":
                bpy.ops.object.modifier_apply(modifier=md.name)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="EDIT")
    E = arm.data.edit_bones
    for eb in E:
        eb.use_connect = False
    for n in order:
        if n not in ref_rot or n not in E:
            continue
        eb = E[n]
        L = eb.length
        h = eb.head.copy()
        eb.matrix = Matrix.Translation(h) @ ref_rot[n].to_4x4()
        eb.length = L
    bpy.ops.object.mode_set(mode="OBJECT")
    for o in meshes:
        md = o.modifiers.new("Armature", "ARMATURE")
        md.object = arm
    # Report: residual rest differences.
    worst = max((math.degrees(b.matrix_local.to_3x3().to_quaternion().rotation_difference(ref_rot[b.name].to_quaternion()).angle), b.name) for b in arm.data.bones if b.name in ref_rot)
    print("rebind residual", worst)


def pixels(img, size, data=False):
    if max(img.size) > size:
        img.scale(size, size)
    w, h = img.size
    return np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4), w, h


def new_image(name, arr, alpha=False, non_color=False):
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=alpha)
    if non_color:
        # Before the pixels: switching the colour space later reloads (and blanks) a generated image.
        img.colorspace_settings.name = "Non-Color"
    img.pixels[:] = arr.ravel()
    img.pack()
    return img


def rebuild_materials(meshes, cid, size=2048):
    """glTF-ready materials: base colour (+alpha), normal, and an ORM map with roughness = 1 - glossiness."""
    done = {}
    for o in meshes:
        for slot in o.material_slots:
            m = slot.material
            if m is None or m.name in done:
                continue
            nt = m.node_tree
            links = {(l.to_node.name, l.to_socket.name): l for l in nt.links}
            src = {}
            for (node, sock), l in links.items():
                img = getattr(l.from_node, "image", None)
                if node == "Principled BSDF" and img is not None:
                    src[sock] = (img, l.from_socket.name)
                elif node == "Normal Map" and img is not None:
                    src["Normal"] = (img, "Color")
            lim = size if "hair" not in m.name.lower() and "lash" not in m.name.lower() else min(size, 1024)
            nm = bpy.data.materials.new(f"{cid}_{m.name}")
            nm.use_nodes = True
            t = nm.node_tree
            bsdf = t.nodes["Principled BSDF"]
            # Cut-out only for hair and lashes: Mixamo body textures carry unrelated data in their alpha (James's
            # body diffuse alpha is 0 over the face, which cut his face out and showed the inside of his hood).
            alpha = "Alpha" in src and bool(re.search(r"hair|lash", m.name, re.I))
            if "Base Color" in src:
                col, w, h = pixels(src["Base Color"][0], lim)
                if alpha:
                    aimg, sock = src["Alpha"]
                    a, _, _ = pixels(aimg, lim) if aimg.size[0] else (col, w, h)
                    if a.shape != col.shape:
                        a = col
                    # A separate opacity map often keeps its mask in RGB with a solid alpha channel.
                    use = a[..., 3] if a[..., 3].min() < 0.99 else a[..., 0]
                    col[..., 3] = use
                else:
                    col[..., 3] = 1
                tex = t.nodes.new("ShaderNodeTexImage")
                tex.image = new_image(f"{cid}_{m.name}_color", col, alpha=alpha)
                t.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
                if alpha:
                    t.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
            if "Normal" in src:
                nrm, _, _ = pixels(src["Normal"][0], lim, data=True)
                tex = t.nodes.new("ShaderNodeTexImage")
                tex.image = new_image(f"{cid}_{m.name}_normal", nrm, non_color=True)
                nmap = t.nodes.new("ShaderNodeNormalMap")
                t.links.new(tex.outputs["Color"], nmap.inputs["Color"])
                t.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
            if "Roughness" in src:
                g, w, h = pixels(src["Roughness"][0], min(lim, 1024), data=True)
                orm = np.ones_like(g)
                orm[..., 1] = np.clip(1.0 - g[..., 0], 0.25, 1.0)
                orm[..., 2] = 0.0
                tex = t.nodes.new("ShaderNodeTexImage")
                tex.image = new_image(f"{cid}_{m.name}_orm", orm, non_color=True)
                sep = t.nodes.new("ShaderNodeSeparateColor")
                t.links.new(tex.outputs["Color"], sep.inputs["Color"])
                t.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
                t.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
            else:
                bsdf.inputs["Roughness"].default_value = 0.7
                bsdf.inputs["Metallic"].default_value = 0.0
            done[m.name] = nm
        for slot in o.material_slots:
            if slot.material and slot.material.name in done:
                slot.material = done[slot.material.name]


def character(fbx, ref_fbx, out, meta_out):
    clear()
    ref, ref_objs, _ = import_fbx(ref_fbx)
    strip_names(ref)
    ref_rot = {b.name: b.matrix_local.to_3x3() for b in ref.data.bones}
    ref_hips = ref.data.bones["Hips"].head_local.length
    for o in ref_objs:
        bpy.data.objects.remove(o)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    arm, objs, acts = import_fbx(fbx)
    for a in acts:
        bpy.data.actions.remove(a)
    arm.animation_data_clear()
    meshes = [o for o in objs if o.type == "MESH"]
    strip_names(arm, meshes)
    if not os.environ.get("NO_REBIND"):
        rebind(arm, meshes, ref_rot)
    cid = os.path.splitext(os.path.basename(fbx))[0].lower()
    rebuild_materials(meshes, cid)
    if (arm.matrix_world @ arm.data.bones["Hips"].head_local).z > 1.5:
        s = REMY_HIPS / (arm.matrix_world @ arm.data.bones["Hips"].head_local).z
        arm.scale = arm.scale * s
        arm.location = arm.location * s
    bpy.context.view_layer.update()
    # Metres, Y-up after export: no rotation or scale left on the armature (meshes keep their modifiers).
    for o in meshes:
        for md in o.modifiers:
            if md.type == "ARMATURE":
                md.object = None
    mats = {o: o.matrix_world.copy() for o in meshes}
    for o in meshes:
        o.parent = None
        o.matrix_world = mats[o]
    apply_transforms([arm] + meshes)
    for o in meshes:
        o.parent = arm
        for md in o.modifiers:
            if md.type == "ARMATURE":
                md.object = arm
    bpy.context.view_layer.update()
    W = arm.matrix_world
    B = arm.data.bones
    hips = (W @ B["Hips"].head_local)
    head = (W @ B["Head"].head_local)
    top = (W @ B["HeadTop_End"].head_local) if "HeadTop_End" in B else head
    mn, mx = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for o in meshes:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn = Vector(map(min, mn, w))
            mx = Vector(map(max, mx, w))
    meta = {
        "id": cid,
        "height": round(mx.z - mn.z, 4),
        "hips": round(hips.z, 4),
        # Hips translation scale for the shared clips (both in metres): this character's hips over Remy's.
        "hipRatio": round(hips.z / REMY_HIPS, 5),
        "head": round(head.z, 4),
        "headTop": round(top.z, 4),
        "meshes": [{"name": o.name, "verts": len(o.data.vertices), "tris": sum(len(p.vertices) - 2 for p in o.data.polygons), "materials": [s.material.name for s in o.material_slots if s.material]} for o in meshes],
        "bones": len(B),
    }
    print("META", json.dumps(meta))
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    for o in meshes:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_skins=True, export_animations=False,
                              export_morph=False, export_yup=True, export_image_format="WEBP", export_image_quality=88, export_apply=False)
    with open(meta_out, "w") as f:
        json.dump(meta, f, indent=1)


# ------------------------------------------------------------------------------------------------------------ anims
# Mixamo's stair-descent takes are broken in two ways: their feet never go below the top floor (the swing foot
# "lands" at the height it left, so the hips' 0.47 m drop folds the legs into a squat), and they are shorter than one
# stride (they end feet together). Repair, per take, from one step: (first foot down at frame a, the other foot lifts
# at `lift` and is down at `land`, b ends the step; 1-based source frames):
#   1. the stepping leg is re-solved (two-bone, knee kept in its own plane, foot keeps its orientation) so its foot
#      starts on the step above (+h) and comes down onto the step below (-h); h = the hips' drop over the step, which
#      makes the hips' height over the newly planted foot at b equal that over the planted foot at a;
#   2. the stride is completed with the step's left/right mirror, continuing from where the first step ends;
#   3. then, like any climb, the linear drop is removed (reported as `rise`).
HALF_STEP = {
    "descending-stairs": (7, 21, 10, 20, "Right"),
    "descending-stairs-rootmotion": (7, 21, 10, 20, "Right"),
    "descending-stairs-run": (4, 9, 2, 9, "Right"),
}
SIDE = re.compile(r"^(Left|Right)")


def mirror_name(n):
    return SIDE.sub(lambda m: "Right" if m.group(1) == "Left" else "Left", n)


def solve_leg(m, side, off):
    """Two-bone IK on matrices dict m (armature space): move the foot by `off` (Vector), knee in its own plane."""
    up, lo, ft = m[f"{side}UpLeg"], m[f"{side}Leg"], m[f"{side}Foot"]
    H, K, F = up.translation.copy(), lo.translation.copy(), ft.translation.copy()
    T = F + off
    L1, L2 = (K - H).length, (F - K).length
    d = min(max((T - H).length, abs(L1 - L2) + 1e-3), L1 + L2 - 1e-4)
    u = (T - H).normalized()
    T = H + u * d
    w = (K - H) - u * (K - H).dot(u)
    if w.length < 1e-6:
        w = ((K - H).cross(F - H)).cross(u)
    w.normalize()
    ca = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)
    ca = max(-1.0, min(1.0, ca))
    K2 = H + u * (L1 * ca) + w * (L1 * math.sqrt(1 - ca * ca))
    q1 = (K - H).normalized().rotation_difference((K2 - H).normalized()).to_matrix()
    R_up = q1 @ up.to_3x3()
    R_lo = q1 @ lo.to_3x3()
    q2 = (q1 @ (F - K)).normalized().rotation_difference((T - K2).normalized()).to_matrix()
    R_lo = q2 @ R_lo
    m[f"{side}UpLeg"] = Matrix.Translation(H) @ R_up.to_4x4()
    m[f"{side}Leg"] = Matrix.Translation(K2) @ R_lo.to_4x4()
    shift = T - F
    for n in (f"{side}Foot", f"{side}ToeBase", f"{side}Toe_End"):
        if n in m:
            m[n] = Matrix.Translation(m[n].translation + shift) @ m[n].to_3x3().to_4x4()
    return (T - (F + off)).length


def half_mirror(arm, act, a, b, lift, land, side):
    """Rewrite `act` as the repaired step a..b followed by its mirror (frames a+1..b), starting at frame 1."""
    P = arm.pose.bones
    rest = {pb.name: pb.bone.matrix_local.to_3x3() for pb in P}
    ad = arm.animation_data
    ad.action = act
    if hasattr(ad, "action_slot") and len(act.slots):
        ad.action_slot = act.slots[0]
    S = Matrix.Diagonal((-1, 1, 1))
    frames = []
    for fr in range(a, b + 1):
        bpy.context.scene.frame_set(fr)
        bpy.context.view_layer.update()
        frames.append({pb.name: pb.matrix.copy() for pb in P})
    h0 = frames[0]["Hips"].translation.copy()
    h1 = frames[-1]["Hips"].translation.copy()
    h = h0.z - h1.z
    miss = 0.0
    for i, fr in enumerate(range(a, b + 1)):
        t = min(1.0, max(0.0, (fr - lift) / max(1, land - lift)))
        t = t * t * (3 - 2 * t)
        miss = max(miss, solve_leg(frames[i], side, Vector((0, 0, h * (1 - 2 * t)))))
    # The source sinks into a squat at mid-step (hips ~0.25 m lower over the supporting foot than in a walk). Lift
    # the whole body back toward a walking stance leg (hips at least 0.70 m above the lower ankle; a stair descent
    # still bends the knee) and re-solve both legs so the feet stay where they are.
    lifts = []
    for f in frames:
        low = min(f["LeftFoot"].translation.z, f["RightFoot"].translation.z)
        lifts.append(max(0.0, 0.70 - (f["Hips"].translation.z - low)))
    sm = [sum(lifts[max(0, i - 2): i + 3]) / len(lifts[max(0, i - 2): i + 3]) for i in range(len(lifts))]
    for f, lz in zip(frames, sm):
        if lz <= 0:
            continue
        up = Vector((0, 0, lz))
        for n in f:
            f[n] = Matrix.Translation(f[n].translation + up) @ f[n].to_3x3().to_4x4()
        for sd in ("Left", "Right"):
            miss = max(miss, solve_leg(f, sd, -up))
    print("stair repair", act.name, "step rise", round(h, 3), "max lift", round(max(sm), 3), "unreached", round(miss, 3))

    def mir_rot(f, name):
        mn = mirror_name(name) if mirror_name(name) in f else name
        D = f[mn].to_3x3() @ rest[mn].transposed()
        return (S @ D @ S @ rest[name]).to_quaternion()

    # Make the step mirror-continuous: the step's last pose must be the mirror of its first (and so the mirrored
    # step's first pose continues it, and its last closes the loop). Meet halfway, spreading the correction over
    # the step in armature space (rotations only; positions follow the hierarchy).
    first, last = frames[0], frames[-1]
    X = {n: last[n].to_quaternion().slerp(mir_rot(first, n), 0.5) for n in last}
    MX = {}
    for n in X:
        mn = mirror_name(n) if mirror_name(n) in X else n
        D = X[mn].to_matrix() @ rest[mn].transposed()
        MX[n] = (S @ D @ S @ rest[n]).to_quaternion()
    da = {n: MX[n] @ first[n].to_quaternion().inverted() for n in X}
    db = {n: X[n] @ last[n].to_quaternion().inverted() for n in X}
    k = len(frames) - 1
    for i, f in enumerate(frames):
        for n in f:
            q = da[n].slerp(db[n], i / k) @ f[n].to_quaternion()
            f[n] = Matrix.Translation(f[n].translation) @ q.to_matrix().to_4x4()
    out = list(frames)
    for f in frames[1:]:
        m = {}
        for name in f:
            src = f[mirror_name(name)] if mirror_name(name) in f else f[name]
            D = src.to_3x3() @ rest[mirror_name(name) if mirror_name(name) in rest else name].transposed()
            Dm = S @ D @ S
            R = Dm @ rest[name]
            # Positions: mirrored about the first step's start, then carried on from where the first step ended.
            p = S @ (src.translation - h0) + h1
            m[name] = Matrix.Translation(p) @ R.to_4x4()
        out.append(m)
    for fc in list(fcurves(act)):
        fc.keyframe_points.clear()
    order = order_of(arm)
    for i, m in enumerate(out):
        for name in order:
            pb = P[name]
            pb.matrix = m[name]
            bpy.context.view_layer.update()
            pb.keyframe_insert("rotation_quaternion", frame=i + 1)
            if name == "Hips":
                pb.keyframe_insert("location", frame=i + 1)
    act.frame_range = (1, len(out))
    print("half-mirror", act.name, a, b, "->", len(out), "frames")


def foot_contacts(foot, lin, n, stance_v, use_height=True):
    """Per foot, the stance intervals as [start, end] cycle phases (0..1; end > 1 when it wraps past the loop): the
    contact point (heel/ball midpoint) moves with the stance velocity `stance_v` (in-place clips: the ground sliding
    backwards under the body; ladder: the rungs moving down) within 0.35 m/s, and (on the ground) is within 4 cm of
    that foot's lowest height after removing any linear rise."""
    out = {}
    sv = np.array(stance_v, dtype=float)
    for k in "lr":
        P = np.array([[(a.x + b.x) / 2, (a.y + b.y) / 2, min(a.z, b.z) - lin[i][2]] for i, (a, b) in enumerate(foot[k])])[:n]
        m = len(P)
        V = (np.roll(P, -1, axis=0) - np.roll(P, 1, axis=0)) * 15  # central difference, 30 fps, wraps (loops)
        on = np.linalg.norm(V - sv, axis=1) < 0.35
        if use_height:
            on &= P[:, 2] < P[:, 2].min() + 0.04
        start = next((j for j in range(m) if not on[j]), None)
        if start is None:
            out[k] = [[0, 1]]
            continue
        iv = []
        j = 0
        while j < m:
            if on[(start + j) % m]:
                a = start + j
                while j < m and on[(start + j) % m]:
                    j += 1
                if j - (a - start) >= 2:
                    iv.append([round((a % m) / m, 3), round((a % m) / m + (start + j - a) / m, 3)])
            j += 1
        out[k] = sorted(iv)
    return out


# Clip id -> kind. loop: cyclic locomotion/idle; climb: loop with linear rise removed; one: one-shot (root path out).
CLIPS = {
    "breathing-idle": "idle", "walking": "loop", "walking-standard": "loop", "walking-backwards": "loop",
    "left-strafe-walking": "loop", "right-strafe-walking": "loop", "jog-forward": "loop", "jog-backward": "loop",
    "jog-strafe-left": "loop", "jog-strafe-right": "loop", "running": "loop", "crouch-idle": "idle",
    "crouching-idle": "idle", "crouched-walking": "loop", "crouch-walk-forward": "loop", "crouch-walk-back": "loop",
    "crouch-walk-left": "loop", "crouch-walk-right": "loop", "left-turn-90": "one", "right-turn-90": "one",
    "ascending-stairs": "climb", "ascending-stairs-alt": "climb",
    "descending-stairs": "climb", "descending-stairs-rootmotion": "climb", "descending-stairs-run": "climb",
    "climbing-ladder": "climb", "climbing-to-top": "one",
    "jump": "jump", "falling-idle": "idle", "opening-door-inwards": "one", "button-pushing": "one", "torch-idle": "idle",
    "torch-inspect-forward": "one", "torch-walk-forward": "loop",
}


def anims(src_dir, out, meta_out):
    clear()
    files = sorted(f for f in os.listdir(src_dir) if f.endswith(".fbx"))
    base = None
    actions = {}
    for f in files:
        cid = f[:-4]
        arm, objs, acts = import_fbx(os.path.join(src_dir, f))
        if not acts:
            print("no action in", f)
            continue
        act = acts[0]
        strip_action(act)
        act.name = cid
        act.use_fake_user = True
        if base is None:
            base = arm
            base.name = "Anims"
            strip_names(base)
            base.animation_data_clear()
            for o in objs:
                if o is not base:
                    bpy.data.objects.remove(o)
        else:
            for o in objs:
                bpy.data.objects.remove(o)
        for a in acts[1:]:
            bpy.data.actions.remove(a)
        actions[cid] = act
    arm = base
    # Scale to metres at Remy's character size and bake the armature's rotation/scale away; pose locations are in
    # bone space, so their keys take the scale by hand.
    k = REMY_HIPS / (arm.matrix_world @ arm.data.bones["Hips"].head_local).z
    total = arm.matrix_world.to_scale().x * k
    arm.scale = arm.scale * k
    bpy.context.view_layer.update()
    apply_transforms([arm])
    for act in actions.values():
        for fc in fcurves(act):
            if fc.data_path.endswith(".location"):
                for kp in fc.keyframe_points:
                    kp.co.y *= total
                    kp.handle_left.y *= total
                    kp.handle_right.y *= total
    print("anim scale", total)
    W = arm.matrix_world
    Wi = W.inverted()
    ref_hips = (W @ arm.data.bones["Hips"].head_local).z
    meta = {"refHips": round(ref_hips, 5), "fps": 30, "clips": {}}
    ad = arm.animation_data_create()
    P = arm.pose.bones
    for pb in P:
        pb.rotation_mode = "QUATERNION"
    feet = {"l": ("LeftFoot", "LeftToeBase"), "r": ("RightFoot", "RightToeBase")}
    rest_foot = {k: min((W @ arm.data.bones[b].head_local).z for b in v) for k, v in feet.items()}

    for cid, act in actions.items():
        kind = CLIPS.get(cid, "one")
        if cid in HALF_STEP:
            half_mirror(arm, act, *HALF_STEP[cid])
            info_step = None
        ad.action = act
        if hasattr(ad, "action_slot") and len(act.slots):
            ad.action_slot = act.slots[0]
        f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
        frames = list(range(f0, f1 + 1))
        H, foot = [], {"l": [], "r": []}
        for fr in frames:
            bpy.context.scene.frame_set(fr)
            bpy.context.view_layer.update()
            H.append((W @ P["Hips"].matrix).copy())
            for k, (a, b) in feet.items():
                pa = W @ P[a].head
                pb_ = W @ P[b].head
                foot[k].append((pa.copy(), pb_.copy()))
        n = len(frames) - 1
        T = n / 30.0
        hp = np.array([list(m.translation) for m in H])
        # Facing yaw of the hips (rest faces -Y in Blender world).
        def yaw_of(m):
            f = m.to_3x3() @ H0inv @ Vector((0, -1, 0))
            return math.atan2(f.x, -f.y)
        H0inv = H[0].to_3x3().inverted() @ Matrix.Identity(3)
        # Relative to the clip's first frame facing: yaw 0 at frame 0.
        yaws = np.unwrap([yaw_of(m) for m in H])
        info = {"kind": kind, "frames": n + 1, "duration": round(T, 4),
                # Loops wrap (last frame == first); everything is in place in the glb (see "root"/"rise"/"speed").
                "loop": kind in ("loop", "idle", "climb"), "inPlace": True}
        travel = hp[-1] - hp[0]
        new_H = None
        if kind in ("loop", "idle", "climb", "jump", "broken"):
            lin = np.outer(np.arange(n + 1) / max(n, 1), travel)
            if kind != "climb":
                lin[:, 2] = 0
            if kind == "jump":
                lin[:] = 0
            new_H = [Matrix.Translation(Vector(-lin[i])) @ H[i] for i in range(n + 1)]
            # Ground velocity: hips travel minus the planted foot's own motion (in-place clips move the foot back).
            v_trav = travel[:2] / T if T > 0 else np.zeros(2)
            vs = []
            for k in "lr":
                pts = np.array([[min(a.z, b.z), (a.x + b.x) / 2, (a.y + b.y) / 2] for a, b in foot[k]])
                low = pts[:, 0].min()
                for i in range(n):
                    if pts[i, 0] < low + 0.04 and pts[i + 1, 0] < low + 0.04:
                        vs.append((pts[i + 1, 1:] - pts[i, 1:]) * 30)
            if vs:
                fv = np.median(np.array(vs), axis=0)
            else:
                fv = np.zeros(2)
            g = v_trav - fv  # ground velocity in Blender world (x, y); forward is -y
            info["velocity"] = [round(float(-g[0]), 4), round(float(-g[1]), 4)]  # three/glTF: +x left?, see body
            info["speed"] = round(float(np.linalg.norm(g)), 4)
            info["travel"] = [round(float(x), 4) for x in travel]
            info["rise"] = round(float(travel[2] / T), 4) if kind == "climb" else 0
            if cid == "climbing-ladder":
                # In place on the rungs: the climb rate is how fast the gripping foot moves down past the body.
                vz = [min(foot["l"][i + 1][0].z - foot["l"][i][0].z, foot["r"][i + 1][0].z - foot["r"][i][0].z) * 30 for i in range(n)]
                info["rise"] = round(float(-np.median(vz)), 4)
                info["velocity"] = [0, 0]
                info["speed"] = 0
            info["yawTotal"] = round(math.degrees(yaws[-1] - yaws[0]), 1)
            if kind in ("loop", "climb"):
                if cid == "climbing-ladder":
                    info["contacts"] = foot_contacts(foot, lin, n, (0, 0, -info["rise"]), use_height=False)
                elif kind == "climb":
                    info["contacts"] = foot_contacts(foot, lin, n, (fv[0], fv[1], -travel[2] / T), use_height=False)
                else:
                    info["contacts"] = foot_contacts(foot, lin, n, (fv[0], fv[1], 0))
            if kind == "jump":
                lowest = np.array([min(min(a.z, b.z) for a, b in (foot["l"][i], foot["r"][i])) for i in range(n + 1)])
                air = lowest > lowest.min() + 0.05
                idx = np.where(air)[0]
                if len(idx):
                    info["takeoff"] = round(float(idx[0] / 30), 4)
                    info["land"] = round(float(idx[-1] / 30), 4)
        else:
            # One-shot: horizontal root path and yaw out to the meta; the Hips keep the rest.
            root = []
            new_H = []
            for i in range(n + 1):
                d = hp[i] - hp[0]
                # Height stays in the Hips (the body scrubs the climb onto the top by its hips' rise).
                dz = 0
                R = Matrix.Translation(Vector((d[0], d[1], dz))) @ Matrix.Translation(Vector(hp[0])) @ Matrix.Rotation(yaws[i] - yaws[0], 4, "Z") @ Matrix.Translation(-Vector(hp[0]))
                new_H.append(R.inverted() @ H[i])
                # Stored in three space (x, z) with glTF axes: Blender x -> x, Blender y -> -z.
                # [x, z, yaw, y] in three space (glTF axes: Blender x -> x, Blender y -> -z, Blender z -> y).
                root.append([round(float(d[0]), 4), round(float(-d[1]), 4), round(float(yaws[i] - yaws[0]), 4), round(float(dz), 4)])
            info["root"] = root
            info["yawTotal"] = round(math.degrees(yaws[-1] - yaws[0]), 1)
            info["travel"] = [round(float(x), 4) for x in travel]
        if kind in ("loop", "idle", "climb", "jump", "broken"):
            # Centre the body over the origin: some takes stand metres away (the ladder clip's hips sit 2 m to the
            # side). Keep the cyclic sway about the mean, remove the mean offset from the rest position.
            rest_h = (W @ arm.data.bones["Hips"].head_local)
            mx_ = sum(m_.translation.x for m_ in new_H) / len(new_H) - rest_h.x
            my_ = sum(m_.translation.y for m_ in new_H) / len(new_H) - rest_h.y
            for m_ in new_H:
                m_.translation.x -= mx_
                m_.translation.y -= my_
            info["centred"] = [round(mx_, 3), round(my_, 3)]
        if kind == "jump":
            # The controller flies the body; keep the clip's crouch and landing dips but not its own leap.
            z0 = new_H[0].translation.z
            for m_ in new_H:
                if m_.translation.z > z0:
                    m_.translation.z = z0
        if cid == "climbing-ladder":
            # Hang the clip from the feet: its lowest foot at the floor (the controller's position is the feet).
            lows = []
            for i in range(n + 1):
                lows.append(min(min(a.z, b.z) for a, b in (foot["l"][i], foot["r"][i])))
            dz = min(lows) - min(rest_foot.values())
            for m_ in new_H:
                m_.translation.z -= dz
            info["shift"] = round(-dz, 4)
        # Rewrite the Hips keys every frame.
        for fc in list(fcurves(act)):
            if fc.data_path in ('pose.bones["Hips"].location', 'pose.bones["Hips"].rotation_quaternion', 'pose.bones["Hips"].rotation_euler'):
                fc.keyframe_points.clear()
        pb = P["Hips"]
        prev_q = None
        for i, fr in enumerate(frames):
            pb.matrix = Wi @ new_H[i]
            bpy.context.view_layer.update()
            q = pb.rotation_quaternion.copy()
            if prev_q is not None and q.dot(prev_q) < 0:
                q.negate()
                pb.rotation_quaternion = q
            prev_q = q
            pb.keyframe_insert("location", frame=fr)
            pb.keyframe_insert("rotation_quaternion", frame=fr)
        # Loops: spread any end-vs-start rotation mismatch over the clip so the wrap is seamless (Mixamo loops mostly
        # repeat their first frame exactly; jog-strafe-right and climbing-ladder are 8° off at the seam).
        if kind in ("loop", "idle", "climb"):
            worst = 0.0
            for pb_ in P:
                if pb_.name == "Hips":
                    continue
                path = f'pose.bones["{pb_.name}"].rotation_quaternion'
                fcs = [fc for fc in fcurves(act) if fc.data_path == path]
                if len(fcs) != 4:
                    continue
                fcs.sort(key=lambda fc: fc.array_index)
                qs = [Quaternion([fc.evaluate(fr) for fc in fcs]).normalized() for fr in frames]
                d = qs[-1].inverted() @ qs[0]
                ang_ = math.degrees(d.angle) if d.angle < math.pi else 360 - math.degrees(d.angle)
                if ang_ > 10:
                    print("  seam", cid, pb_.name, round(ang_, 1))
                worst = max(worst, ang_)
                if d.angle < 1e-4:
                    continue
                for fc in fcs:
                    fc.keyframe_points.clear()
                prev = None
                for i, fr in enumerate(frames):
                    q = qs[i] @ Quaternion().slerp(d, i / max(n, 1))
                    if prev is not None and q.dot(prev) < 0:
                        q.negate()
                    prev = q
                    for k_, fc in enumerate(fcs):
                        fc.keyframe_points.insert(fr, q[k_], options={"FAST"})
            info["seamFixed"] = round(worst, 2)
        meta["clips"][cid] = info
        print("CLIP", cid, json.dumps({k: v for k, v in info.items() if k != "root"}))
    ad.action = None
    for pb in P:
        pb.location = Vector()
        pb.rotation_quaternion = Quaternion()
    # Export: one NLA track per clip.
    for cid, act in sorted(actions.items()):
        tr = ad.nla_tracks.new()
        tr.name = cid
        st = tr.strips.new(cid, int(act.frame_range[0]), act)
        if hasattr(st, "action_slot") and st.action_slot is None and len(act.slots):
            st.action_slot = act.slots[0]
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_animations=True,
                              export_animation_mode="NLA_TRACKS", export_force_sampling=True, export_yup=True,
                              export_anim_slide_to_zero=True,
                              export_skins=False, export_apply=False)
    with open(meta_out, "w") as f:
        json.dump(meta, f, indent=1)


if mode == "character":
    character(*argv[1:5])
elif mode == "anims":
    anims(*argv[1:4])
