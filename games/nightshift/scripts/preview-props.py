"""Headless neutral three-angle review of generated GLBs; never edits the sources.

Blender --background --factory-startup --python preview-props.py -- INPUT_DIR OUTPUT_DIR
"""
import bpy
import hashlib
import json
import sys
from pathlib import Path
from mathutils import Matrix, Vector


def main():
    source, output = map(Path, sys.argv[sys.argv.index("--") + 1:])
    paths = sorted(source.glob("*.glb"))
    if not paths:
        raise RuntimeError(f"No completed GLBs in {source}")
    output.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = True
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 2
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.world.color = (.15, .15, .15)
    scene.view_settings.view_transform = "AgX"
    camera_data = bpy.data.cameras.new("Review camera")
    camera = bpy.data.objects.new("Review camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 2.8
    for name, location, power, size in [("Key", (3, -4, 5), 700, 4), ("Fill", (-3, -1, 3), 450, 3), ("Rim", (1, 3, 4), 500, 3)]:
        data = bpy.data.lights.new(name, "AREA")
        data.energy, data.shape, data.size = power, "DISK", size
        lamp = bpy.data.objects.new(name, data)
        scene.collection.objects.link(lamp)
        lamp.location = location
        lamp.rotation_euler = (Vector((0, 0, .8)) - lamp.location).to_track_quat("-Z", "Y").to_euler()
    report = {"blender": bpy.app.version_string, "engine": scene.render.engine, "samples": scene.cycles.samples, "assets": []}
    for path in paths:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(path))
        objects = set(bpy.data.objects) - before
        meshes = [obj for obj in objects if obj.type == "MESH"]
        points = [obj.matrix_world @ Vector(p) for obj in meshes for p in obj.bound_box]
        lo = Vector([min(p[k] for p in points) for k in range(3)])
        hi = Vector([max(p[k] for p in points) for k in range(3)])
        centre = Vector(((hi.x+lo.x)/2, (hi.y+lo.y)/2, lo.z))
        scale = 1.8 / max(hi-lo)
        # Normalize the disposable scene with object transforms, avoiding slow
        # per-vertex RNA writes on dense imports. Source geometry stays intact.
        worlds = {obj: obj.matrix_world.copy() for obj in meshes}
        for obj in meshes:
            obj.parent = None
            obj.matrix_world = Matrix.Translation(-centre * scale) @ Matrix.Scale(scale, 4) @ worlds[obj]
            obj.data.calc_loop_triangles()
        record = {"id": path.stem, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size,
                  "bounds": [list(lo), list(hi)], "triangles": sum(len(obj.data.loop_triangles) for obj in meshes),
                  "materials": [m.name for obj in meshes for m in obj.data.materials]}
        target = Vector((0, 0, (hi.z-lo.z)*scale*.5))
        for name, location in [("front", (0, -4, 1.4)), ("three-quarter", (3, -4, 2.5)), ("back", (-3, 4, 2.5))]:
            camera.location = location
            camera.rotation_euler = (target-camera.location).to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = str(output / f"{path.stem}-{name}.png")
            bpy.ops.render.render(write_still=True)
        report["assets"].append(record)
        for obj in objects:
            bpy.data.objects.remove(obj, do_unlink=True)
    (output / "report.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
