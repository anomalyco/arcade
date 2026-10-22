"""Renders walk-compare.ts OBJ sequences side by side (one Blender session): for each frame index, each named
sequence (<dir>/<name>-<i>.obj) from the side, in place, with a floor line, into <dir>/<name>-<i>.png.

  blender -b --factory-startup --python scripts/people/walk-render.py -- <dir> <frames> <name> [<name>...] [--view side]
"""

import math
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
view = argv[argv.index("--view") + 1] if "--view" in argv else "side"
args = [a for i, a in enumerate(argv) if not a.startswith("--") and (i == 0 or argv[i - 1] != "--view")]
DIR, N, names = args[0], int(args[1]), args[2:]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.display.shading.show_cavity = True
scene.world = bpy.data.worlds.new("w")
scene.world.color = (0.3, 0.31, 0.33)
scene.render.resolution_x, scene.render.resolution_y = 520, 760
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scene.collection.objects.link(cam)
scene.camera = cam
cam.data.type = "ORTHO"
cam.data.ortho_scale = 2.3
# OBJ y-up world -> Blender z-up: (x, y, z) -> (x, -z, y). Side: looking along +Y (the walker's right side).
d = {"side": Vector((0, -1, 0)), "front": Vector((1, 0, 0)), "three": Vector((0.6, -0.8, 0)).normalized()}[view]
centre = Vector((0.15, 0, 0.98))
cam.location = centre + d * 6
cam.rotation_euler = (math.radians(90), 0, math.atan2(d.x, -d.y))
bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0, 0))
floor = bpy.context.object
fm = bpy.data.materials.new("floor")
fm.diffuse_color = (0.42, 0.43, 0.45, 1)
floor.data.materials.append(fm)

for i in range(N):
    for name in names:
        before = set(scene.objects)
        bpy.ops.wm.obj_import(filepath=f"{DIR}/{name}-{i}.obj", forward_axis="NEGATIVE_Z", up_axis="Y")
        new = [o for o in scene.objects if o not in before]
        for o in new:
            if o.type == "MESH":
                for p in o.data.polygons:
                    p.use_smooth = True
        scene.render.filepath = f"{DIR}/{name}-{i}.png"
        bpy.ops.render.render(write_still=True)
        for o in new:
            bpy.data.objects.remove(o, do_unlink=True)
print("WALK RENDERED", N, names)
