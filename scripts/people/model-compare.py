"""Model assessment: one figure per run (our MakeHuman cast GLB, or a Microsoft Rocketbox avatar, MIT) in one EEVEE
studio light, framed from its own posed vertices and bones: <out>-body.png, <out>-face.png, <out>-hand.png.

  blender -b --factory-startup --python scripts/people/model-compare.py -- <out> <ours.glb | rocketbox dir>
  (a Rocketbox dir holds Export/<name>.fbx and Textures/)
"""

import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT, SRC = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
scene.world = bpy.data.worlds.new("w")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.05, 0.055, 0.06, 1)
views = [v.identifier for v in scene.view_settings.bl_rna.properties["view_transform"].enum_items]
scene.view_settings.view_transform = "AgX" if "AgX" in views else "Filmic"

if SRC.endswith(".glb"):
    bpy.ops.import_scene.gltf(filepath=SRC)
    # The GLB carries both levels of detail on one skeleton: keep the near one.
    for o in list(bpy.data.objects):
        if o.type == "MESH" and o.name.startswith("LOD1"):
            bpy.data.objects.remove(o, do_unlink=True)
    hand_names, head_names = ("hand_r",), ("head",)
else:
    name = os.path.basename(SRC.rstrip("/"))
    bpy.ops.import_scene.fbx(filepath=f"{SRC}/Export/{name}.fbx")
    tex = {f: os.path.join(SRC, "Textures", f) for f in os.listdir(os.path.join(SRC, "Textures"))}

    def image(suffix, prefix):
        for f, p in tex.items():
            if f.startswith(prefix) and f.lower().endswith(suffix):
                return bpy.data.images.load(p, check_existing=True)
        return None

    # Rewire each material from its own maps: <id>_<part>_color/_normal, and <id>_opacity_color with alpha.
    for m in bpy.data.materials:
        m.use_nodes = True
        nt = m.node_tree
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not bsdf:
            continue
        old = [n.image.name for n in nt.nodes if n.type == "TEX_IMAGE" and n.image]
        key = " ".join([m.name, *old]).lower()
        part = "opacity" if "opacity" in key else "head" if "head" in key else "body"
        prefix = next((f.split("_")[0] for f in tex if f.lower().endswith(".tga")), "")
        for n in [n for n in nt.nodes if n.type in ("TEX_IMAGE", "NORMAL_MAP", "BUMP")]:
            nt.nodes.remove(n)
        col = image(f"{part}_color.tga", prefix)
        if col:
            t = nt.nodes.new("ShaderNodeTexImage"); t.image = col
            nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
            if part == "opacity":
                nt.links.new(t.outputs["Alpha"], bsdf.inputs["Alpha"])
                m.blend_method = "HASHED"
            else:
                bsdf.inputs["Alpha"].default_value = 1.0
                m.blend_method = "OPAQUE"
        nrm = image(f"{part}_normal.tga", prefix)
        if nrm:
            nrm.colorspace_settings.name = "Non-Color"
            t = nt.nodes.new("ShaderNodeTexImage"); t.image = nrm
            nm = nt.nodes.new("ShaderNodeNormalMap")
            nt.links.new(t.outputs["Color"], nm.inputs["Color"])
            nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
        bsdf.inputs["Roughness"].default_value = 0.6
        bsdf.inputs["Metallic"].default_value = 0.0
    hand_names, head_names = ("bip01 r hand",), ("bip01 head",)

bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
for o in bpy.data.objects:
    # Skip the glTF importer's bone-shape icosphere (no material).
    if o.type != "MESH" or not any(s.material for s in o.material_slots):
        continue
    e = o.evaluated_get(dg)
    me = e.to_mesh()
    for v in me.vertices:
        w = e.matrix_world @ v.co
        lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
    e.to_mesh_clear()


def bone(names):
    for arm in [o for o in bpy.data.objects if o.type == "ARMATURE"]:
        for b in arm.pose.bones:
            if b.name.lower() in names:
                return arm.matrix_world @ b.head, arm.matrix_world @ b.tail
    return None


H = hi.z - lo.z
mid = (lo + hi) / 2
for nm, d, energy, col in (("key", (-0.8, -1.0, 0.6), 900, (1.0, 0.95, 0.88)), ("fill", (1.0, -0.8, 0.2), 250, (0.85, 0.9, 1.0)), ("rim", (0.2, 1.0, 0.5), 500, (1.0, 1.0, 1.0))):
    L = bpy.data.objects.new(nm, bpy.data.lights.new(nm, "AREA"))
    L.data.energy, L.data.color, L.data.size = energy * (H / 1.78) ** 2, col, 2.0 * H / 1.78
    L.location = Vector((mid.x, mid.y, lo.z + 0.55 * H)) + Vector(d).normalized() * 4.0 * H / 1.78
    L.rotation_euler = (Vector((mid.x, mid.y, lo.z + 0.55 * H)) - L.location).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(L)

cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scene.collection.objects.link(cam)
scene.camera = cam
# Both face -Y (the glTF importer turns +Z forward into -Y); FRONT=1 in the environment flips the camera.
front = 1 if os.environ.get("FRONT") == "1" else -1
head = bone(head_names)


def shoot(path, centre, ortho, w, h):
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = ortho
    cam.data.clip_end = 100 * H
    cam.location = Vector(centre) + Vector((0, front * 8 * H, 0))
    cam.rotation_euler = (math.radians(90), 0, math.radians(180) if front > 0 else 0)
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


shoot(f"{OUT}-body.png", (mid.x, mid.y, mid.z), H * 1.06, 600, 1000)
if head:
    c = (head[0] + head[1]) / 2
    shoot(f"{OUT}-face.png", (c.x, c.y, c.z + 0.02 * H), 0.2 * H, 600, 600)
hand = bone(hand_names)
if hand:
    c = hand[0] + (hand[1] - hand[0]).normalized() * 0.05 * H
    shoot(f"{OUT}-hand.png", (c.x, c.y, c.z), 0.15 * H, 600, 600)
print("COMPARED", SRC, "height", round(H, 3), "head", bool(head), "hand", bool(hand))
