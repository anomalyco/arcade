"""Renders posed people OBJs (scripts/people/pose-obj.ts) for close inspection: a whole-body side view and a crop
round a point (a hand), Workbench studio light, flat colours by piece.

  blender -b --factory-startup --python scripts/people/pose-render.py -- <out-prefix> <obj> [--look x,y,z] [--size 0.3]
      [--view side|front|three]
"""

import math
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT, OBJ = argv[0], argv[1]


def opt(name, default):
    return argv[argv.index(name) + 1] if name in argv else default


look = [float(x) for x in opt("--look", "0,1,0").split(",")]
size = float(opt("--size", "0.3"))
view = opt("--view", "side")

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.obj_import(filepath=OBJ, forward_axis="NEGATIVE_Z", up_axis="Y")
for o in bpy.context.scene.objects:
    for p in o.data.polygons:
        p.use_smooth = True
scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.display.shading.show_cavity = True
scene.render.film_transparent = False
scene.world = bpy.data.worlds.new("w")
scene.world.color = (0.3, 0.31, 0.33)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scene.collection.objects.link(cam)
scene.camera = cam
cam.data.type = "ORTHO"
# OBJ y-up world -> Blender z-up: (x, y, z) -> (x, -z, y)
target = Vector((look[0], -look[2], look[1]))
dirs = {"side": Vector((0, -1, 0)), "front": Vector((1, 0, 0)), "three": Vector((0.7, -0.7, 0)).normalized()}
d = dirs[view]


def shoot(path, centre, scale, res):
    cam.data.ortho_scale = scale
    cam.location = centre + d * 6
    cam.rotation_euler = (math.radians(90), 0, math.atan2(d.x, -d.y))
    scene.render.resolution_x = scene.render.resolution_y = res
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


shoot(OUT + "-crop.png", target, size, 600)
centre = Vector((look[0], -look[2], 0.95))
shoot(OUT + "-body.png", centre, 2.1, 700)
print("RENDERED", OUT)
