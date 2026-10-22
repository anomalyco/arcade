"""Asset QA: imports built people GLBs in a row and renders front and three-quarter-back views (Eevee, flat studio light).

  blender -b --factory-startup --python scripts/people/lineup.py -- <out.png> <a.glb> [<b.glb> ...]
"""

import math
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT, FILES = argv[0], argv[1:]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
spacing = 0.9
for i, f in enumerate(FILES):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=f)
    for o in set(bpy.data.objects) - before:
        if o.parent is None:
            o.location.x += (i - (len(FILES) - 1) / 2) * spacing
        # Only the full detail level.
        if o.type == "MESH" and o.name.startswith("LOD1"):
            o.hide_render = True

world = bpy.data.worlds.new("w")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.32, 0.33, 0.35, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
for rot, energy in (((math.radians(50), 0, math.radians(30)), 3.5), ((math.radians(60), 0, math.radians(200)), 1.5)):
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = energy
    sun.rotation_euler = rot
    scene.collection.objects.link(sun)

scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items] else "BLENDER_EEVEE"
width = max(1, len(FILES)) * spacing + 0.6
scene.render.resolution_x = int(260 * max(1, len(FILES)))
scene.render.resolution_y = 560
scene.render.film_transparent = False

cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scene.collection.objects.link(cam)
scene.camera = cam
cam.data.type = "ORTHO"
cam.data.ortho_scale = max(width, 2.1 * scene.render.resolution_x / scene.render.resolution_y)
paths = []
for name, yaw in (("front", 0.0), ("back", 180.0 - 35.0)):
    a = math.radians(yaw)
    # glTF imports face +Y in Blender after the axis conversion? MPFB humans face -Y: look from -Y for the front.
    d = Vector((math.sin(a), -math.cos(a), 0))
    cam.location = Vector((0, 0, 0.95)) + d * 8
    cam.rotation_euler = (math.radians(90), 0, math.atan2(d.x, -d.y))
    path = OUT.replace(".png", f"-{name}.png")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    paths.append(path)
print("LINEUP", paths)
