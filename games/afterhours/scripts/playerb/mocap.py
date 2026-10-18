# Offline retarget of CMU mocap onto the janitor's UAL skeleton (run inside Blender by build.py).
#
# Both rest poses are T-poses, and a CMU bone's world rotation is its motion delta from rest, so each mapped UAL bone
# gets   G_target = H · K · G_cmu · Kᵀ · A · R_rest
# where K converts CMU axes (Y up, +Z forward, +X left) to the armature's (Z up, -Y forward, +X left), H turns the
# actor's mean facing to -Y, A swings the UAL rest bone onto the CMU rest bone direction (the small rest differences,
# e.g. CMU legs splayed 20°), and R_rest is the UAL bone's rest rotation. Locals are G_parent⁻¹·G, so twist and hands
# come through exactly. Fingers keep an authored UAL hand pose. One clean gait cycle (left foot contact to the next) is
# cut from a steady, straight stretch of the take, made in-place (mean travel removed, the sway kept), closed into a
# seamless loop and baked as an action with its measured ground speed and direction.
import math

import numpy as np
from mathutils import Matrix, Quaternion, Vector

from cmu import Skeleton, fk, read_amc

K = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])

# UAL bone -> CMU bone (world rotation source).
MAP = {"pelvis": "root", "spine_01": "lowerback", "spine_02": "upperback", "spine_03": "thorax", "neck_01": "lowerneck",
       "Head": "head"}
for s, c in (("l", "l"), ("r", "r")):
    MAP.update({f"thigh_{s}": f"{c}femur", f"calf_{s}": f"{c}tibia", f"foot_{s}": f"{c}foot", f"ball_{s}": f"{c}toes",
                f"clavicle_{s}": f"{c}clavicle", f"upperarm_{s}": f"{c}humerus", f"lowerarm_{s}": f"{c}radius",
                f"hand_{s}": f"{c}hand"})
AIM = {"spine_01": "spine_02", "spine_02": "spine_03", "spine_03": "neck_01", "neck_01": "Head"}
for s in "lr":
    AIM.update({f"clavicle_{s}": f"upperarm_{s}", f"upperarm_{s}": f"lowerarm_{s}", f"lowerarm_{s}": f"hand_{s}",
                f"hand_{s}": f"middle_01_{s}", f"thigh_{s}": f"calf_{s}", f"calf_{s}": f"foot_{s}",
                f"foot_{s}": f"ball_{s}", f"ball_{s}": f"ball_leaf_{s}"})


def mirror_frames(F):
    """Mirror world rotations/positions across the CMU sagittal plane (X), swapping left and right."""
    S = np.diag([-1.0, 1, 1])
    sw = lambda n: ("r" + n[1:]) if n.startswith("l") and n not in ("lowerback", "lowerneck") else (("l" + n[1:]) if n.startswith("r") and n != "root" else n)  # noqa: E731
    out = []
    for R, P, E in F:
        R2, P2, E2 = {}, {}, {}
        for n in R:
            m = sw(n)
            R2[m] = S @ R[n] @ S
            P2[m] = S @ P[n]
            E2[m] = S @ E[n]
        out.append((R2, P2, E2))
    return out


def yaw_of(v):
    return math.atan2(v[0], v[1])


def contacts(F, side, fps):
    """Frames where the given foot's lowest point (ankle or toe) is on the floor."""
    # A planted foot barely moves: horizontal speed of the mid-foot (ankle..ball) well below the body's.
    mid = np.array([(f[1][f"{side}foot"] + f[1][f"{side}toes"]) * 0.5 for f in F])
    root = np.array([f[1]["root"] for f in F])
    v = np.linalg.norm(np.gradient(mid[:, [0, 2]], axis=0), axis=1) * fps
    vr = np.linalg.norm(np.gradient(root[:, [0, 2]], axis=0), axis=1) * fps
    v = np.convolve(v, np.ones(3) / 3, mode="same")
    low = mid[:, 1]
    floor = np.percentile(low, 5)
    return (v < np.maximum(0.3, 0.35 * vr)) & (low < floor + 0.06)


def find_cycle(F, fps, want, min_speed=0.2):
    """Best gait cycle [s, e] between two left-foot touchdowns, travelling in the wanted local direction."""
    root = np.array([f[1]["root"] for f in F])
    on = contacts(F, "l", fps)
    starts = [i for i in range(1, len(on)) if on[i] and not on[i - 1]]
    best = None
    for a, b in zip(starts, starts[1:]):
        if b - a < 0.35 * fps or b - a > 2.5 * fps:
            continue
        travel = root[b] - root[a]
        T = (b - a) / fps
        v = np.array([travel[0], travel[2]]) / T
        speed = float(np.linalg.norm(v))
        if speed < min_speed and want != "turn":
            continue
        face = [F[i][0]["root"] @ np.array([0, 0, 1.0]) for i in (a, (a + b) // 2, b)]
        fy = [yaw_of((f[0], f[2])) for f in face]
        turn = abs(math.remainder(fy[2] - fy[0], 2 * math.pi))
        local = math.degrees(math.remainder(yaw_of(v) - fy[1], 2 * math.pi))
        target = {"fwd": 0, "back": 180, "left": 90, "right": -90}.get(want, 0)
        dang = abs(math.remainder(math.radians(local - target), 2 * math.pi))
        if dang > math.radians(35):
            continue
        # Steady: speed within the cycle (half-cycles) should match; straight path: little facing change.
        h = (a + b) // 2
        v1 = np.linalg.norm((root[h] - root[a])[[0, 2]]) / ((h - a) / fps)
        v2 = np.linalg.norm((root[b] - root[h])[[0, 2]]) / ((b - h) / fps)
        steady = abs(v1 - v2) / max(speed, 1e-3)
        # Pose match between the ends (root-relative rotations).
        Ra, Rb = F[a][0], F[b][0]
        ia, ib = Ra["root"].T, Rb["root"].T
        mis = 0.0
        for n in ("lfemur", "rfemur", "ltibia", "rtibia", "lhumerus", "rhumerus", "lradius", "rradius", "thorax"):
            d = (ia @ Ra[n]).T @ (ib @ Rb[n])
            mis += math.acos(max(-1, min(1, (np.trace(d) - 1) / 2)))
        score = turn * 3 + steady * 2 + mis + dang * 2 - speed * 0.05
        if best is None or score < best[0]:
            best = (score, a, b, speed, local, turn, mis)
    return best


def bake(arm, name, asf, amc, want, fps_src=120, fps=60, mirror=False, window=None, finger_pose=None, cycle=None, segment=None, air=False, loop=False):
    """Bake one looping action from a CMU take onto armature `arm` (or, with `segment` = source frame range, a one-shot
    clip; `air` keeps the feet at the model floor so the controller supplies the flight arc). Returns its metadata."""
    import bpy

    if segment:
        fps_src = 60 if amc.split("/")[-1].startswith("143_") else 120
        step = max(1, round(fps_src / fps))
        sk = Skeleton(asf)
        F = fk(sk, read_amc(amc)[::step])
        if mirror:
            F = mirror_frames(F)
        a, b = segment[0] // step, segment[1] // step
        return _bake(arm, name, sk, F, a, b, fps, want, amc, step, finger_pose, segment=True, air=air, loop=loop)

    best = None
    for one in amc.split(","):
        # CMU takes are 120 fps except subject 143 (60 fps; its strides only make sense at 60).
        fps_src = 60 if one.split("/")[-1].startswith("143_") else 120
        step = max(1, round(fps_src / fps))
        sk1 = Skeleton(asf if "," not in amc else one.rsplit("_", 1)[0] + ".asf")
        frames = read_amc(one)
        if window:
            frames = frames[window[0] : window[1]]
        F1 = fk(sk1, frames[::step])
        if mirror:
            F1 = mirror_frames(F1)
        found = find_cycle(F1, fps, want)
        print(f"  {one.split('/')[-1]}: {found and tuple(round(float(x), 2) for x in found)}")
        if found and (best is None or found[0] < best[0][0]):
            best = (found, sk1, F1, one, step)
    if best is None:
        raise RuntimeError(f"{name}: no cycle found in {amc}")
    (_, a, b, speed, local, turn, mis), sk, F, amc, step = best
    if cycle is None:
        pass
    print(f"{name}: frames {a * step}-{b * step} of {amc}, {speed:.2f} m/s src, local dir {local:.0f}°, turn {math.degrees(turn):.1f}°, end mismatch {mis:.2f}")
    return _bake(arm, name, sk, F, a, b, fps, want, amc, step, finger_pose)


def _bake(arm, name, sk, F, a, b, fps, want, amc, step, finger_pose, segment=False, air=False, loop=False):
    import bpy

    seg = F[a : b + 1]
    n = len(seg) - 1

    bones = arm.data.bones
    rest = {bn.name: Matrix(bn.matrix_local) for bn in bones}
    R3 = {k: v.to_3x3() for k, v in rest.items()}
    head = {bn.name: Vector(bn.head_local) for bn in bones}

    # Scale: leg length ratio (target thigh+calf over source femur+tibia).
    tl = (head["thigh_l"] - head["calf_l"]).length + (head["calf_l"] - head["foot_l"]).length
    sl = sk.bones["lfemur"]["len"] + sk.bones["ltibia"]["len"]
    ratio = tl / sl

    # Heading: mean facing over the cycle -> -Y.
    fsum = np.zeros(2)
    for R, _, _ in seg:
        f = K @ R["root"] @ np.array([0, 0, 1.0])
        fsum += f[:2] / max(1e-6, np.linalg.norm(f[:2]))
    ang = math.atan2(fsum[1], fsum[0]) - math.atan2(-1, 0)
    H = np.array(Matrix.Rotation(-ang, 3, "Z"))

    # Rest alignment A per mapped bone.
    A = {}
    # Only limbs are aligned by direction; the trunk, neck and clavicles join at different anatomical points in the two
    # skeletons (CMU's clavicle starts low on the neck, UAL's at the shoulder line), so their rests are taken as equal.
    for t, s in MAP.items():
        if t in AIM and AIM[t] in head and not t.startswith(("spine", "neck", "Head", "clavicle")):
            dt = (head[AIM[t]] - head[t]).normalized()
            ds = Vector(K @ sk.bones[s]["dir"]).normalized() if s != "root" else dt
            A[t] = np.array(dt.rotation_difference(ds).to_matrix())
        else:
            A[t] = np.eye(3)

    order = []

    def walk(bn):
        order.append(bn.name)
        for c in bn.children:
            walk(c)

    walk(next(bn for bn in bones if bn.parent is None))
    parent = {bn.name: (bn.parent.name if bn.parent else None) for bn in bones}

    G_frames = []
    basis = []
    pel = []
    root0 = None
    for R, P, E in seg:
        G = {}
        B = {}
        for t in order:
            p = parent[t]
            Rt = np.array(R3[t])
            if t in MAP:
                src = R[MAP[t]]
                if t.startswith("lowerarm_"):
                    # Half the wrist twist rides on the forearm (no twist bones), half stays at the wrist.
                    w = R[MAP[t].replace("radius", "wrist")]
                    d = Quaternion().slerp(Matrix((src.T @ w).tolist()).to_quaternion(), 0.5)
                    src = src @ np.array(d.to_matrix())
                g = H @ K @ src @ K.T @ A[t] @ Rt
            else:
                local = np.array(finger_pose.get(t, Quaternion()).to_matrix()) if finger_pose else np.eye(3)
                gp = G[p] if p else np.eye(3)
                Rp = np.array(R3[p]) if p else np.eye(3)
                g = gp @ Rp.T @ Rt @ local
            G[t] = g
            gp = G[p] if p else np.eye(3)
            Rp = np.array(R3[p]) if p else np.eye(3)
            loc_b = Rt.T @ Rp @ gp.T @ g
            B[t] = Matrix(loc_b.tolist()).to_quaternion()
        G_frames.append(G)
        basis.append(B)
        rp = H @ K @ P["root"]
        if root0 is None:
            root0 = rp.copy()
        pel.append(rp)
    pel = np.array(pel)
    T = n / fps
    travel = (pel[-1] - pel[0]) / T  # m/s in source units
    if segment:
        # One-shot: no travel, no loop; horizontal sway about the mean, and in the air the feet stay at the floor.
        travel = np.zeros(3)
        pel[:, :2] -= pel[:, :2].mean(axis=0) - pel[0, :2]
        if air:
            low = np.array([min(f[1]["lfoot"][1], f[1]["ltoes"][1], f[1]["rfoot"][1], f[1]["rtoes"][1]) for f in seg])
            floor = min(min(f[1]["lfoot"][1], f[1]["ltoes"][1], f[1]["rfoot"][1], f[1]["rtoes"][1]) for f in F)
            pel[:, 2] -= low - floor
    # In place: remove the mean travel (horizontal), scale to the target.
    loc = []
    for i in range(n + 1):
        p = (pel[i] - pel[0] - travel * (i / fps)) * ratio
        p[0] += head["pelvis"].x
        p[1] += head["pelvis"].y
        p[2] = pel[i][2] * ratio
        loc.append(p)
    loc = np.array(loc)
    # Close the loop: distribute end->start differences over the cycle.
    for t in order if not segment or loop else []:
        q0, qn = basis[0][t], basis[n][t]
        d = qn.inverted() @ q0
        for i in range(n + 1):
            basis[i][t] = basis[i][t] @ Quaternion().slerp(d, i / n)
    if not segment or loop:
        loc += np.outer(np.arange(n + 1) / n, loc[0] - loc[n])

    # Vertical calibration: the lowest of foot/ball (relative to its rest height) touches the floor in stance.
    def fk_target(i):
        pos = {}
        rot = {}
        for t in order:
            p = parent[t]
            Rt = rest[t]
            Mb = Matrix(Rt) @ basis[i][t].to_matrix().to_4x4()
            if t == "pelvis":
                Mb = Matrix(Rt) @ (Matrix.Translation(Vector(pelvis_local(i))) @ basis[i][t].to_matrix().to_4x4())
            if p:
                M = rot[p] @ rest[p].inverted() @ Mb
            else:
                M = Mb
            rot[t] = M
            pos[t] = M.translation.copy()
        return pos

    def pelvis_local(i):
        # Pose location of the pelvis in its rest frame (parent root is unposed).
        Mr = rest["pelvis"]
        world = Vector(loc[i].tolist()) + Vector((0, 0, 0))
        return Mr.to_3x3().inverted() @ (world - Mr.translation)

    lows = []
    P_all = [fk_target(i) for i in range(n + 1)]

    def contact(pos, side):
        a = pos[f"foot_{side}"].z - head[f"foot_{side}"].z
        b = pos[f"ball_{side}"].z - head[f"ball_{side}"].z
        return (a, pos[f"foot_{side}"]) if a < b else (b, pos[f"ball_{side}"])

    for pos in P_all:
        lows.append(min(contact(pos, "l")[0], contact(pos, "r")[0]))
    shift = -float(np.percentile(lows, 5 if not segment else 0))
    if segment:
        # One-shots: calibrate on the take's standing frames (outside the segment the feet are flat on the floor).
        shift = -min(lows)
    loc[:, 2] += shift

    # Horizontal scale that makes the planted foot stand still: the legs' own stride (retargeted joint angles on the
    # janitor's legs) decides it, not the leg-length ratio. Solve along the travel direction over stance frames.
    tv = travel[:2]
    tspeed = float(np.linalg.norm(tv))
    ratio_h = ratio
    if tspeed > 0.2 and not segment:
        tdir = tv / tspeed
        floor = float(np.percentile(lows, 5))
        sway = np.array([(pel[i] - pel[0] - travel * (i / fps))[:2] for i in range(n + 1)])
        lv, sv = [], []
        for side in "lr":
            rel = []
            st = []
            for pos in P_all:
                h, p = contact(pos, side)
                rel.append(np.array((p - pos["pelvis"])[:2]))
                st.append(h < floor + 0.015)
            for i in range(1, n):
                if st[i] and st[i - 1] and st[i + 1]:
                    lv.append(float(((rel[i + 1] - rel[i - 1]) * fps / 2) @ tdir))
                    sv.append(float(((sway[i + 1] - sway[i - 1]) * fps / 2) @ tdir))
        if len(lv) > 3:
            ratio_h = -float(np.mean(lv)) / (float(np.mean(sv)) + tspeed)
            print(f"  stride scale {ratio_h / ratio:.3f} of leg ratio ({len(lv)} stance frames)")
            for i in range(n + 1):
                q = (pel[i] - pel[0] - travel * (i / fps)) * ratio_h
                loc[i][0] = q[0] + head["pelvis"].x
                loc[i][1] = q[1] + head["pelvis"].y

    # Write the action.
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    ad = arm.animation_data or arm.animation_data_create()
    prev = ad.action
    ad.action = act
    # Keys at the scene frame rate's timing (the glTF exporter converts frames to seconds with it).
    sfps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    kf = lambda i: 1 + i * sfps / fps  # noqa: E731
    for i in range(n + 1):
        for t in order:
            pb = arm.pose.bones[t]
            pb.rotation_mode = "QUATERNION"
            q = basis[i][t]
            if i and q.dot(basis[i - 1][t]) < 0:
                q.negate()
                basis[i][t] = q
            pb.rotation_quaternion = q
            pb.keyframe_insert("rotation_quaternion", frame=kf(i))
        pb = arm.pose.bones["pelvis"]
        pb.location = pelvis_local(i)
        pb.keyframe_insert("location", frame=kf(i))
    ad.action = prev
    v_local = np.array(Vector((travel * ratio_h).tolist()))
    meta = {"speed": float(np.linalg.norm(v_local[:2])), "dir": math.degrees(math.atan2(v_local[0], -v_local[1])), "frames": n, "fps": fps, "src": amc.split("/")[-1], "srcFrames": [a * step, b * step], "ratio": ratio}
    print(f"  -> {meta}")
    return meta
