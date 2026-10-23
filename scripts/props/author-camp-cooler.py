"""Original unbranded camp cooler, metres, Blender Z-up. Offline source for the PBR transfer pipeline.

blender -b --factory-startup --python-exit-code 1 -P scripts/props/author-camp-cooler.py -- /path/raw/camp-cooler.glb
"""
import os
import sys

import bpy
import numpy as np

out = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
rng = np.random.default_rng(23)


def material(name, color, roughness, metallic=0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    shader = nodes.get("Principled BSDF")
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    image = bpy.data.images.new(name + "-reflectance", width=256, height=256)
    image.colorspace_settings.name = "sRGB"
    noise = rng.uniform(0.88, 1.03, (256, 256, 1))
    rgba = np.ones((256, 256, 4), np.float32)
    rgba[:, :, :3] = np.clip(np.array(color) * noise, 0, 1)
    image.pixels.foreach_set(rgba.ravel())
    image.pack()
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    links.new(tex.outputs["Color"], shader.inputs["Base Color"])
    return mat


body = material("faded-olive-plastic", (0.16, 0.22, 0.12), 0.78)
lid = material("aged-cream-plastic", (0.65, 0.60, 0.45), 0.68)
rubber = material("dark-rubber", (0.045, 0.05, 0.04), 0.95)
metal = material("steel-latch", (0.42, 0.44, 0.46), 0.32, 1)
parts = []


def box(name, at, size, mat, bevel):
    bpy.ops.mesh.primitive_cube_add(size=1, location=at)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    mod = obj.modifiers.new("rounded moulding", "BEVEL")
    mod.width = bevel
    mod.segments = 4
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.data.materials.append(mat)
    parts.append(obj)


box("cooler body", (0, 0, 0.17), (0.58, 0.35, 0.32), body, 0.025)
box("lid gasket", (0, 0, 0.328), (0.585, 0.355, 0.012), rubber, 0.01)
box("rounded lid", (0, 0, 0.36), (0.61, 0.38, 0.055), lid, 0.018)
box("lid inset", (0, 0, 0.389), (0.49, 0.27, 0.009), lid, 0.004)
for side in (-1, 1):
    box("handle mount", (side * 0.298, 0, 0.255), (0.018, 0.16, 0.045), lid, 0.006)
    box("handle grip", (side * 0.321, 0, 0.195), (0.022, 0.17, 0.025), lid, 0.009)
    for y in (-0.072, 0.072):
        box("handle side", (side * 0.32, y, 0.225), (0.022, 0.023, 0.08), lid, 0.007)
    for y in (-0.13, 0.13):
        box("rubber foot", (side * 0.23, y, 0.012), (0.075, 0.06, 0.024), rubber, 0.006)
box("latch", (0, -0.188, 0.32), (0.045, 0.015, 0.07), metal, 0.004)
bpy.ops.object.select_all(action="DESELECT")
for obj in parts:
    obj.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
os.makedirs(os.path.dirname(out), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True)
