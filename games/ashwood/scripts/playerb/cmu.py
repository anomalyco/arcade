# CMU Graphics Lab motion capture (ASF skeleton + AMC motion) reader and forward kinematics, numpy only.
# Rest pose (all channels zero) has every bone frame aligned with the world, so a bone's world rotation is the
# motion delta from the rest pose directly. Units: metres (CMU lengths are in 1/0.45 inch), Y up.
import math

import numpy as np

SCALE = (1.0 / 0.45) * 0.0254


def euler(ax, ay, az, order="XYZ"):
    """Rotation matrix for rotations about X, then Y, then Z (fixed axes) in degrees: Rz @ Ry @ Rx."""
    rx, ry, rz = (math.radians(a) for a in (ax, ay, az))
    cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    X = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Y = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Z = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    m = {"X": X, "Y": Y, "Z": Z}
    r = np.eye(3)
    for c in order:
        r = m[c] @ r
    return r


class Skeleton:
    def __init__(self, path):
        self.bones = {}
        self.parent = {}
        self.children = {"root": []}
        txt = open(path).read()
        sec = txt.split(":bonedata")[1].split(":hierarchy")[0]
        for blk in sec.split("begin")[1:]:
            blk = blk.split("end")[0]
            b = {"dof": [], "dir": np.zeros(3), "len": 0.0, "axis": np.eye(3)}
            for line in blk.strip().splitlines():
                t = line.split()
                if not t:
                    continue
                if t[0] == "name":
                    b["name"] = t[1]
                elif t[0] == "direction":
                    b["dir"] = np.array([float(x) for x in t[1:4]])
                elif t[0] == "length":
                    b["len"] = float(t[1]) * SCALE
                elif t[0] == "axis":
                    b["axis"] = euler(float(t[1]), float(t[2]), float(t[3]), t[4])
                elif t[0] == "dof":
                    b["dof"] = t[1:]
            self.bones[b["name"]] = b
        root = txt.split(":root")[1].split(":bonedata")[0]
        self.root_order = []
        self.root_axis = "XYZ"
        for line in root.strip().splitlines():
            t = line.split()
            if t and t[0] == "order":
                self.root_order = [x.lower() for x in t[1:]]
            if t and t[0] == "axis":
                self.root_axis = t[1]
        hier = txt.split(":hierarchy")[1].split("begin")[1].split("end")[0]
        for line in hier.strip().splitlines():
            t = line.split()
            for c in t[1:]:
                self.parent[c] = t[0]
                self.children.setdefault(t[0], []).append(c)
        self.order = []
        stack = ["root"]
        while stack:
            n = stack.pop(0)
            self.order.append(n)
            stack.extend(self.children.get(n, []))


def read_amc(path):
    frames = []
    cur = None
    for line in open(path):
        line = line.strip()
        if not line or line[0] in "#:":
            continue
        if line.isdigit():
            cur = {}
            frames.append(cur)
            continue
        t = line.split()
        cur[t[0]] = [float(x) for x in t[1:]]
    return frames


def fk(sk, frames):
    """Per frame: {bone: (world rotation 3x3, world start point, world end point)}; positions in metres."""
    out = []
    for f in frames:
        R = {}
        P = {}
        E = {}
        v = f["root"]
        ch = dict(zip(sk.root_order, v))
        pos = np.array([ch.get("tx", 0), ch.get("ty", 0), ch.get("tz", 0)]) * SCALE
        rr = euler(ch.get("rx", 0), ch.get("ry", 0), ch.get("rz", 0))
        R["root"] = rr
        P["root"] = pos
        E["root"] = pos
        for n in sk.order[1:]:
            b = sk.bones[n]
            p = sk.parent[n]
            vals = dict(zip(b["dof"], f.get(n, [])))
            m = euler(vals.get("rx", 0), vals.get("ry", 0), vals.get("rz", 0))
            C = b["axis"]
            R[n] = R[p] @ C @ m @ C.T
            P[n] = E[p]
            E[n] = P[n] + R[n] @ b["dir"] * b["len"]
        out.append((R, P, E))
    return out
