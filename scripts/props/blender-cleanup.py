"""Step 3 of the prop pipeline: raw TRELLIS.2 GLB -> game prop (.prop) with two LODs. Headless Blender 5.2:

  blender -b --factory-startup -P scripts/props/blender-cleanup.py -- --work DIR --out DIR --spec specs.json [--ids a,b]

Per prop: drop floaters, orient (front to -Y in Blender, i.e. +Z in game space), scale to the catalogue size in metres,
put the pivot at the footprint centre on the floor, decimate to each LOD budget, smooth normals by angle, sample the
base colour texture into per-corner colours (filtered to the triangle's texel footprint), bake ambient occlusion
(with a floor plane, so feet and undersides darken) into a separate byte, pick a kit material per face from the
metallic/roughness map, then write the compact binary described in packages/kit/props/format.ts and a preview sheet.
"""

import json
import math
import os
import struct
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]


def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


WORK = opt("--work")
OUT = opt("--out")
SPECS = json.load(open(opt("--spec")))
IDS = [s for s in (opt("--ids") or "").split(",") if s] or [s["id"] for s in SPECS["props"]]
FIX = SPECS.get("fixups", {})
PREVIEW = os.path.join(WORK, "preview")
os.makedirs(PREVIEW, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

MAT_LIT, MAT_SHINY = 0, 10
MAGIC = b"PROP"
VERSION = 1


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_raw(path):
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    for o in bpy.context.scene.objects:
        o.select_set(o in meshes)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def images(obj):
    base = mr = None
    for mat in obj.data.materials:
        if not mat or not mat.node_tree:
            continue
        for link in mat.node_tree.links:
            n = link.from_node
            if n.type == "TEX_IMAGE" and link.to_socket.name == "Base Color":
                base = n.image
        for n in mat.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image is not base:
                mr = n.image
    return base, mr


def pixels(img):
    img.colorspace_settings.name = "Non-Color"
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    return px.reshape(h, w, 4)


def mip_chain(px):
    levels = [px]
    while min(levels[-1].shape[:2]) > 4:
        p = levels[-1]
        h, w = p.shape[0] // 2 * 2, p.shape[1] // 2 * 2
        p = p[:h, :w]
        levels.append((p[0::2, 0::2] + p[1::2, 0::2] + p[0::2, 1::2] + p[1::2, 1::2]) * 0.25)
    return levels


def sample(levels, uv, lvl):
    """Bilinear sample at per-point mip level (rounded); uv in [0,1], v up (Blender convention)."""
    out = np.zeros((len(uv), levels[0].shape[2]), dtype=np.float32)
    lvl = np.clip(np.round(lvl).astype(int), 0, len(levels) - 1)
    for L in np.unique(lvl):
        sel = lvl == L
        img = levels[L]
        h, w = img.shape[:2]
        x = np.clip(uv[sel, 0] * w - 0.5, 0, w - 1)
        y = np.clip(uv[sel, 1] * h - 0.5, 0, h - 1)
        x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
        x1, y1 = np.minimum(x0 + 1, w - 1), np.minimum(y0 + 1, h - 1)
        fx, fy = (x - x0)[:, None], (y - y0)[:, None]
        out[sel] = (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy) + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy)
    return out


def signed_volume(faces):
    vol = 0.0
    for f in faces:
        v = [l.vert.co for l in f.loops]
        for i in range(1, len(v) - 1):
            vol += v[0].dot(v[i].cross(v[i + 1]))
    return vol / 6


def drop_floaters(obj, min_faces=12, min_diag=0.015, voids=False):
    """Remove voxel-noise islands: fewer than `min_faces` faces or smaller than `min_diag` of the object's diagonal.
    Feet, knobs and handles are islands too, so size, not share of faces, decides. With `voids`, also remove closed
    islands facing inwards: the remesher wraps both sides of every surface, so a solid source comes back as a thick
    shell around a hidden cavity that would spend the triangle budget and bake black."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=2e-4)
    bm.faces.ensure_lookup_table()
    allco = np.array([v.co[:] for v in bm.verts])
    diag = float(np.linalg.norm(allco.max(0) - allco.min(0)))
    seen, islands = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, isl = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        islands.append(isl)
    doomed = []
    for isl in islands:
        co = np.array([v.co[:] for g in isl for v in g.verts])
        if len(isl) < min_faces or np.linalg.norm(co.max(0) - co.min(0)) < min_diag * diag or (voids and signed_volume(isl) < 0):
            doomed.extend(isl)
    bmesh.ops.delete(bm, geom=doomed, context="FACES")
    bm.to_mesh(obj.data)
    bm.free()
    return len(islands), len(doomed)


def drop_hidden(obj, rays=32):
    """Remove faces no ray from outside can reach. TRELLIS wraps solid parts in a second, inner shell (a stack of
    books came back with 2.4x a box's area); decimating both lets the inner one poke through as dark wedges, and it
    spends half the budget on faces nobody sees. A face stays if any of `rays` directions escapes from either side,
    and is turned to face the side that escapes."""
    from mathutils.bvhtree import BVHTree
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    bvh = BVHTree.FromBMesh(bm)
    k = np.arange(rays) + 0.5
    phi = np.arccos(1 - 2 * k / rays)
    theta = np.pi * (1 + 5 ** 0.5) * k
    dirs = [Vector(d) for d in np.stack([np.cos(theta) * np.sin(phi), np.sin(theta) * np.sin(phi), np.cos(phi)], 1).tolist()]
    eps = 1e-4 * max(obj.dimensions)
    hidden, flipped = [], []
    escapes = lambda o, ds: any(bvh.ray_cast(o, d)[0] is None for d in ds)
    for f in bm.faces:
        c, n = f.calc_center_median(), f.normal
        if escapes(c + n * eps, [d for d in dirs if d.dot(n) >= 0]):
            continue
        if escapes(c - n * eps, [d for d in dirs if d.dot(n) < 0]):
            flipped.append(f)  # only its back is exposed: the face is wound inwards and would shade dark
        else:
            hidden.append(f)
    bmesh.ops.reverse_faces(bm, faces=flipped)
    bmesh.ops.delete(bm, geom=hidden, context="FACES")
    bm.to_mesh(obj.data)
    bm.free()
    return len(hidden), len(flipped)


def orient_and_scale(obj, spec, fix):
    me = obj.data
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    yaw = fix.get("yaw")
    if yaw is None:
        # Auto: the long horizontal axis is the width. TRELLIS keeps the source image's front facing -Y, so no flip:
        # a "tall side is the back" guess turned all six cabinets of the first batch backwards.
        ext = co.max(0) - co.min(0)
        yaw = 90.0 if ext[1] > ext[0] * 1.08 and spec["size"][0] >= spec["size"][2] else 0.0
    r = Matrix.Rotation(math.radians(yaw), 4, "Z")
    me.transform(r)
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    mn, mx = co.min(0), co.max(0)
    ext = np.maximum(mx - mn, 1e-6)
    w, h, d = spec["size"]  # catalogue: width x, height y(up), depth z
    want = np.array([w, d, h], dtype=np.float32)  # Blender axes: x width, y depth, z up
    ratio = want / ext
    s = float(np.exp(np.log(ratio).mean()))
    per = np.clip(ratio / s, 0.88, 1.12) * s
    per[2] = ratio[2]  # height is exact: clutter sits on catalogue surface heights, and a table is table height
    if spec["role"] == "clutter":
        per = np.clip(ratio / s, 0.90, 1.10) * s  # small things keep their proportions within ±10%, at the catalogue's volume
    centre = np.array([(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, mn[2]])
    me.transform(Matrix.Translation(Vector((-centre).tolist())))
    me.transform(Matrix.Diagonal((per[0], per[1], per[2], 1.0)))
    me.update()
    return yaw, (ext * per).tolist()


def src_copy(src):
    obj = src.copy()
    obj.data = src.data.copy()
    bpy.context.collection.objects.link(obj)
    return obj


def remeshed(src, depth, mode):
    """A watertight octree remesh of the source. TRELLIS meshes are open (thousands of small boundary loops), and
    collapse decimation cannot shrink a hole below a triangle, so it stalls far above small budgets (a dining chair at
    1960 of 1200). The voxel remesher needs a closed volume and dropped most of an open sofa; the octree (dual
    contouring) remesher closes the surface without losing it, and the result decimates cleanly to any budget."""
    obj = src_copy(src)
    mod = obj.modifiers.new("remesh", "REMESH")
    mod.mode = mode
    mod.octree_depth = depth
    mod.scale = 0.9
    mod.sharpness = 1.0
    mod.use_remove_disconnected = False
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
    # Dual contouring closes the surface but can fold thin parts into non-manifold edges, which block decimation (the
    # bed's LOD1 stuck at 2562 of 1000). A voxel pass over the now-closed surface makes it manifold.
    mod = obj.modifiers.new("voxel", "REMESH")
    mod.mode = "VOXEL"
    mod.voxel_size = max(obj.dimensions) / (2 ** depth * 1.25)
    mod.adaptivity = 0.0
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def decimate(src, tris):
    obj = src_copy(src)
    tri = obj.modifiers.new("tri", "TRIANGULATE")
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=tri.name)
    for _ in range(3):
        faces = len(obj.data.polygons)
        if faces <= tris * 1.01:
            break
        mod = obj.modifiers.new("dec", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = tris / faces
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


class SourceSampler:
    """Looks up the generated texture or direct vertex colours at any point near the source surface."""

    def __init__(self, obj, levels):
        from mathutils.bvhtree import BVHTree
        me = obj.data
        me.calc_loop_triangles()
        co = np.empty(len(me.vertices) * 3, dtype=np.float32)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        nt = len(me.loop_triangles)
        tv = np.empty(nt * 3, dtype=np.int32)
        me.loop_triangles.foreach_get("vertices", tv)
        tl = np.empty(nt * 3, dtype=np.int32)
        me.loop_triangles.foreach_get("loops", tl)
        tv = tv.reshape(-1, 3)
        self.tri_v = co[tv]
        self.bvh = BVHTree.FromPolygons(co.tolist(), tv.tolist())
        self.has_uv = levels is not None and me.uv_layers.active is not None
        self.tri_vc = None
        if self.has_uv:
            uv = np.empty(len(me.loops) * 2, dtype=np.float32)
            me.uv_layers.active.data.foreach_get("uv", uv)
            uv = uv.reshape(-1, 2)
            self.tri_uv = uv[tl.reshape(-1, 3)]
            H, W = levels[0].shape[:2]
            e1 = self.tri_v[:, 1] - self.tri_v[:, 0]
            e2 = self.tri_v[:, 2] - self.tri_v[:, 0]
            world = np.linalg.norm(np.cross(e1, e2), axis=1).sum() * 0.5
            u1 = self.tri_uv[:, 1] - self.tri_uv[:, 0]
            u2 = self.tri_uv[:, 2] - self.tri_uv[:, 0]
            texels = (np.abs(u1[:, 0] * u2[:, 1] - u1[:, 1] * u2[:, 0]) * 0.5).sum() * W * H
            self.texels_per_m2 = texels / max(world, 1e-9)
        else:
            self.texels_per_m2 = 1.0
            ca = me.color_attributes.active_color or (me.color_attributes[0] if len(me.color_attributes) else None)
            if ca is not None:
                if ca.domain == "CORNER":
                    raw_c = np.empty(len(me.loops) * 4, dtype=np.float32)
                    ca.data.foreach_get("color_srgb", raw_c)
                    self.tri_vc = raw_c.reshape(-1, 4)[tl.reshape(-1, 3)]
                else:
                    raw_c = np.empty(len(me.vertices) * 4, dtype=np.float32)
                    ca.data.foreach_get("color_srgb", raw_c)
                    self.tri_vc = raw_c.reshape(-1, 4)[tv]

    def _hit_barycentric(self, pts, normals=None):
        idx = np.empty(len(pts), dtype=np.int64)
        loc = np.empty((len(pts), 3), dtype=np.float64)
        for i, p in enumerate(pts):
            hit = None
            if normals is not None:
                n = Vector(normals[i].tolist())
                hit = self.bvh.ray_cast(Vector(p.tolist()) + n * 0.003, -n, 0.012)
                if hit[0] is None:
                    hit = None
            if hit is None:
                hit = self.bvh.find_nearest(Vector(p.tolist()))
            loc[i] = hit[0][:]
            idx[i] = hit[2]
        a, b, c = self.tri_v[idx, 0], self.tri_v[idx, 1], self.tri_v[idx, 2]
        v0, v1, v2 = b - a, c - a, loc - a
        d00 = (v0 * v0).sum(1); d01 = (v0 * v1).sum(1); d11 = (v1 * v1).sum(1)
        d20 = (v2 * v0).sum(1); d21 = (v2 * v1).sum(1)
        den = np.maximum(d00 * d11 - d01 * d01, 1e-18)
        w1 = np.clip((d11 * d20 - d01 * d21) / den, 0.0, 1.0)
        w2 = np.clip((d00 * d21 - d01 * d20) / den, 0.0, 1.0)
        w0 = np.clip(1.0 - w1 - w2, 0.0, 1.0)
        return idx, w0, w1, w2

    def uv(self, pts, normals=None):
        """UV of the source surface at each point."""
        idx, w0, w1, w2 = self._hit_barycentric(pts, normals)
        t = self.tri_uv[idx]
        return t[:, 0] * w0[:, None] + t[:, 1] * w1[:, None] + t[:, 2] * w2[:, None]

    def vertex_rgba(self, pts, normals=None):
        """Interpolated COLOR_0 (RGB base_color + alpha shiny flag) on vertex-coloured GLBs."""
        idx, w0, w1, w2 = self._hit_barycentric(pts, normals)
        vc = self.tri_vc[idx]
        return vc[:, 0] * w0[:, None] + vc[:, 1] * w1[:, None] + vc[:, 2] * w2[:, None]


def bake_ao(obj, samples=48, distance=0.35):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.world = scene.world or bpy.data.worlds.new("w")
    scene.world.light_settings.distance = distance
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, -0.002))
    floor = bpy.context.active_object
    me = obj.data
    # Float, not byte: a byte attribute reads back through the sRGB curve, which turned 0.5 open into 0.21.
    attr = me.color_attributes.new("ao", "FLOAT_COLOR", "CORNER")
    me.color_attributes.active_color = attr
    mat = bpy.data.materials.new("bake")
    mat.use_nodes = True
    me.materials.clear()
    me.materials.append(mat)
    # Only the LOD and the floor may occlude: the source and the remeshed solids share its surface and blackened it.
    hidden = [o for o in scene.objects if o not in (obj, floor) and not o.hide_render]
    for o in scene.objects:
        o.select_set(o is obj)
    for o in hidden:
        o.hide_render = True
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")
    for o in hidden:
        o.hide_render = False
    ao = np.empty(len(me.loops) * 4, dtype=np.float32)
    attr.data.foreach_get("color", ao)
    bpy.data.objects.remove(floor)
    return ao.reshape(-1, 4)[:, 0]


def corner_data(obj, sampler, base_levels, mr_levels, smooth_deg):
    me = obj.data
    try:
        me.set_sharp_from_angle(angle=math.radians(smooth_deg))
    except AttributeError:
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.shade_auto_smooth(angle=math.radians(smooth_deg))
    nl = len(me.loops)
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    lv = np.empty(nl, dtype=np.int32)
    me.loops.foreach_get("vertex_index", lv)
    nrm = np.empty(nl * 3, dtype=np.float32)
    me.corner_normals.foreach_get("vector", nrm)
    nrm = nrm.reshape(-1, 3)
    starts = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("loop_start", starts)
    loops = starts[:, None] + np.arange(3)[None, :]  # triangulated: 3 loops per face
    tp = co[lv[loops]]  # (F,3,3)
    cen = tp.mean(1)
    area = np.linalg.norm(np.cross(tp[:, 1] - tp[:, 0], tp[:, 2] - tp[:, 0]), axis=1) * 0.5
    pull = tp * 0.7 + cen[:, None, :] * 0.3
    fn = np.cross(tp[:, 1] - tp[:, 0], tp[:, 2] - tp[:, 0])
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    if sampler.has_uv:
        lvl = np.clip(0.5 * np.log2(np.maximum(area * sampler.texels_per_m2, 1.0)) - 1.0, 0, len(base_levels) - 1)
        uv_c = sampler.uv(pull.reshape(-1, 3), np.repeat(fn, 3, 0))
        col = sample(base_levels, uv_c, np.repeat(lvl, 3))[:, :3]
        uv_m = sampler.uv(cen, fn)
        mr = sample(mr_levels, uv_m, lvl) if mr_levels else np.zeros((len(cen), 4), dtype=np.float32)
        shiny = (mr[:, 2] > 0.5) | (mr[:, 1] < 0.32)
    else:
        rgba_c = sampler.vertex_rgba(pull.reshape(-1, 3), np.repeat(fn, 3, 0))
        col = np.clip(rgba_c[:, :3], 0.0, 1.0)
        rgba_m = sampler.vertex_rgba(cen, fn)
        shiny = rgba_m[:, 3] > 0.998
    mat = np.where(shiny, MAT_SHINY, MAT_LIT).astype(np.uint8)
    corner_order = loops.reshape(-1)
    return co[lv[corner_order]], nrm[corner_order], col, np.repeat(mat, 3), corner_order


def pack_lod(pos, nrm, col, ao, mat, lo, hi):
    q = np.round((pos - lo) / np.maximum(hi - lo, 1e-6) * 65535).astype(np.uint16)
    n8 = np.clip(np.round(nrm / np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-6) * 127), -127, 127).astype(np.int8)
    c8 = np.clip(np.round(np.clip(col, 0, 1) * 255), 0, 255).astype(np.uint8)
    a8 = np.clip(np.round(np.clip(ao, 0, 1) * 255), 0, 255).astype(np.uint8)
    # Corners that share position, normal and material become one vertex with their averaged colour and AO: the
    # texture detail a vertex can carry is bounded by vertex density anyway, and it cuts the file to a third.
    key = np.zeros(len(pos), dtype=[("p", "<u2", 3), ("n", "i1", 3), ("m", "u1")])
    key["p"], key["n"], key["m"] = q, n8, mat
    uniq, inv = np.unique(key.view(np.void(key.dtype.itemsize)), return_inverse=True)
    inv = inv.reshape(-1)
    count = np.bincount(inv, minlength=len(uniq)).astype(np.float32)[:, None]
    csum = np.zeros((len(uniq), 3), np.float32)
    np.add.at(csum, inv, c8.astype(np.float32))
    asum = np.zeros(len(uniq), np.float32)
    np.add.at(asum, inv, a8.astype(np.float32))
    verts = np.zeros(len(uniq), dtype=[("p", "<u2", 3), ("n", "i1", 3), ("m", "u1"), ("c", "u1", 3), ("a", "u1")])
    k = uniq.view(key.dtype).reshape(-1)
    verts["p"], verts["n"], verts["m"] = k["p"], k["n"], k["m"]
    verts["c"] = np.round(csum / count).astype(np.uint8)
    verts["a"] = np.round(asum / count[:, 0]).astype(np.uint8)
    return verts, inv.astype(np.uint32)


def write_prop(path, lods, lo, hi):
    with open(path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<HH", VERSION, len(lods)))
        f.write(struct.pack("<6f", *lo, *hi))
        for verts, idx in lods:
            wide = len(verts) > 65535
            f.write(struct.pack("<III", len(verts), len(idx), 4 if wide else 2))
        for verts, idx in lods:
            f.write(verts.tobytes())
            data = idx.astype(np.uint32 if len(verts) > 65535 else np.uint16).tobytes()
            f.write(data)
            if len(data) % 4:
                f.write(b"\0" * (4 - len(data) % 4))


def preview(pid, verts_lo, idx_lo, lo, hi, tris):
    """Workbench render of LOD0 from the gameplay angle, a 3/4 front view and the side, using the packed colours."""
    scene = bpy.context.scene
    for o in list(scene.objects):
        bpy.data.objects.remove(o)
    p = verts_lo["p"].astype(np.float32) / 65535 * (hi - lo) + lo
    # game space (x, y up, z front) -> Blender (x, -z, y)
    pb = np.stack([p[:, 0], -p[:, 2], p[:, 1]], 1)
    me = bpy.data.meshes.new(pid)
    me.from_pydata(pb.tolist(), [], idx_lo.reshape(-1, 3).tolist())
    attr = me.color_attributes.new("col", "BYTE_COLOR", "CORNER")
    c = verts_lo["c"].astype(np.float32) / 255 * (0.35 + 0.65 * verts_lo["a"].astype(np.float32)[:, None] / 255)
    rgba = np.concatenate([c, np.ones((len(c), 1), np.float32)], 1)[idx_lo]
    attr.data.foreach_set("color_srgb", rgba.reshape(-1))
    obj = bpy.data.objects.new(pid, me)
    scene.collection.objects.link(obj)
    scene.render.engine = "BLENDER_WORKBENCH"
    sh = scene.display.shading
    sh.light = "FLAT"
    sh.color_type = "VERTEX"
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x = scene.render.resolution_y = 360
    scene.render.film_transparent = False
    scene.world = scene.world or bpy.data.worlds.new("w")
    scene.world.color = (0.06, 0.06, 0.07)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.type = "ORTHO"
    ext = float(np.max(hi - lo))
    cam.data.ortho_scale = ext * 1.25
    centre = Vector((0, 0, (hi[1] - lo[1]) * 0.4))
    files = []
    for k, (az, el) in enumerate([(-35, 55), (-35, 20), (90, 15)]):
        d = Vector((math.sin(math.radians(az)) * math.cos(math.radians(el)), -math.cos(math.radians(az)) * math.cos(math.radians(el)), math.sin(math.radians(el))))
        cam.location = centre + d * ext * 3
        cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
        f = os.path.join(PREVIEW, f"{pid}-{k}.png")
        scene.render.filepath = f
        bpy.ops.render.render(write_still=True)
        files.append(f)
    return files


def refine(obj, tris, rounds=6):
    """Split the longest edges until the mesh has `tris` triangles. Collapse decimation spends triangles on shape
    only, so a flat book cover ends as two long triangles and its vertex colours smear into dark wedges; the last
    third of the budget goes to colour resolution instead, evenly over the surface (the splits are planar)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for _ in range(rounds):
        room = (tris - len(bm.faces)) // 2
        if room < max(8, tris * 0.01):
            break
        edges = sorted(bm.edges, key=lambda e: e.calc_length(), reverse=True)[: min(room, len(bm.edges) // 3)]
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1)
        bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()


GEOMETRY_SHARE = 0.65


def candidate_solid(pid, obj, name):
    """A mesh to decimate: the cleaned source, the source with its small cracks filled, or an octree remesh."""
    if name == "source":
        return src_copy(obj)
    if name == "filled":
        solid = src_copy(obj)
        bm = bmesh.new()
        bm.from_mesh(solid.data)
        bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=24)
        bmesh.ops.triangulate(bm, faces=bm.faces)
        bm.to_mesh(solid.data)
        bm.free()
        return solid
    depth = int(name.split()[1])
    solid = remeshed(obj, depth, "SHARP")
    n = len(solid.data.polygons)
    # Remeshed density is even, so faces measure area: shreds under 0.4% of the surface go too. Every closed island
    # keeps a floor of triangles through decimation (the armchair's 227 fragments held it at 3326 of 700).
    isl, gone = drop_floaters(solid, min_faces=max(12, int(n * 0.004)), voids=True)
    print(f"{pid}: {name}: {n} faces, {isl} islands, dropped {gone} faces", flush=True)
    return solid


def surface_points(obj, n, seed=7):
    me = obj.data
    me.calc_loop_triangles()
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    tv = np.empty(len(me.loop_triangles) * 3, dtype=np.int32)
    me.loop_triangles.foreach_get("vertices", tv)
    t = co[tv.reshape(-1, 3)]
    area = np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1)
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(t), size=n, p=area / area.sum())
    u, v = rng.random(n), rng.random(n)
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    tp = t[pick]
    return tp[:, 0] + (tp[:, 1] - tp[:, 0]) * u[:, None] + (tp[:, 2] - tp[:, 0]) * v[:, None], co, tv.reshape(-1, 3)


class Reference:
    """Two-sided shape error against the source: the 90th percentile distance from source samples to a candidate
    (torn panels, lost legs) plus the same from candidate samples to the source (webbing, closed gaps), over the
    bounding-box diagonal."""

    def __init__(self, obj, n=6000):
        from mathutils.bvhtree import BVHTree
        self.pts, co, tv = surface_points(obj, n)
        self.bvh = BVHTree.FromPolygons(co.tolist(), tv.tolist())
        self.diag = float(np.linalg.norm(co.max(0) - co.min(0)))
        self.n = n

    @staticmethod
    def distances(pts, bvh):
        return np.array([bvh.find_nearest(Vector(p.tolist()))[3] for p in pts])

    def error(self, cand):
        from mathutils.bvhtree import BVHTree
        pts, co, tv = surface_points(cand, self.n, seed=11)
        cbvh = BVHTree.FromPolygons(co.tolist(), tv.tolist())
        a = np.percentile(self.distances(self.pts, cbvh), 90)
        b = np.percentile(self.distances(pts, self.bvh), 90)
        return float(a + b) / self.diag


def build(pid, raw):
    spec = next(s for s in SPECS["props"] if s["id"] == pid)
    t0 = time.time()
    reset()
    obj = import_raw(raw)
    base, mr = images(obj)
    base_levels = mip_chain(pixels(base)) if base else None
    mr_levels = mip_chain(pixels(mr)) if mr else None
    islands, dropped = drop_floaters(obj)
    yaw, size = orient_and_scale(obj, spec, FIX.get(pid, {}))
    hidden, flipped = drop_hidden(obj)
    sampler = SourceSampler(obj, base_levels)
    # Candidates per LOD, scored against the source surface; the lowest error within budget wins. At game budgets
    # (6-15k for anchors) the open source decimates directly and keeps thin panels (cabinet doors, chair slats) that
    # the octree remesh closed or tore; the remesh stays as a fallback for meshes whose holes stall decimation.
    fixed = FIX.get(pid, {}).get("candidates")
    ref = Reference(obj)
    solids, chosen, lods_raw = {}, [], []
    for tris in spec["lod"]:
        scores = {}
        best = None
        for name in fixed or ["source", "filled", "octree 7", "octree 8", "octree 6", "octree 5"]:
            if name.startswith("octree") and best is not None:
                break  # remeshes only when no source-based mesh fits the budget
            if name not in solids:
                solids[name] = candidate_solid(pid, obj, name)
            shape = int(tris * GEOMETRY_SHARE)
            lod = decimate(solids[name], shape)
            n = len(lod.data.polygons)
            if n <= shape * 1.02:
                refine(lod, tris)
                n = len(lod.data.polygons)
            if n > tris * 1.02:
                scores[name] = f"stalled at {n}"
                bpy.data.objects.remove(lod)
                continue
            err = ref.error(lod)
            scores[name] = round(err, 5)
            if best is None or err < best[1]:
                if best is not None:
                    bpy.data.objects.remove(best[2])
                best = (name, err, lod)
            else:
                bpy.data.objects.remove(lod)
        if best is None:
            raise RuntimeError(f"no candidate decimates to {tris} triangles ({scores})")
        name, err, lod = best
        print(f"{pid}: {tris} tris -> {name} ({scores})", flush=True)
        chosen.append({"mesh": name, "error": round(err, 5), "scores": scores})
        pos, nrm, col, mat, order = corner_data(lod, sampler, base_levels, mr_levels, FIX.get(pid, {}).get("smooth", 40))
        ao = bake_ao(lod)[order]
        # Blender (x, y, z up) -> game (x, y up, z front): front is -Y in Blender.
        gpos = np.stack([pos[:, 0], pos[:, 2], -pos[:, 1]], 1)
        gnrm = np.stack([nrm[:, 0], nrm[:, 2], -nrm[:, 1]], 1)
        # Blender's corner winding is CCW seen from outside with z up; the axis swap is a proper rotation, so it holds.
        lods_raw.append((gpos, gnrm, col, ao, mat))
        bpy.data.objects.remove(lod)
    for solid in solids.values():
        bpy.data.objects.remove(solid)
    # The remesh grows the surface by up to half a cell and drops shreds that set the first fit (a fern's fronds, a
    # counter's stray tap): fit the finished meshes to the catalogue again, with the pivot back on the floor.
    glo = np.min([l[0].min(0) for l in lods_raw], 0)
    ghi = np.max([l[0].max(0) for l in lods_raw], 0)
    w, h, d = spec["size"]
    ratio = np.array([w, h, d]) / np.maximum(ghi - glo, 1e-6)
    s = float(np.exp(np.log(ratio[[0, 2]]).mean()))
    per = np.clip(ratio / s, 0.88, 1.12) * s
    per[1] = ratio[1]
    if spec["role"] == "clutter":
        per[:] = float(np.exp(np.log(ratio).mean()))
    pivot = np.array([(glo[0] + ghi[0]) / 2, glo[1], (glo[2] + ghi[2]) / 2])
    for l in lods_raw:
        l[0][:] = (l[0] - pivot) * per
        l[1][:] = l[1] / per
    lo = np.min([l[0].min(0) for l in lods_raw], 0)
    hi = np.max([l[0].max(0) for l in lods_raw], 0)
    lods = [pack_lod(*l, lo, hi) for l in lods_raw]
    out = os.path.join(OUT, f"{pid}.prop")
    write_prop(out, lods, lo.tolist(), hi.tolist())
    files = preview(pid, lods[0][0], lods[0][1], lo, hi, spec["lod"][0])
    rec = {
        "id": pid, "yaw": yaw, "size": [round(v, 3) for v in (hi - lo).tolist()], "islands": islands, "dropped_faces": dropped, "hidden_faces": hidden, "flipped_faces": flipped,
        "lods": [{"verts": int(len(v)), "tris": int(len(i) // 3)} for v, i in lods], "bytes": os.path.getsize(out),
        "mesh": chosen, "seconds": round(time.time() - t0, 1), "preview": files,
    }
    return rec


report, failed = [], []
for pid in IDS:
    raw = os.path.join(WORK, "raw", f"{pid}.glb")
    if not os.path.exists(raw):
        print(f"{pid}: no raw glb, skipped")
        continue
    try:
        rec = build(pid, raw)
    except Exception as e:  # one bad mesh should not cost the batch
        print(f"FAILED {pid}: {e}", flush=True)
        failed.append({"id": pid, "error": str(e)})
        continue
    report.append(rec)
    print("PROP " + json.dumps(rec), flush=True)

json.dump(report, open(os.path.join(WORK, "cleanup-report.json"), "w"), indent=1)
json.dump(failed, open(os.path.join(WORK, "cleanup-failed.json"), "w"), indent=1)
