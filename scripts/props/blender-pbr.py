"""Cycles high-to-low PBR transfer. Imported by blender-cleanup.py inside Blender.

Base colour and scalar channels are baked as emission, never combined lighting.
This preserves the source reflectance; it cannot remove lighting already in a generated image.
"""
import math
import os

import bpy
import numpy as np


def select(*objects, active):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = active


def texture_size_for(area, uv_area, density, max_size, min_size=128):
    """Smallest power of two that holds `density` texels per metre over the packed UVs, within [min_size, max_size].

    The UV coverage counts: a 30%-packed sheet needs √(1/0.3) ≈ 1.8x the side of a full one for the same density.
    """
    want = density * math.sqrt(area / max(uv_area, 1e-9))
    return int(min(max_size, max(min_size, 2 ** math.ceil(math.log2(max(want, 1.0))))))


def uv_and_surface_area(low):
    low.data.calc_loop_triangles()
    uv = low.data.uv_layers.active.data
    uv_area = 0.0
    for triangle in low.data.loop_triangles:
        a, b, c = (uv[i].uv for i in triangle.loops)
        uv_area += abs((b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x)) * 0.5
    return sum(face.area for face in low.data.polygons), uv_area


def pack_uvs(size):
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, margin_method="FRACTION", margin=2 / size)
    bpy.ops.object.mode_set(mode="OBJECT")


def bake_pbr(source, low, path, size=None, density=256.0, max_size=512, samples=32):
    """Bake at `size`, or at the library's texel `density` (texels/m) capped at `max_size` when `size` is None."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.render.bake.use_selected_to_active = True
    scene.render.bake.use_clear = True
    diagonal = source.dimensions.length
    scene.render.bake.cage_extrusion = diagonal * 0.025
    scene.render.bake.max_ray_distance = diagonal * 0.05
    scene.render.bake.normal_space = "TANGENT"
    scene.render.bake.target = "IMAGE_TEXTURES"

    select(low, active=low)
    # Normalise island density by surface area before packing; no overlapping source UVs survive.
    while low.data.uv_layers:
        low.data.uv_layers.remove(low.data.uv_layers[0])
    low.data.uv_layers.new(name="UVMap")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0)
    bpy.ops.uv.average_islands_scale()
    bpy.ops.object.mode_set(mode="OBJECT")
    pack_uvs(size or max_size)
    if size is None:
        # Repack only if the density size changes the two-texel margin.
        size = texture_size_for(*uv_and_surface_area(low), density, max_size)
        if size != max_size:
            pack_uvs(size)
    scene.render.bake.margin = max(4, size // 64)
    for face in low.data.polygons:
        face.use_smooth = True
    low.data.set_sharp_from_angle(angle=math.radians(40))
    # Triangulate before baking so the exported tangent frame uses the same triangles.
    tri = low.modifiers.new("bake-triangles", "TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=tri.name)
    low.data.materials.clear()
    target = bpy.data.materials.new("baked-pbr")
    target.use_nodes = True
    low.data.materials.append(target)
    for face in low.data.polygons:
        face.material_index = 0
    low.data.validate()
    nodes, links = target.node_tree.nodes, target.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    image_node = nodes.new("ShaderNodeTexImage")

    # Isolate this pair; candidate meshes must not occlude the AO bake.
    visibility = [(obj, obj.hide_render) for obj in scene.objects]
    for obj, _ in visibility:
        obj.hide_render = obj not in (source, low)
    channels = {}
    rewired = []
    try:
        for name, kind, socket in [("base", "EMIT", "Base Color"),
                                   ("roughness", "EMIT", "Roughness"),
                                   ("metallic", "EMIT", "Metallic"),
                                   ("normal", "NORMAL", None), ("ao", "AO", None)]:
            image = bpy.data.images.new(name, width=size, height=size, alpha=False, float_buffer=True)
            image.colorspace_settings.name = "sRGB" if name == "base" else "Non-Color"
            image_node.image = image
            nodes.active = image_node
            # Temporarily route exactly the source input through emission. Restore for normal/AO.
            if socket:
                for material in source.data.materials:
                    if not material or not material.use_nodes:
                        raise ValueError("PBR baking requires source node materials")
                    tree = material.node_tree
                    principled = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
                    output = next((n for n in tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
                    if not principled or not output:
                        raise ValueError("PBR baking requires a Principled source material")
                    previous = [link.from_socket for link in output.inputs["Surface"].links]
                    emit = tree.nodes.new("ShaderNodeEmission")
                    inp = principled.inputs[socket]
                    if inp.is_linked:
                        tree.links.new(inp.links[0].from_socket, emit.inputs["Color"])
                    else:
                        value = inp.default_value
                        emit.inputs["Color"].default_value = tuple(value) if socket == "Base Color" else (value, value, value, 1)
                    tree.links.new(emit.outputs[0], output.inputs["Surface"])
                    rewired.append((tree, emit, output, previous))
            select(source, low, active=low)
            bpy.ops.object.bake(type=kind)
            channels[name] = image
            for tree, emit, output, previous in rewired:
                tree.nodes.remove(emit)
                for old in previous:
                    tree.links.new(old, output.inputs["Surface"])
            rewired.clear()
    finally:
        for tree, emit, output, previous in rewired:
            tree.nodes.remove(emit)
            for old in previous:
                tree.links.new(old, output.inputs["Surface"])
        for obj, hidden in visibility:
            obj.hide_render = hidden

    def pixels(image):
        result = np.empty(size * size * 4, dtype=np.float32)
        image.pixels.foreach_get(result)
        return result.reshape(-1, 4)

    orm = bpy.data.images.new("orm", width=size, height=size, alpha=False)
    orm.colorspace_settings.name = "Non-Color"
    packed = np.ones((size * size, 4), dtype=np.float32)
    for channel, name in enumerate(["ao", "roughness", "metallic"]):
        packed[:, channel] = pixels(channels[name])[:, 0]
    orm.pixels.foreach_set(packed.ravel())
    channels["orm"] = orm
    # Persist PNG inputs for glTF export. Compression into WebP is a separate glTF-Transform step.
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for name in ["base", "normal", "orm"]:
        image = channels[name]
        image.filepath_raw = path.removesuffix(".glb") + f"-{name}.png"
        image.file_format = "PNG"
        image.save()
        image.pack()

    image_node.image = channels["base"]
    links.new(image_node.outputs["Color"], bsdf.inputs["Base Color"])
    normal = nodes.new("ShaderNodeTexImage")
    normal.image = channels["normal"]
    normal_map = nodes.new("ShaderNodeNormalMap")
    links.new(normal.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    orm_node = nodes.new("ShaderNodeTexImage")
    orm_node.image = orm
    split = nodes.new("ShaderNodeSeparateColor")
    links.new(orm_node.outputs["Color"], split.inputs[0])
    links.new(split.outputs["Green"], bsdf.inputs["Roughness"])
    links.new(split.outputs["Blue"], bsdf.inputs["Metallic"])
    # Blender's glTF exporter recognises this group as the glTF occlusion input.
    group = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
    group.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    occlusion = nodes.new("ShaderNodeGroup")
    occlusion.node_tree = group
    links.new(split.outputs["Red"], occlusion.inputs["Occlusion"])
    select(low, active=low)
    low.name = "LOD0"
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                              export_texcoords=True, export_normals=True, export_materials="EXPORT",
                              export_yup=True)
    area, uv_area = uv_and_surface_area(low)
    return {"texture_size": size, "texel_density_target": density, "texels_per_metre": round(size * math.sqrt(uv_area / max(area, 1e-9)), 1),
            "uv_coverage": round(uv_area, 4), "gpu_texture_bytes_with_mips": size * size * 4 * 3 * 4 // 3,
            "albedo": "source base colour only; no new lighting baked, source lighting not removed"}
