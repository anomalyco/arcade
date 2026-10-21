"""Rebuild the damaged generated hard surfaces from the approved period references.

Blender --background --factory-startup --python author-hard-surface.py -- OUTPUT_DIR
Metres, Blender Z-up / -Y-front; glTF exports Y-up / +Z-front. No source assets edited.
"""
import bpy
import hashlib
import json
import math
import sys
from pathlib import Path
from mathutils import Vector


def material(name, color, roughness=.6, metal=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    shader = m.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metal
    return m


def mesh(name, vertices, faces, mat, bevel=0, smooth=False):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    data.materials.append(mat)
    for p in data.polygons:
        p.use_smooth = smooth
    if bevel:
        mod = obj.modifiers.new("Moulded edge", "BEVEL")
        mod.width, mod.segments = bevel, 3
        mod = obj.modifiers.new("Face normals", "WEIGHTED_NORMAL")
        mod.keep_sharp = True
    return obj


def box(name, position, size, mat, bevel=.001):
    x, y, z = [s/2 for s in size]
    vertices = [(a*x, b*y, c*z) for c in [-1, 1] for b in [-1, 1] for a in [-1, 1]]
    faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    obj = mesh(name, vertices, faces, mat, bevel)
    obj.location = position
    return obj


def cylinder(name, position, radius, depth, mat, axis="Z"):
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=radius, depth=depth, location=position)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    if axis == "X": obj.rotation_euler.y = math.pi/2
    if axis == "Y": obj.rotation_euler.x = math.pi/2
    mod = obj.modifiers.new("Rounded lip", "BEVEL")
    mod.width, mod.segments = min(.0015, depth*.2), 3
    obj.modifiers.new("Face normals", "WEIGHTED_NORMAL")
    return obj


def text(name, value, position, size, mat, rotation=(0, 0, 0)):
    curve = bpy.data.curves.new(name, "FONT")
    curve.body, curve.size, curve.align_x, curve.align_y = value, size, "CENTER", "CENTER"
    curve.resolution_u = 2
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.location, obj.rotation_euler = position, rotation
    obj.data.materials.append(mat)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="MESH")
    return bpy.context.object


def rounded(w, h, radius, steps=12):
    points = []
    for cx, cy, angle in [(w/2-radius,h/2-radius,0),(-w/2+radius,h/2-radius,90),(-w/2+radius,-h/2+radius,180),(w/2-radius,-h/2+radius,270)]:
        for i in range(steps):
            a = math.radians(angle + i*90/steps)
            points.append((cx+radius*math.cos(a), cy+radius*math.sin(a)))
    return points


def crt(m):
    box("Rear shell", (0,.015,.275), (.50,.51,.43), m["case"], .022)
    box("Tilt plinth", (0,.025,.035), (.38,.34,.07), m["dark"], .016)
    # Four nested rings make a rolled bezel with an open aperture, not a flat box.
    rings = [(.52,.43,.028,-.238),(.514,.424,.032,-.286),(.412,.316,.031,-.293),(.395,.298,.035,-.271)]
    verts = [(x,y,z+.279) for w,h,r,y in rings for x,z in rounded(w,h,r)]
    n = 48
    faces = [(j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i) for j in range(3) for i in range(n)]
    mesh("Rolled bezel", verts, faces, m["case"], smooth=True)
    # Rounded, bowed glass, closed by the opaque casing behind it.
    boundary = rounded(.396,.299,.035)
    verts = [(0,-.291,.279)]
    for k in range(1,13):
        t=k/12
        verts.extend((x*t,-.271-.02*(1-t*t),z*t+.279) for x,z in boundary)
    faces = [(0,1+i,1+(i+1)%n) for i in range(n)]
    faces += [(1+(k-1)*n+i,1+k*n+i,1+k*n+(i+1)%n,1+(k-1)*n+(i+1)%n) for k in range(1,12) for i in range(n)]
    mesh("Curved phosphor glass", verts, faces, m["glass"], smooth=True)
    for i in range(20):
        box(f"Top vent {i}", (-.19+i*.02,.055,.4903), (.007,.30,.0015), m["vent"], .0005)
    for side in [-1,1]:
        for i in range(19):
            box(f"Side vent {side} {i}", (side*.2504,-.075+i*.016,.35), (.0014,.006,.19), m["vent"], .0004)
        box(f"Case seam {side}", (side*.2505,.10,.269), (.001,.0015,.35), m["seam"], .0003)
    for x in [.14,.19]:
        cylinder("Contrast knob", (x,-.298,.096), .011,.009,m["dark"],"Y")
        box("Knob index", (x,-.303,.10), (.001,.0005,.006), m["paper"], 0)
    box("Power LED", (.093,-.295,.096), (.004,.001,.003), m["green"], .0005)


def phone(m):
    # The rear is high and the front low, with one uninterrupted receiver trough.
    slope=.24
    top=lambda y:.073+slope*y
    verts=[(x,y,z) for z in [0,1] for y in [-.19,.19] for x in [-.2,.2]]
    verts=[(x,y,.012 if z==0 else top(y)) for x,y,z in verts]
    faces=[(0,2,3,1),(4,5,7,6),(0,1,5,4),(2,6,7,3),(0,4,6,2),(1,3,7,5)]
    mesh("Sloped moulded housing",verts,faces,m["case"],.009)
    box("Underside seam",(0,0,.014),(.396,.374,.016),m["dark"],.008)
    angle=math.atan(slope)
    def panel(name,x,y,w,d,mat,thickness=.002,offset=.002):
        obj=box(name,(x,y,top(y)+offset),(w,d,thickness),mat,min(.002,thickness*.3))
        obj.rotation_euler.x=angle
        return obj
    panel("Receiver trough",-.132,-.04,.091,.295,m["trough"],.003,.001)
    # The scene's receiver rests 6 cm forward of the base centre. Both supports
    # follow its rotated pad locations, rather than centring an empty cradle.
    for y in [-.151,.043]:
        panel("Receiver support",-.132,y,.086,.031,m["case"],.009,.007)
        for x in [-.18,-.084]:panel("Cradle lip",x,y,.009,.039,m["case"],.015,.010)
    panel("Directory frame",.029,.088,.17,.13,m["seam"],.003,.003)
    panel("Paper directory",.029,.088,.16,.12,m["paper"],.001,.005)
    for i in range(5):panel("Directory rule",.029,.045+i*.020,.14,.0008,m["ink"],.0003,.006)
    panel("Keypad recess",.025,-.079,.155,.159,m["trough"],.002,.003)
    for row in range(4):
        for col in range(3):
            x=-.023+col*.047;y=-.025-row*.036
            panel(f"Number key {row*3+col}",x,y,.038,.028,m["key"],.009,.009)
            label="123456789*0#"[row*3+col]
            text(f"Legend {label}",label,(x,y,top(y)+.014),.012,m["legend"],(angle,0,0))
    for i in range(16):
        y=-.15+i*.020
        panel(f"Line key {i}",.142,y,.019,.014,m["key"],.007,.007)
        panel(f"Line label {i}",.172,y,.025,.014,m["paper"],.001,.004)
    for x in [-.15,.15]:
        for y in [-.13,.13]:box("Rubber foot",(x,y,.005),(.03,.03,.01),m["dark"],.004)


def rolodex(m):
    box("Weighted base",(0,0,.012),(.21,.15,.024),m["dark"],.009)
    for x in [-.094,.094]:
        support=box("Axle upright",(x,.009,.059),(.012,.028,.10),m["dark"],.005)
        support.rotation_euler.x=-.15
        cylinder("Turn wheel",(x*1.12,0,.109),.028,.013,m["dark"],"X")
        cylinder("Wheel cap",(x*1.20,0,.109),.012,.004,m["seam"],"X")
    cylinder("Card axle",(0,0,.109),.014,.207,m["dark"],"X")
    # Radial cards retain distinct clean edges; a broad front card stays readable.
    for i in range(48):
        angle=math.radians(-65+i*4.5)
        obj=box(f"Card {i}",(0,0,.109),(.168,.00045,.068),m["paper"],0)
        for vertex in obj.data.vertices:vertex.co.z+=.04
        obj.rotation_euler.x=angle
    # Front index card with printed rules and a stepped alphabet tab.
    obj=box("Front index card",(0,-.069,.137),(.169,.001,.075),m["paper"],.001)
    obj.rotation_euler.x=math.radians(9)
    for i in range(6):
        z=.112+i*.008
        box("Index rule",(0,-.070-(z-.137)*math.sin(math.radians(9)),z),(.146,.0003,.0005),m["ink"],0)
    box("Index tab",(-.052,-.063,.180),(.036,.001,.014),m["paper"],.001)
    text("Index letter","A",(-.052,-.064,.180),.008,m["ink"],(math.pi/2,0,0))


def main():
    output=Path(sys.argv[sys.argv.index("--")+1]).resolve()
    output.mkdir(parents=True,exist_ok=True)
    report={"blender":bpy.app.version_string,"source":"Original authored hard-surface rebuild against approved Night Shift concepts; replaces torn TRELLIS candidates","assets":[]}
    for name,build in [("crt",crt),("phone-base",phone),("rolodex",rolodex)]:
        for obj in list(bpy.data.objects):bpy.data.objects.remove(obj,do_unlink=True)
        m={key:material(key,color,rough) for key,color,rough in [
            ("case",(.46,.43,.34),.54),("dark",(.034,.040,.033),.6),
            ("vent",(.018,.023,.018),.85),("seam",(.15,.16,.12),.7),
            ("trough",(.22,.23,.18),.65),("key",(.065,.074,.062),.48),
            ("legend",(.69,.70,.58),.65),("paper",(.63,.61,.47),.92),
            ("ink",(.19,.22,.18),.95),("green",(.03,.5,.1),.3),
            ("glass",(.03,.6,.8),.17)]}
        build(m)
        bpy.context.view_layer.update()
        # Apply modifiers once and merge by material at export, keeping named objects
        # in the editable blend for subsequent repair.
        bpy.ops.wm.save_as_mainfile(filepath=str(output/f"{name}.blend"))
        objects=list(bpy.context.scene.objects)
        bpy.ops.object.select_all(action="SELECT")
        bpy.context.view_layer.objects.active=objects[0]
        bpy.ops.object.convert(target="MESH")
        bpy.ops.object.join()
        path=output/f"{name}.glb"
        bpy.ops.export_scene.gltf(filepath=str(path),export_format="GLB",export_apply=True,export_cameras=False,export_lights=False)
        report["assets"].append({"file":path.name,"bytes":path.stat().st_size,"sha256":hashlib.sha256(path.read_bytes()).hexdigest(),"authoredObjects":len(objects),"exportObjects":len(bpy.context.scene.objects)})
        print(f"Completed {name}",flush=True)
    (output/"authored.json").write_text(json.dumps(report,indent=2))


if __name__=="__main__":main()
