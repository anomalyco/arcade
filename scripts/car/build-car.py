"""Converts Daniel Zhabotinsky's "Kiri '86" (CC BY 4.0, Sketchfab 5c17c582...; a crisp, boxy, upright Japanese saloon)
into Barbara's car, standing in for her blue 1993 Lexus ES (STORY.md), for scripts/car/build-car.ts:

  blender -b --factory-startup --python scripts/car/build-car.py -- <source.glb> <out.glb> <scratch dir> [preview dir]

Metres, glTF Y up, nose towards -Z, the driver's side on -X, the tyres touching y = 0. The source is rebuilt into one
object per material kind (`KINDS`), each with a decimated LOD1 copy. The driver's door (its skin, inner panel, card and
glass) hangs from its own node at the front hinge, swung out `DOOR_OPEN`. The paint gets new maps (dark metallic blue
under a gloss clear coat, a light film of dust and pollen on the roof, hood and trunk, road grime low down), the glass a
dark gloss, and the roof, hood and trunk a few fallen leaves; a pink donut box sits on the passenger seat. Badges go. Prints `CAR {json}` with triangle counts and the heights
night-view.ts puts its evidence at.
"""

import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT, TMP = argv[0], argv[1], argv[2]
PREVIEW = argv[3] if len(argv) > 3 else ""
os.makedirs(TMP, exist_ok=True)

#: m. At this length the source's proportions give a 1993 ES 300's width and height (4.77 x 1.78 x 1.40 m).
LENGTH = 4.62
DOOR_OPEN = math.radians(55)
#: Linear albedo of the paint: a dark metallic blue (sRGB about 0.09, 0.15, 0.30). Paint gets this much metal where clean.
PAINT = (0.008, 0.019, 0.073)
PAINT_METAL = 0.25
DUST = (0.20, 0.18, 0.15)
#: How much of the drifts' dust settles: a car parked a day or two under trees, not one abandoned for months.
DUST_AMOUNT = 0.45
GRIME = (0.060, 0.050, 0.038)
#: Texture size cap (px) per kind; the paint's own maps are made at this size.
PX = {"paint": 1024, "body": 1024, "cabin": 1024, "wheel": 512, "lens": 512, "reflector": 512}
#: LOD1 decimation ratio per kind.
LOD1 = {"paint": 0.4, "body": 0.3, "cabin": 0.3, "wheel": 0.35, "glass": 1.0, "lens": 0.5, "reflector": 0.5, "plate": 1.0, "litter": 1.0}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

# --- Flatten: every mesh in world space, single user, empties gone. ------------------------------------------------------
DROP = ("Engine", "Hood_inner", "Trunk_door_inner", "Grill_badge", "Body_badge", "Door_badge")
for o in list(bpy.data.objects):
    if o.type == "MESH" and o.name.startswith(DROP):
        bpy.data.objects.remove(o)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
for o in meshes:
    w = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = w
for o in [o for o in bpy.data.objects if o.type != "MESH"]:
    bpy.data.objects.remove(o)
bpy.ops.object.select_all(action="SELECT")
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.make_single_user(object=True, obdata=True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Source: nose towards -X, driver's side -Y, Z up, centimetre-ish. Turn the nose to +Y (glTF -Z), scale to LENGTH and
# stand the tyres on z = 0.
lo = Vector((min(min((o.matrix_world @ Vector(c))[i] for c in o.bound_box) for o in meshes) for i in range(3)))
hi = Vector((max(max((o.matrix_world @ Vector(c))[i] for c in o.bound_box) for o in meshes) for i in range(3)))
s = LENGTH / (hi.x - lo.x)
centre = (lo + hi) / 2
fit = Matrix.Rotation(-math.pi / 2, 4, "Z") @ Matrix.Scale(s, 4) @ Matrix.Translation((-centre.x, -centre.y, -lo.z))
for o in meshes:
    o.data.transform(fit)
    o.data.update()

# --- Kinds ---------------------------------------------------------------------------------------------------------------
LAMPS, PLATES = "krmlgtbdy85_headlights", "Numberplates_dif"
SOURCE_KIND = {"Bodycolor": "paint", "UCB_BOTTOM": "body", "GEN4DR_INTERIOR": "cabin", "RIMSTOCK_02_1": "wheel", "UCB_GLASS_CLEAN": "glass", PLATES: "plate"}


def kind_of(o):
    src = o.data.materials[0].name
    if src == LAMPS:
        return "reflector" if o.name.startswith("Brakelights") else "lens"
    if src == PLATES and o.name.startswith("Numberplate_front"):
        return "plate.front"
    return SOURCE_KIND[src]


DOOR = ("Door_FL_", "Door_inner_FL_", "Doorcard_FL_", "Glass_door_FL_")
parts = [(o, kind_of(o), o.name.startswith(DOOR)) for o in meshes]


def source_images(name):
    """A source material's maps by role, plus its constant base `color` and, with no ORM map, its `rough` and `metal`.

    The glTF importer puts a MIX (multiply) node between the base map and the BSDF when the base colour factor isn't 1,
    so links are followed through MIX nodes and the factor is kept as `color`."""
    m = bpy.data.materials[name]
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    out = {"color": (1, 1, 1), "rough": bsdf.inputs["Roughness"].default_value, "metal": bsdf.inputs["Metallic"].default_value}
    for n in m.node_tree.nodes:
        if n.type != "TEX_IMAGE" or not n.image:
            continue
        for link in n.outputs["Color"].links:
            to = link.to_node
            while to.type == "MIX" and to.outputs["Result"].links:
                factor = next((i.default_value for i in to.inputs if i.type == "RGBA" and i.enabled and not i.is_linked), None)
                if factor is not None and to.blend_type == "MULTIPLY":
                    out["color"] = tuple(a * b for a, b in zip(out["color"], factor[:3]))
                to = to.outputs["Result"].links[0].to_node
            if to.type == "BSDF_PRINCIPLED":
                out["base"] = n.image
            elif to.type == "NORMAL_MAP":
                out["normal"] = n.image
            elif to.type in ("SEPARATE_COLOR", "SEPRGB"):
                out["orm"] = n.image
    return out


def scaled(img, px, label):
    """A copy of `img` at most px square, saved as PNG in TMP (the exporter re-encodes it as WebP)."""
    copy = img.copy()
    copy.name = label
    if copy.size[0] > px:
        copy.scale(px, px)
    copy.filepath_raw = os.path.join(TMP, label + ".png")
    copy.file_format = "PNG"
    copy.save()
    out = bpy.data.images.load(copy.filepath_raw)
    out.name = label
    out.colorspace_settings.name = img.colorspace_settings.name
    bpy.data.images.remove(copy)
    return out


def material(label, base=None, orm=None, normal=None, color=(1, 1, 1), rough=1.0, metal=0.0):
    m = bpy.data.materials.new(label)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if base:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = base
        nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    if orm:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = orm
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(t.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    if normal:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = normal
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def cropped(o, img, label):
    """The part of `img` that `o`'s UVs use (a plate out of the plate atlas), its UVs remapped onto it."""
    uv = o.data.uv_layers.active.data
    us, vs = [d.uv.x for d in uv], [d.uv.y for d in uv]
    w, h = img.size
    x0, x1 = max(0, math.floor(min(us) * w) - 2), min(w, math.ceil(max(us) * w) + 2)
    y0, y1 = max(0, math.floor(min(vs) * h) - 2), min(h, math.ceil(max(vs) * h) + 2)
    px = np.asarray(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[y0:y1, x0:x1]
    out = bpy.data.images.new(label, x1 - x0, y1 - y0, alpha=False)
    out.pixels.foreach_set(px.ravel())
    out.filepath_raw = os.path.join(TMP, label + ".png")
    out.file_format = "PNG"
    out.save()
    for d in uv:
        d.uv = ((d.uv.x * w - x0) / (x1 - x0), (d.uv.y * h - y0) / (y1 - y0))
    return out


def rebuilt(kind, src):
    imgs = source_images(src)
    px = PX[kind.split(".")[0]]
    maps = (scaled(imgs[k], px, f"{src}-{k}") if k in imgs else None for k in ("base", "orm", "normal"))
    if "orm" in imgs:
        return material(kind, *maps, color=imgs["color"], rough=1.0, metal=1.0)
    # No ORM map (the lamp atlas): moulded plastic, never metal (metal zeroes MAT.retro's return), and not mirror-smooth.
    return material(kind, *maps, color=imgs["color"], rough=max(0.25, imgs["rough"]), metal=0.0)


# --- Paint maps: a top-down projection for faces facing up, a side one for the rest. ------------------------------------
paint_objs = [o for o, k, _ in parts if k == "paint"]
plo = Vector((min(min(v.co[i] for v in o.data.vertices) for o in paint_objs) for i in range(3)))
phi = Vector((max(max(v.co[i] for v in o.data.vertices) for o in paint_objs) for i in range(3)))
UP = 0.55


def paint_uv(o):
    me = o.data
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    uv = me.uv_layers.new(name="paint").data
    for p in me.polygons:
        top = p.normal.z > UP
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            if top:
                uv[li].uv = (0.5 * (co.x - plo.x) / (phi.x - plo.x), (co.y - plo.y) / (phi.y - plo.y))
            else:
                uv[li].uv = (0.5 + 0.5 * (co.y - plo.y) / (phi.y - plo.y), co.z / phi.z)


for o in paint_objs:
    paint_uv(o)


def noise(h, w, cy, cx, seed):
    """Smooth value noise in 0..1 over an h x w grid with cy x cx cells."""
    g = np.random.default_rng(seed).random((cy + 2, cx + 2))
    y = np.linspace(0, cy, h, endpoint=False)[:, None]
    x = np.linspace(0, cx, w, endpoint=False)[None, :]
    iy, ix = y.astype(int), x.astype(int)
    fy, fx = y - iy, x - ix
    fy, fx = fy * fy * (3 - 2 * fy), fx * fx * (3 - 2 * fx)
    a, b, c, d = g[iy, ix], g[iy, ix + 1], g[iy + 1, ix], g[iy + 1, ix + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(h, w, cy, cx, seed, octaves=5):
    out, amp, total = np.zeros((h, w)), 1.0, 0.0
    for k in range(octaves):
        out += amp * noise(h, w, cy << k, cx << k, seed + k)
        total += amp
        amp *= 0.5
    return out / total


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


N = PX["paint"]
half = N // 2
# Top: width across (x), length along (y). Dust and pollen lie thicker in drifts; a few tannin spots where wet leaves lay.
dust_top = (smooth(0.35, 0.75, fbm(N, half, 6, 3, 11)) * 0.75 + 0.15 * fbm(N, half, 64, 32, 12, 3)) * DUST_AMOUNT
stain = np.zeros((N, half))
rng = np.random.default_rng(5)
yy, xx = np.mgrid[0:N, 0:half]
for _ in range(30):
    cy_, cx_ = rng.random() * N, rng.random() * half
    r = 3 + rng.random() * 9
    a = rng.random() * math.pi
    du, dv = (xx - cx_) * math.cos(a) + (yy - cy_) * math.sin(a), -(xx - cx_) * math.sin(a) + (yy - cy_) * math.cos(a)
    stain = np.maximum(stain, (1 - smooth(0.6, 1.0, np.sqrt((du / r) ** 2 + (dv / (r * 0.5)) ** 2))) * (0.4 + 0.4 * rng.random()))
# Sides: length along (u), height up (v). Grime thickest at the sills and behind the wheels, rain streaks below the glass.
v = (np.arange(N)[:, None] + 0.5) / N * phi.z
u = (np.arange(half)[None, :] + 0.5) / half * (phi.y - plo.y) + plo.y
wheels = [o for o, k, _ in parts if k == "wheel"]
axles = sorted({round(sum(vv.co.y for vv in o.data.vertices) / len(o.data.vertices), 2) for o in wheels})
splash = sum(np.exp(-((u - y0) ** 2) / 0.35) for y0 in axles) * smooth(0.7, 0.2, v)
grime = np.clip(smooth(0.5, 0.15, v) * (0.55 + 0.45 * fbm(N, half, 8, 24, 21)) + 0.5 * splash * fbm(N, half, 16, 48, 22), 0, 1)
streak = smooth(0.7, 0.85, noise(N, half, 3, 90, 31)) * smooth(0.95, 0.75, v) * smooth(0.3, 0.6, v) * fbm(N, half, 12, 4, 32)
side_dust = np.clip(0.1 * fbm(N, half, 32, 64, 33, 3) + 0.15 * streak, 0, 1)


def mix(a, b, t):
    return a * (1 - t[..., None]) + b * t[..., None]


P, D, G = np.array(PAINT), np.array(DUST), np.array(GRIME)
top = mix(mix(P, D, dust_top * 0.85), np.array((0.035, 0.022, 0.012)), stain * 0.5)
side = mix(mix(P, D, side_dust), G, grime * 0.7)
albedo = np.concatenate([top, side], axis=1)
dirt = np.concatenate([np.clip(dust_top + stain * 0.5, 0, 1), np.clip(grime * 0.8 + side_dust, 0, 1)], axis=1)
rough = 0.14 + 0.62 * dirt
# Metallic flake under the clear coat shows only where the paint is clean.
metal = PAINT_METAL * (1 - smooth(0.1, 0.5, dirt))


def save(label, rgb, srgb):
    img = bpy.data.images.new(label, N, N, alpha=False)
    if srgb:
        rgb = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(np.clip(rgb, 0, None), 1 / 2.4) - 0.055)
    px = np.concatenate([np.clip(rgb, 0, 1), np.ones((N, N, 1))], axis=2).astype(np.float32)
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = os.path.join(TMP, label + ".png")
    img.file_format = "PNG"
    img.save()
    img.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
    return img


paint_base = save("paint-base", albedo, True)
paint_orm = save("paint-orm", np.stack([np.ones((N, N)), rough, metal], axis=2), False)

# --- Litter: a palette of leaf tones and the donut box's pinks in one small map. ----------------------------------------
PALETTE = [
    (0.20, 0.10, 0.035), (0.33, 0.17, 0.05), (0.14, 0.07, 0.03), (0.40, 0.26, 0.07),  # brown, rust, dark, ochre
    (0.10, 0.08, 0.035), (0.24, 0.20, 0.06), (0.05, 0.04, 0.025), (0.28, 0.12, 0.04),  # wet, olive, black, red-brown
    (0.80, 0.33, 0.45), (0.62, 0.22, 0.32), (0.85, 0.80, 0.74), (0.55, 0.42, 0.30),    # box pink, box band, white print, card
]
CELL = 4
pal = np.zeros((CELL * 4, CELL * 4, 3))
for i, c in enumerate(PALETTE):
    pal[(i // 4) * CELL:(i // 4 + 1) * CELL, (i % 4) * CELL:(i % 4 + 1) * CELL] = c
N_PAL = CELL * 4
img = bpy.data.images.new("litter", N_PAL, N_PAL, alpha=False)
srgb = np.where(pal <= 0.0031308, pal * 12.92, 1.055 * np.power(pal, 1 / 2.4) - 0.055)
img.pixels.foreach_set(np.concatenate([srgb, np.ones((N_PAL, N_PAL, 1))], axis=2).astype(np.float32).ravel())
img.filepath_raw = os.path.join(TMP, "litter.png")
img.file_format = "PNG"
img.save()
litter_img = img


def cell_uv(i):
    return ((i % 4 + 0.5) / 4, (i // 4 + 0.5) / 4)


# --- Materials -----------------------------------------------------------------------------------------------------------
MATS = {
    "paint": material("paint", paint_base, paint_orm, rough=1.0, metal=1.0),
    "body": rebuilt("body", "UCB_BOTTOM"),
    "cabin": rebuilt("cabin", "GEN4DR_INTERIOR"),
    "wheel": rebuilt("wheel", "RIMSTOCK_02_1"),
    "lens": rebuilt("lens", LAMPS),
    "reflector": rebuilt("reflector", LAMPS),
    **{k: material(k, cropped(o, source_images(PLATES)["base"], k), rough=0.35, metal=0.0) for o, k, _ in parts if k.startswith("plate")},
    # Dark gloss, not see-through: the forest batch has no glass of its own.
    "glass": material("glass", color=(0.008, 0.009, 0.011), rough=0.06, metal=0.0),
    "litter": material("litter", litter_img, rough=0.85, metal=0.0),
}

# --- The car closed: rays for leaves, the box, and the heights night-view.ts needs. -------------------------------------
depsgraph = bpy.context.evaluated_depsgraph_get()


def bvh_of(objs):
    bm = bmesh.new()
    for o in objs:
        bm.from_mesh(o.data)
    bm.faces.ensure_lookup_table()
    tree = BVHTree.FromBMesh(bm)
    return tree, bm


paint_tree, paint_bm = bvh_of(paint_objs)
glass_objs = [o for o, k, _ in parts if k == "glass"]
outer_tree, outer_bm = bvh_of(paint_objs + glass_objs)
cabin_objs = [o for o, k, d in parts if k == "cabin" and not d]
cabin_tree, cabin_bm = bvh_of(cabin_objs)
DOWN = Vector((0, 0, -1))


def down(tree, x, y, z=3.0):
    hit = tree.ray_cast(Vector((x, y, z)), DOWN)
    return hit if hit[0] else None


# Roof: the paint at the top centre line.
roof_z = max(h[0].z for h in (down(outer_tree, 0, y / 100) for y in range(-150, 150, 2)) if h)
roof = [y / 100 for y in range(-150, 150, 2) if (h := down(paint_tree, 0, y / 100)) and h[0].z > roof_z - 0.04]
roof_y = (min(roof), max(roof))
# The rear wing where night-view.ts stands the snapped aerial: 0.6 m out, 0.4 m in from the tail.
WING = (0.6, plo.y + 0.4)
trunk = down(paint_tree, *WING)
# Roof skin samples (glTF car space: x, z, y) for night-view.ts's `roofAt` fit.
roof_grid = [(x / 10, -y / 10, round(h[0].z, 4)) for x in range(-5, 6) for y in range(round(roof_y[0] * 10), round(roof_y[1] * 10) + 1)
             if (h := down(paint_tree, x / 10, y / 10)) and h[0].z > roof_z - 0.12]
# Tyre contacts: each wheel's centre in plan (glTF x, z).
wheel_at = [(round(sum(v.co.x for v in o.data.vertices) / len(o.data.vertices), 3), round(-sum(v.co.y for v in o.data.vertices) / len(o.data.vertices), 3)) for o, k, _ in parts if k == "wheel"]
# Leaves: dropped from above onto the paint where it faces up (roof, hood, trunk, cowl).
leaf_bm = bmesh.new()
uvl = leaf_bm.loops.layers.uv.new("UVMap")
leaves = 0
for _ in range(4000):
    if leaves >= 40:
        break
    x = plo.x * 0.9 + rng.random() * (phi.x - plo.x) * 0.9
    y = plo.y + rng.random() * (phi.y - plo.y)
    hit = down(outer_tree, x, y)
    if not hit or hit[1].z < 0.8 or not down(paint_tree, x, y) or (down(paint_tree, x, y)[0] - hit[0]).length > 1e-4:
        continue
    p, n = hit[0], hit[1]
    length = 0.05 + rng.random() * 0.06
    width = length * (0.45 + rng.random() * 0.25)
    yaw = rng.random() * math.tau
    curl = (rng.random() - 0.3) * 0.25 * length
    t = n.cross(Vector((math.cos(yaw), math.sin(yaw), 0))).normalized()
    b = n.cross(t)
    ring = []
    for k in range(8):
        a = k / 8 * math.tau
        r = (math.cos(a) * length / 2, math.sin(a) * width / 2 * (1 - 0.35 * math.cos(a)))
        lift = 0.004 + curl * (abs(math.sin(a)) ** 2) + 0.004 * rng.random()
        ring.append(leaf_bm.verts.new(p + t * r[0] + b * r[1] + n * lift))
    mid = leaf_bm.verts.new(p + n * (0.003 + curl * 0.2))
    tone = int(rng.integers(0, 8))
    for k in range(8):
        f = leaf_bm.faces.new((mid, ring[k], ring[(k + 1) % 8]))
        for loop in f.loops:
            loop[uvl].uv = cell_uv(tone)
    leaves += 1


# The donut box on the passenger seat: a dozen-box, 36 x 36 x 9 cm, lying on the cushion and following its slope.
def seat_top(x, y):
    hit = down(cabin_tree, x, y, 1.0)
    return hit and hit[0].z


profile = [(y / 100, seat_top(0.38, y / 100)) for y in range(-120, 120, 2)]
cushion = [(y, z) for y, z in profile if z and 0.42 < z < 0.65]
front = [y for y, z in cushion if y > -0.1]
box_y = (min(front) + max(front)) / 2 if front else 0.0
print("SEAT", json.dumps([(round(y, 2), round(z, 3) if z else None) for y, z in profile]))
box_hit = down(cabin_tree, 0.38, box_y, 1.0)


def add_box(bm, centre, normal, size, h, cells):
    """A box resting on (centre, normal); cells = (sides, top, band) palette indices."""
    t = normal.cross(Vector((0, 1, 0))).normalized()
    b = normal.cross(t)
    corners = []
    for dz in (0, h):
        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            corners.append(bm.verts.new(centre + t * (sx * size / 2) + b * (sy * size / 2) + normal * (dz + 0.004)))
    faces = [((4, 5, 6, 7), cells[1]), ((3, 2, 1, 0), cells[0])] + [((i, (i + 1) % 4, (i + 1) % 4 + 4, i + 4), cells[2] if i % 2 else cells[0]) for i in range(4)]
    for idx, c in faces:
        f = bm.faces.new([corners[i] for i in idx])
        for loop in f.loops:
            loop[uvl].uv = cell_uv(c)


if box_hit:
    add_box(leaf_bm, box_hit[0], box_hit[1], 0.36, 0.085, (8, 8, 9))
    # A white printed panel on the lid.
    add_box(leaf_bm, box_hit[0] + box_hit[1] * 0.0855, box_hit[1], 0.2, 0.001, (10, 10, 10))
litter_me = bpy.data.meshes.new("litter")
leaf_bm.to_mesh(litter_me)
litter = bpy.data.objects.new("litter", litter_me)
bpy.context.collection.objects.link(litter)
parts.append((litter, "litter", False))

# --- Door: hinge at its front edge, just inside the skin; the door's parts hang from an empty there. --------------------
door_objs = [o for o, _, d in parts if d]
door_skin = next(o for o, k, d in parts if d and k == "paint")
dx = min(v.co.x for v in door_skin.data.vertices)
dy = max(v.co.y for v in door_skin.data.vertices)
hinge = Vector((dx + 0.035, dy - 0.03, 0))

# --- Merge per kind (door separately), LOD1 copies, export. ------------------------------------------------------------
groups = {}
for o, k, d in parts:
    groups.setdefault((k, d), []).append(o)
stats, lod0 = {}, []
for (k, d), objs in groups.items():
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.data.materials.clear()
    o.data.materials.append(MATS[k])
    for p in o.data.polygons:
        p.material_index = 0
    me = o.data
    while len(me.uv_layers) > 1:
        me.uv_layers.remove(me.uv_layers[1])
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    o.name = f"LOD0.{'door.' if d else ''}{k}"
    lod0.append((o, k, d))

doors = {}
for lod in ("LOD0", "LOD1"):
    e = bpy.data.objects.new(f"{lod}.door", None)
    bpy.context.collection.objects.link(e)
    e.location = hinge
    doors[lod] = e

for o, k, d in lod0:
    stats[o.name] = len(o.data.polygons)
    dup = o.copy()
    dup.data = o.data.copy()
    bpy.context.collection.objects.link(dup)
    dup.name = o.name.replace("LOD0", "LOD1", 1)
    ratio = LOD1[k.split(".")[0]]
    if ratio < 1:
        dec = dup.modifiers.new("Decimate", "DECIMATE")
        dec.ratio = ratio
        dec.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = dup
        bpy.ops.object.modifier_apply(modifier=dec.name)
        dup.data.set_sharp_from_angle(angle=math.radians(50))
    stats[dup.name] = len(dup.data.polygons)
    if d:
        for obj, lod in ((o, "LOD0"), (dup, "LOD1")):
            obj.data.transform(Matrix.Translation(-hinge))
            obj.parent = doors[lod]
            obj.matrix_parent_inverse = Matrix.Identity(4)
            obj.location = (0, 0, 0)

for e in doors.values():
    # Out from the body: the door's rear edge (towards -Y) swings to -X.
    e.rotation_euler = (0, 0, -DOOR_OPEN)
bpy.context.view_layer.update()

# Blender Z up -> glTF Y up: (x, y, z) -> (x, z, -y), so the nose (+Y) faces -Z and the driver's side stays -X.
info = {
    "faces": stats,
    "lod0": sum(v for k, v in stats.items() if k.startswith("LOD0")),
    "lod1": sum(v for k, v in stats.items() if k.startswith("LOD1")),
    "size": [round(phi.x - plo.x, 3), round(phi.z, 3), round(phi.y - plo.y, 3)],
    "roof": {"y": round(roof_z, 3), "z": [round(-roof_y[1], 3), round(-roof_y[0], 3)]},
    "trunk": round(trunk[0].z, 3) if trunk else None,
    "wing": [WING[0], round(-WING[1], 3)],
    "wheels": wheel_at,
    "roofGrid": roof_grid,
    "box": [round(box_hit[0].x, 3), round(box_hit[0].z, 3), round(-box_hit[0].y, 3)] if box_hit else None,
    "hinge": [round(hinge.x, 3), round(-hinge.y, 3)],
    "leaves": leaves,
}

if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    for o in bpy.data.objects:
        if o.name.startswith("LOD1"):
            o.hide_render = True
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_x, scene.render.resolution_y = 1200, 800
    world = bpy.data.worlds.new("w")
    scene.world = world
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    for name, at, to, lens in (("three-quarter", (-5.0, 4.5, 2.2), (0, 0.3, 0.6), 35), ("top", (0, 0, 9), (0, 0, 0), 35),
                               ("door", (-2.6, 0.6, 1.5), (0.2, 0.2, 0.6), 24), ("rear", (3.5, -6, 1.5), (0, 0, 0.6), 35),
                               ("cab", (-1.9, -0.4, 1.25), (0.35, 0.25, 0.5), 28)):
        cam.location = at
        cam.data.lens = lens
        cam.rotation_euler = (Vector(to) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, name + ".png")
        bpy.ops.render.render(write_still=True)
    for o in bpy.data.objects:
        o.hide_render = False

bpy.ops.object.select_all(action="DESELECT")
for o in bpy.data.objects:
    if o.type in ("MESH", "EMPTY"):
        o.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", use_selection=True, export_skins=False, export_animations=False,
    export_morph=False, export_yup=True, export_image_format="WEBP", export_image_quality=86, export_apply=False,
    export_tangents=False, export_extras=False,
)
print("CAR " + json.dumps(info))
