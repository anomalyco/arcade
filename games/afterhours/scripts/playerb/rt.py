# Rest-pose alignment and offline retargeting onto the janitor's own skeleton (run inside Blender by build.py).
#
# The janitor keeps his natural MakeHuman bind pose (arms in an A-pose, elbows soft), which is what his skin weights
# were made for; clips from T-pose sources are transferred as world-space rotation deltas from the source rest,
#     G_target = D_source · A · R_target_rest
# where A turns each target rest bone onto the source's rest bone: limbs by direction plus a secondary axis that pins
# the twist (the elbow hinge for the upper arm, the palm for the forearm and hand), the trunk, neck and clavicles
# unchanged (both rests stand upright; their joints sit at different anatomical points so their directions differ).
import math

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

FINGERS = ("thumb", "index", "middle", "ring", "pinky")
TRUNK = ("pelvis", "spine", "neck", "Head", "clavicle", "root")


def aim_map(names):
    aim = {"pelvis": "spine_01", "spine_01": "spine_02", "spine_02": "spine_03", "spine_03": "neck_01", "neck_01": "Head"}
    for s in "lr":
        aim.update({f"clavicle_{s}": f"upperarm_{s}", f"upperarm_{s}": f"lowerarm_{s}", f"lowerarm_{s}": f"hand_{s}",
                    f"hand_{s}": f"middle_01_{s}", f"thigh_{s}": f"calf_{s}", f"calf_{s}": f"foot_{s}",
                    f"foot_{s}": f"ball_{s}", f"ball_{s}": f"ball_leaf_{s}"})
        for f in FINGERS:
            for i in (1, 2, 3):
                aim[f"{f}_0{i}_{s}"] = f"{f}_0{i + 1}_{s}" if i < 3 else f"{f}_04_leaf_{s}"
    return {k: v for k, v in aim.items() if k in names and v in names}


def frame(p, s):
    p = p.normalized()
    s = (s - p * s.dot(p)).normalized()
    return Matrix((p, s, p.cross(s))).transposed()


def align(p0, s0, p1, s1):
    return frame(p1, s1) @ frame(p0, s0).transposed()


def target_rest(arm):
    bones = arm.data.bones
    return ({b.name: b.matrix_local.to_3x3() for b in bones}, {b.name: Vector(b.head_local) for b in bones},
            {b.name: Vector(b.tail_local) for b in bones}, {b.name: (b.parent.name if b.parent else None) for b in bones})


def rest_alignment(arm, src_dir, src_across=None):
    """A per target bone. src_dir(bone) -> source rest direction (armature space) or None; src_across(side) -> the
    source rest palm across-vector (index -> little finger knuckles) for that side, default T-pose palm down (+Y)."""
    R, H, T, parent = target_rest(arm)
    aim = aim_map(set(H))
    A = {}
    for t in H:
        A[t] = Matrix.Identity(3)
        if t.startswith(TRUNK):
            continue
        d_s = src_dir(t)
        if d_s is None:
            continue
        d_t = (H[aim[t]] - H[t]).normalized() if t in aim else (T[t] - H[t]).normalized()
        d_s = d_s.normalized()
        side = t[-1]
        if t.startswith("upperarm_"):
            fore_t = (H[f"hand_{side}"] - H[f"lowerarm_{side}"]).normalized()
            hinge_t = d_t.cross(fore_t)
            fore_s = src_dir(f"lowerarm_{side}")
            hinge_s = d_s.cross(fore_s.normalized()) if fore_s is not None and d_s.cross(fore_s.normalized()).length > 0.2 else d_s.cross(Vector((0, -1, 0)))
            A[t] = align(d_t, hinge_t, d_s, hinge_s)
        elif t.startswith(("lowerarm_", "hand_")):
            across_t = (H[f"pinky_01_{side}"] - H[f"index_01_{side}"])
            across_s = src_across(side) if src_across else Vector((0, 1, 0))
            A[t] = align(d_t, across_t, d_s, across_s)
        else:
            A[t] = d_t.rotation_difference(d_s).to_matrix()
    return A


def relaxed_hand(arm, curl=(24, 38, 22), thumb=(8, 16, 14), close=0.65):
    """Rest-relative local rotations for a relaxed hand: the fingers drawn together (their splay toward the middle
    finger reduced by `close`), then flexed at each joint about the knuckle axis, a little more toward the little
    finger; the thumb flexed about its own axis toward the palm."""
    R, H, T, parent = target_rest(arm)
    out = {}
    for s in "lr":
        across = (H[f"pinky_01_{s}"] - H[f"index_01_{s}"]).normalized()
        mid = (H[f"middle_02_{s}"] - H[f"middle_01_{s}"]).normalized()
        palm = mid.cross(across).normalized()
        if (H[f"middle_03_{s}"] - H[f"middle_01_{s}"]).dot(palm) < 0:
            palm = -palm
        for k, f in enumerate(FINGERS):
            acc = Matrix.Identity(3)
            for i in (1, 2, 3):
                b = f"{f}_0{i}_{s}"
                if b not in R:
                    continue
                d = (T[b] - H[b]).normalized()
                q = Matrix.Identity(3)
                if i == 1 and f not in ("thumb", "middle"):
                    # Splay: angle from the middle finger's direction about the palm normal.
                    dp = (d - palm * d.dot(palm)).normalized()
                    ang = math.atan2(mid.cross(dp).dot(palm), mid.dot(dp))
                    q = Matrix.Rotation(-ang * close, 3, palm)
                ax = across if f != "thumb" else d.cross(palm).normalized()
                deg = (thumb if f == "thumb" else curl)[i - 1] * (1 + 0.15 * max(0, k - 1))
                dd = q @ d
                sg = 1 if (Matrix.Rotation(0.1, 3, ax) @ dd).dot(palm) > dd.dot(palm) else -1
                q = Matrix.Rotation(math.radians(deg) * sg, 3, ax) @ q
                # Local rotation of this bone relative to its (already rotated) parent, in the rest frame.
                w = q  # world delta for this bone on top of the parent's
                acc_new = w @ acc
                out[b] = (R[b].transposed() @ acc.transposed() @ acc_new @ R[b]).to_quaternion()
                acc = acc_new
    return out


def write_action(arm, name, G_frames, pelvis_world, fps, loop=True, local_extra=None):
    """Key an action from per-frame armature-space bone rotations (dict bone -> 3x3 numpy) for the mapped bones;
    other bones keep their rest relation to the parent times `local_extra[bone]` (rest-relative quaternion).
    pelvis_world: per-frame armature-space pelvis head positions."""
    R, H, T, parent = target_rest(arm)
    order = []

    def walk(b):
        order.append(b.name)
        for c in b.children:
            walk(c)

    walk(next(b for b in arm.data.bones if b.parent is None))
    n = len(G_frames) - 1
    basis = []
    for Gm in G_frames:
        G = {}
        B = {}
        for t in order:
            p = parent[t]
            Rt = np.array(R[t])
            Rp = np.array(R[p]) if p else np.eye(3)
            if t in Gm:
                g = Gm[t]
            else:
                gp = G[p] if p else np.eye(3)
                loc = np.array(local_extra[t].to_matrix()) if local_extra and t in local_extra else np.eye(3)
                g = gp @ Rp.T @ Rt @ loc
            G[t] = g
            gp = G[p] if p else np.eye(3)
            B[t] = Matrix((Rt.T @ Rp @ gp.T @ g).tolist()).to_quaternion()
        basis.append(B)
    if loop and n > 1:
        for t in order:
            d = basis[n][t].inverted() @ basis[0][t]
            for i in range(n + 1):
                basis[i][t] = basis[i][t] @ Quaternion().slerp(d, i / n)
        pw = [np.array(p) for p in pelvis_world]
        drift = pw[0] - pw[n]
        pelvis_world = [pw[i] + drift * (i / n) for i in range(n + 1)]
    Mr = arm.data.bones["pelvis"].matrix_local
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    ad = arm.animation_data or arm.animation_data_create()
    prev = ad.action
    ad.action = act
    sfps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    for i in range(n + 1):
        f = 1 + i * sfps / fps
        for t in order:
            pb = arm.pose.bones[t]
            pb.rotation_mode = "QUATERNION"
            q = basis[i][t]
            if i and q.dot(basis[i - 1][t]) < 0:
                q.negate()
                basis[i][t] = q
            pb.rotation_quaternion = q
            pb.keyframe_insert("rotation_quaternion", frame=f)
        pb = arm.pose.bones["pelvis"]
        pb.location = Mr.to_3x3().inverted() @ (Vector(tuple(pelvis_world[i])) - Mr.translation)
        pb.keyframe_insert("location", frame=f)
    ad.action = prev
    for pb in arm.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()
    return act


def retarget_armature_action(arm, src, action, name, hip_ratio, fps=60, local_extra=None, loop=True):
    """Bake `action` (on source armature `src`, T-pose rest, same bone names) onto `arm` by world rest deltas."""
    Rs = {b.name: b.matrix_local.to_3x3() for b in src.data.bones}
    Hs = {b.name: Vector(b.head_local) for b in src.data.bones}
    Ts = {b.name: Vector(b.tail_local) for b in src.data.bones}
    aim_s = aim_map(set(Hs))
    names_t = {b.name for b in arm.data.bones}

    def src_dir(t):
        if t not in Hs:
            return None
        return (Hs[aim_s[t]] - Hs[t]) if t in aim_s else (Ts[t] - Hs[t])

    A = rest_alignment(arm, src_dir, lambda s: Hs[f"pinky_01_{s}"] - Hs[f"index_01_{s}"])
    R, H, T, parent = target_rest(arm)
    ad = src.animation_data or src.animation_data_create()
    prev = ad.action
    ad.action = action
    if hasattr(ad, "action_slot") and ad.action_slot is None and len(action.slots):
        ad.action_slot = action.slots[0]
    sfps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    f0, f1 = action.frame_range
    n = max(1, round((f1 - f0) / sfps * fps))
    frames, pel = [], []
    rest_pel = Hs["pelvis"]
    for i in range(n + 1):
        ft = f0 + i * (f1 - f0) / n
        bpy.context.scene.frame_set(int(math.floor(ft)), subframe=ft - math.floor(ft))
        bpy.context.view_layer.update()
        G = {}
        for t in names_t:
            if t not in Rs or t == "root":
                continue
            pb = src.pose.bones[t]
            D = np.array(pb.matrix.to_3x3() @ Rs[t].transposed())
            G[t] = D @ np.array(A[t]) @ np.array(R[t])
        p = src.pose.bones["pelvis"].matrix.translation
        pel.append(np.array(H["pelvis"]) + (np.array(p) - np.array(rest_pel)) * hip_ratio)
        frames.append(G)
    ad.action = prev
    return write_action(arm, name, frames, pel, fps, loop=loop, local_extra=local_extra)
