# Blender (headless) half of scripts/woods/fetch-assets.ts: import a glTF, decimate each mesh to a triangle
# budget, and write raw triangle corners (px py pz nx ny nz u v, float32) plus a JSON manifest.
# Usage: blender -b --factory-startup --python blender-export.py -- in.gltf out-prefix '{"budget":4000,"split":false}'
import bpy, bmesh, json, struct, sys

argv = sys.argv[sys.argv.index("--") + 1:]
src, out, opts = argv[0], argv[1], json.loads(argv[2])
budget = int(opts.get("budget", 4000))
split = bool(opts.get("split", False))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]

def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)

def prepare(o, target):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    tris = tri_count(o)
    if tris > target:
        m = o.modifiers.new("dec", "DECIMATE")
        m.ratio = max(0.001, target / tris)
        m.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=m.name)

groups = [[o] for o in meshes] if split else [meshes]
manifest = []
data = bytearray()
total = sum(tri_count(o) for o in meshes) or 1
for gi, group in enumerate(groups):
    floats = []
    lo = [1e9] * 3
    hi = [-1e9] * 3
    images = set()
    gtris = sum(tri_count(o) for o in group)
    for o in group:
        prepare(o, max(64, int(budget * tri_count(o) / (gtris if split else total))))
        for slot in o.material_slots:
            if slot.material and slot.material.use_nodes:
                for n in slot.material.node_tree.nodes:
                    if n.type == "TEX_IMAGE" and n.image:
                        images.add(n.image.name)
        me = o.data
        me.calc_loop_triangles()
        uv = me.uv_layers.active.data if me.uv_layers.active else None
        corner_normals = me.corner_normals
        for tri in me.loop_triangles:
            for li in tri.loops:
                v = me.vertices[me.loops[li].vertex_index].co
                # glTF is +y up; Blender imported it as +z up: convert back.
                p = (v.x, v.z, -v.y)
                nn = corner_normals[li].vector
                n = (nn.x, nn.z, -nn.y)
                t = uv[li].uv if uv else (0.0, 0.0)
                floats += [p[0], p[1], p[2], n[0], n[1], n[2], t[0], 1.0 - t[1]]
                for k in range(3):
                    lo[k] = min(lo[k], p[k]); hi[k] = max(hi[k], p[k])
    offset = len(data)
    data += struct.pack("<%df" % len(floats), *floats)
    manifest.append({"name": group[0].name if split else "all", "offset": offset, "corners": len(floats) // 8, "min": lo, "max": hi, "images": sorted(images)})

open(out + ".f32", "wb").write(data)
json.dump(manifest, open(out + ".json", "w"), indent=1)
print("exported", len(manifest), "groups", sum(m["corners"] for m in manifest) // 3, "triangles")
