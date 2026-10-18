# Authored one-handed flashlight carry for the janitor's right arm, keyed as single-pose actions on the UAL skeleton
# (run inside Blender by build.py). Each pose is written as arm directions in armature space (Blender: +X left,
# -Y forward, +Z up), turned into bone rotations by two-vector frames, so the elbow bends on its own hinge, the
# forearm carries the pronation and the wrist stays straight (a little ulnar deviation, as a real grip has).
#
#   Carry_Level / Carry_Up / Carry_Down   walking carry, beam level / raised / lowered (an aim-offset set)
#   Carry_Run                             running carry: forearm higher, elbow tighter
#   Carry_Crouch                          crouched carry: arm forward, hand above the knees
#
# The grip (centre of the fist, barrel axis) goes to clips.json as a model-space rest matrix; the barrel lies
# lying diagonally across the palm (heel of the hand to between thumb and index) and exiting on the thumb side.
import math

import bpy
from mathutils import Matrix, Quaternion, Vector

ARM = ["upperarm_r", "lowerarm_r", "hand_r"]
FINGERS = ["index", "middle", "ring", "pinky"]

# Pose parameters (degrees):
#   flex   upper arm swung forward from hanging          abd    upper arm out from the side
#   pron   forearm pronation from thumb-up               beam   torch pitch (straight ahead, 4° toward the midline)
# The barrel crosses the palm obliquely (power grip); the hand is turned so the barrel points along the beam and the
# forearm follows the hand with ULNAR° of ulnar deviation (the wrist neither flexed nor extended).
POSES = {
    "Carry_Level": dict(flex=-2, abd=20, pron=34, beam=-6),
    "Carry_Up": dict(flex=10, abd=20, pron=30, beam=30),
    "Carry_Down": dict(flex=8, abd=21, pron=40, beam=-34),
    # Crouched (UAL crouch: trunk pitched ~50° forward): in the trunk frame the arm reaches forward and the beam
    # points up, so in the world the hand is in front of the knees and the beam slightly down.
    "Carry_Crouch": dict(flex=105, abd=18, pron=30, beam=62),
    "Carry_Run": dict(flex=2, abd=20, pron=34, beam=4),
}
TUNNEL = 44  # barrel vs hand axis in a power grip
ULNAR = 22  # ulnar deviation of a hand gripping a torch (anatomical max ~30-35°); no flexion/extension


def frame(p, s):
    p = p.normalized()
    s = (s - p * s.dot(p)).normalized()
    return Matrix((p, s, p.cross(s))).transposed()


def align(p0, s0, p1, s1):
    return frame(p1, s1) @ frame(p0, s0).transposed()


def rad(d):
    return math.radians(d)


def wrap_hand(H, parent, A, C, Rb, palm, across, hand_dir):
    """Rest-frame (unposed hand) digit rotations around a barrel of radius Rb (axis through A, direction C). Fingers
    flex about the knuckle axis toward the palm, each joint by the smallest angle (within its range) that brings the
    next joint onto the barrel surface (pads touching), never into it. The thumb opposes as far as it can without
    entering the barrel, then flexes over it to the surface. Returns ({bone: 3x3 rest-frame rotation}, {joint: rest-frame position})."""
    F = {}
    pos = {}

    def dist(p):
        d = p - A
        return (d - C * d.dot(C)).length

    for fn in FINGERS:
        chain = [f"{fn}_0{i}_r" for i in (1, 2, 3)] + [f"{fn}_04_leaf_r"]
        off0 = H[chain[1]] - H[chain[0]]
        sense = 1 if across.cross(off0).dot(palm) > 0 else -1
        acc = Matrix.Identity(3)
        pos[chain[0]] = H[chain[0]].copy()
        for i in range(3):
            b, c = chain[i], chain[i + 1]
            off = acc @ (H[c] - H[b])
            target = Rb + 0.0085
            limit = (85, 100, 70)[i]
            e0 = dist(pos[b] + off) - target
            best = 0.0
            if e0 < 0:
                # Already inside the barrel: extend (open) the joint until the next joint is clear.
                for step in range(0, 160):
                    ang = -rad(step * 0.25) * sense
                    if dist(pos[b] + Matrix.Rotation(ang, 3, across) @ off) - target >= 0:
                        best = ang
                        break
            else:
                err = 1e9
                for step in range(0, limit * 4 + 1):
                    ang = rad(step * 0.25) * sense
                    e = dist(pos[b] + Matrix.Rotation(ang, 3, across) @ off) - target
                    if e <= 0:
                        best = ang
                        break
                    if e < err:
                        best, err = ang, e
            q = Matrix.Rotation(best, 3, across)
            acc = q @ acc
            F[b] = acc.copy()
            pos[c] = pos[b] + q @ off
        # If the fingertip still ends inside the barrel, open the PIP joint until the tip clears it.
        for _ in range(240):
            if dist(pos[chain[3]]) >= Rb + 0.007:
                break
            back = Matrix.Rotation(-rad(0.5) * sense, 3, across)
            F[chain[1]] = back @ F[chain[1]]
            F[chain[2]] = back @ F[chain[2]]
            for k in (2, 3):
                pos[chain[k]] = pos[chain[1]] + back @ (pos[chain[k]] - pos[chain[1]])
    # Thumb: each joint turns (about two axes: across the thumb and the palm normal, ±60°) to put the next joint as
    # close to the barrel surface as it can get without entering it, preferring the smaller rotation; the CMC joint
    # first brings the thumb round in opposition.
    t = ["thumb_01_r", "thumb_02_r", "thumb_03_r", "thumb_04_leaf_r"]
    acc = Matrix.Identity(3)
    pos[t[0]] = H[t[0]].copy()
    for i in range(3):
        b, c = t[i], t[i + 1]
        off = acc @ (H[c] - H[b])
        d = off.normalized()
        ax1 = d.cross(palm).normalized()
        ax2 = palm
        target = Rb + 0.009
        best, bq = 1e9, Matrix.Identity(3)
        rng = 60 if i == 0 else 75
        for a1 in range(-rng, rng + 1, 3):
            for a2 in range(-45, 46, 3):
                q = Matrix.Rotation(rad(a2), 3, ax2) @ Matrix.Rotation(rad(a1), 3, ax1)
                p1 = pos[b] + q @ off
                e = dist(p1) - target
                # Also keep the rest of the (still unbent) thumb outside.
                rest_out = all(dist(p1 + q @ acc @ (H[t[k]] - H[c])) >= target - 0.002 for k in range(i + 2, 4))
                cost = (abs(e) if e >= 0 else 10 + abs(e)) + (0 if rest_out else 5) + (abs(a1) + abs(a2)) * 0.00004
                if cost < best:
                    best, bq = cost, q
        acc = bq @ acc
        F[b] = acc.copy()
        pos[c] = pos[b] + bq @ off
    return F, pos


def author_carry(arm):
    bones = arm.data.bones
    R = {b.name: b.matrix_local.to_3x3() for b in bones}
    H = {b.name: Vector(b.head_local) for b in bones}
    parent = {b.name: (b.parent.name if b.parent else None) for b in bones}

    hand_dir0 = (H["middle_01_r"] - H["hand_r"]).normalized()
    across0 = (H["pinky_01_r"] - H["index_01_r"]).normalized()
    # Palm normal (out of the palm). T-pose palms face down (-Z).
    palm0 = hand_dir0.cross(across0).normalized()
    if palm0.z > 0:
        palm0 = -palm0

    # Barrel in the rest hand: below the palm by its radius plus the palm's soft tissue, running diagonally from the
    # heel of the hand on the little-finger side to the base of the index finger, exiting between thumb and index.
    Rb = 0.0172
    depth = Rb + 0.019
    # Power grip: the barrel crosses the palm obliquely, TUNNEL° from the hand's long axis toward the thumb, under the
    # bases of the proximal phalanges (between the index and middle knuckles, a little proximal).
    C = (hand_dir0 * math.cos(rad(TUNNEL)) - across0 * math.sin(rad(TUNNEL))).normalized()
    A = (H["index_01_r"] + H["middle_01_r"]) * 0.5 + palm0 * depth - hand_dir0 * 0.012
    F, fpos = wrap_hand(H, parent, A, C, Rb, palm0, across0, hand_dir0)
    mid = fpos["middle_01_r"]
    centre = A + C * (mid - A).dot(C)

    out = {}
    for name, P in POSES.items():
        f, a = rad(P["flex"]), rad(P["abd"])
        upper = Vector((-math.sin(a), -math.sin(f) * math.cos(a), -math.cos(f) * math.cos(a))).normalized()
        bp = rad(P["beam"])
        beam = Vector((math.sin(rad(4)) * math.cos(bp), -math.cos(rad(4)) * math.cos(bp), math.sin(bp))).normalized()
        pr = rad(P["pron"])
        # Palm faces the body's midline (+X for the right hand), turned down by the pronation.
        n1 = Vector((math.cos(pr), 0, -math.sin(pr)))
        Qh = align(C, palm0, beam, n1)
        hand = Qh @ hand_dir0
        palm = Qh @ palm0
        # Forearm: the hand sits in ULNAR° of ulnar deviation (toward the little finger), so the forearm is turned
        # that much toward the thumb side in the palm plane.
        radial = -(Qh @ across0)
        cands = [Matrix.Rotation(rad(ULNAR) * sg, 3, palm) @ hand for sg in (1, -1)]
        fore = max(cands, key=lambda v: v.dot(radial)).normalized()
        across = (Qh @ across0)
        across = (across - fore * across.dot(fore)).normalized()
        hinge = upper.cross(fore).normalized()

        G = {n: R[n].copy() for n in bones.keys()}
        p0 = (H["lowerarm_r"] - H["upperarm_r"]).normalized()
        G["upperarm_r"] = align(p0, p0.cross(Vector((0, -1, 0))), upper, hinge) @ R["upperarm_r"]
        p0 = (H["hand_r"] - H["lowerarm_r"]).normalized()
        G["lowerarm_r"] = align(p0, across0, fore, across) @ R["lowerarm_r"]
        G["hand_r"] = Qh @ R["hand_r"]
        for b, M in F.items():
            G[b] = Qh @ M @ R[b]
        wrist = math.degrees(hand.angle(fore))

        keyed = ARM + [f"{fn}_0{i}_r" for fn in FINGERS + ["thumb"] for i in (1, 2, 3)]
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        ad = arm.animation_data or arm.animation_data_create()
        prev = ad.action
        ad.action = act
        for b in keyed:
            p = parent[b]
            local = R[b].transposed() @ R[p] @ G[p].transposed() @ G[b]
            pb = arm.pose.bones[b]
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = local.to_quaternion()
            for fr in (1, 2):
                pb.keyframe_insert("rotation_quaternion", frame=fr)
        ad.action = prev
        for pb in arm.pose.bones:
            pb.rotation_quaternion = Quaternion()

        pos = {"upperarm_r": H["upperarm_r"]}
        for b in ["lowerarm_r", "hand_r"]:
            p = parent[b]
            pos[b] = pos[p] + G[p] @ R[p].transposed() @ (H[b] - H[p])
        out[name] = {
            "elbow_flexion": round(math.degrees(upper.angle(fore)), 1),
            "hand_height": round(pos["hand_r"].z, 3),
            "hand_forward": round(-(pos["hand_r"].y - H["spine_03"].y), 3),
            "beam_pitch": round(math.degrees(math.asin(max(-1, min(1, beam.z)))), 1),
            "wrist_bend": round(wrist, 1),
        }
        print("carry", name, out[name])

    # The grip point: hand-local, from the rest-frame barrel (identical in every pose, the hand carries it).
    rest_hand = Matrix.Translation(H["hand_r"]) @ R["hand_r"].to_4x4()
    z = palm0.cross(C).normalized()
    x = C.cross(z).normalized()
    M_grip = Matrix.Translation(centre) @ Matrix((x, C, z)).transposed().to_4x4()
    grip = bpy.data.objects.new("torch_grip", None)
    bpy.context.scene.collection.objects.link(grip)
    grip.parent = arm
    grip.parent_type = "BONE"
    grip.parent_bone = "hand_r"
    bpy.context.view_layer.update()
    grip.matrix_world = arm.matrix_world @ M_grip
    for fn in FINGERS + ["thumb"]:
        print("  digit", fn, [round(math.degrees(F[f"{fn}_0{i}_r"].to_quaternion().angle)) for i in (1, 2, 3)],
              "tip-to-barrel mm", round(((fpos[f"{fn}_04_leaf_r"] - A) - C * (fpos[f"{fn}_04_leaf_r"] - A).dot(C)).length * 1000 - Rb * 1000))
    # The grip as a model-space (glTF, Y up) rest matrix for the runtime: columns x, barrel (-Z in three: the lens
    # side), up; rows converted Blender (x, y, z) -> glTF (x, z, -y).
    cv = lambda v: [v.x, v.z, -v.y]  # noqa: E731
    out["grip"] = {"pos": cv(centre), "x": cv(x), "barrel": cv(C), "z": cv(z)}
    print("grip", tuple(round(v, 3) for v in (rest_hand.inverted() @ M_grip).translation), "fingers",
          {b: round(math.degrees(M.to_quaternion().angle), 0) for b, M in F.items()})
    # Check: play Carry_Level and measure the digits against the grip's barrel axis (mm from the axis).
    ad = arm.animation_data
    prev = ad.action
    ad.action = bpy.data.actions["Carry_Level"]
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    gm = grip.matrix_world
    ga, gc = gm.translation, (gm.to_3x3() @ Vector((0, 1, 0))).normalized()
    def gd(p):
        d = p - ga
        return round((d - gc * d.dot(gc)).length * 1000)
    for fn in FINGERS + ["thumb"]:
        print("  posed", fn, [gd(arm.matrix_world @ arm.pose.bones[f"{fn}_0{i}_r"].head) for i in (1, 2, 3)], gd(arm.matrix_world @ arm.pose.bones[f"{fn}_03_r"].tail))
    ad.action = prev
    return out
