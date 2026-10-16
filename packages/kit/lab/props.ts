import type { LabControl, LabSettings } from "../lab-panel"
import { MAT, Mesh } from "../gpu/mesh"
import { PROP_SPECS, propSpec } from "../props/catalogue"
import { propTriangles } from "../props/format"
import { DEFAULT_PROP_LOOK, propMesh, type PropLook } from "../props/mesh"
import { PropLibrary } from "../props/models"
import { frameShader } from "./stage-shader"
import type { LabContext, LabSection } from "./types"

/**
 * Props: every generated piece of the furniture and prop catalogue (`@arcade/kit/props`), the exact meshes and baked
 * colours a game draws, on a dark floor. A grid of all of them or one on a turntable, either LOD. The lighting is a
 * plain key and ambient so shape and albedo read; Outbreak's lighting is in the game behind Backquote › Props.
 */

const propShader = frameShader + /* wgsl */ `
struct PropStage { light: vec4f, cfg: vec4f }
@group(0) @binding(1) var<uniform> U: PropStage;
struct VIn { @location(0) pos: vec3f, @location(1) n: vec4f, @location(2) col: vec4f, @location(3) ma: vec2f, @location(4) inst: vec4f }
struct VOut { @builtin(position) pos: vec4f, @location(0) n: vec3f, @location(1) col: vec3f, @location(2) @interpolate(flat) mat: f32, @location(3) world: vec3f }
fn turn(p: vec3f, a: f32) -> vec3f { let c = cos(a); let s = sin(a); return vec3f(p.x * c - p.z * s, p.y, p.x * s + p.z * c); }
@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  let a = v.inst.z + U.cfg.y * step(0.5, v.inst.w);
  o.world = turn(v.pos * abs(v.inst.w), a) + vec3f(v.inst.x, 0.0, v.inst.y);
  o.pos = F.vp * vec4f(o.world, 1.0);
  o.n = turn(v.n.xyz, a);
  o.col = pow(v.col.rgb, vec3f(2.2));
  o.mat = v.ma.x;
  return o;
}
@fragment fn fs(o: VOut) -> @location(0) vec4f {
  let n = normalize(o.n);
  let L = normalize(U.light.xyz);
  if (U.cfg.w > 0.5) { return vec4f(o.col, 1.0); }
  var c = o.col * (U.cfg.x * (0.65 + 0.35 * n.y) + max(dot(n, L), 0.0) * U.light.w);
  if (abs(o.mat - 10.0) < 0.5) {
    let v = normalize(F.eye.xyz - o.world);
    c += vec3f(0.35) * pow(max(dot(n, normalize(L + v)), 0.0), 40.0) * U.light.w;
  }
  return vec4f(c, 1.0);
}
`

type Slot = { id: string; x: number; z: number }
type Gpu = { buf: GPUBuffer; count: number }

/** Lays props out in rows, widest first, `gap` metres apart. */
function gridSlots(ids: readonly string[], gap = 0.5, rowWidth = 9): Slot[] {
  const sorted = [...ids].sort((a, b) => propSpec(b).size[0] - propSpec(a).size[0])
  const rows: { ids: string[]; w: number; d: number }[] = []
  for (const id of sorted) {
    const [w, , d] = propSpec(id).size
    let row = rows[rows.length - 1]
    if (!row || row.w + w > rowWidth) rows.push((row = { ids: [], w: 0, d: 0 }))
    row.ids.push(id)
    row.w += w + gap
    row.d = Math.max(row.d, d)
  }
  const depth = rows.reduce((n, r) => n + r.d + gap * 1.6, 0)
  const out: Slot[] = []
  let z = -depth / 2
  for (const r of rows) {
    let x = -(r.w - gap) / 2
    for (const id of r.ids) {
      const w = propSpec(id).size[0]
      out.push({ id, x: x + w / 2, z: z + r.d / 2 })
      x += w + gap
    }
    z += r.d + gap * 1.6
  }
  return out
}

export function createPropsSection(context: LabContext): LabSection {
  const { device, stage } = context
  const ids = PROP_SPECS.map(s => s.id)
  const settings: LabSettings = {
    view: "grid",
    prop: "chesterfield-sofa",
    lod: 0,
    spin: 0.35,
    brightness: DEFAULT_PROP_LOOK.brightness,
    ao: DEFAULT_PROP_LOOK.ao,
    saturation: 1,
    shading: 0,
    lightAzimuth: 215,
    lightElevation: 40,
    lightIntensity: 2.2,
    ambient: 0.5,
  }
  const library = new PropLibrary()
  const gpu = new Map<string, Gpu[]>()
  let floor: Gpu | null = null
  let lookKey = ""
  let spinAngle = 0
  let loading = true
  void library.loadAll(ids).then(() => {
    loading = false
    context.sync()
  })

  const uniforms = new Float32Array(8)
  const uniformBuf = device.createBuffer({ size: uniforms.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const frameBuf = device.createBuffer({ size: 1024, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const instBuf = device.createBuffer({ size: 16 * 64, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ],
  })
  const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: frameBuf } }, { binding: 1, resource: { buffer: uniformBuf } }] })
  const module = device.createShaderModule({ code: propShader, label: "Lab props" })
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [
        { arrayStride: 24, attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "snorm8x4" },
          { shaderLocation: 2, offset: 16, format: "unorm8x4" },
          { shaderLocation: 3, offset: 20, format: "float16x2" },
        ] },
        { arrayStride: 16, stepMode: "instance", attributes: [{ shaderLocation: 4, offset: 0, format: "float32x4" }] },
      ],
    },
    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba16float" }] },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
    multisample: { count: 4 },
  })

  const upload = (mesh: Mesh): Gpu => {
    const data = mesh.pack()
    const buf = device.createBuffer({ size: Math.max(64, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(buf, 0, data)
    return { buf, count: data.byteLength / 24 }
  }

  const look = (): PropLook => ({ brightness: Number(settings.brightness), ao: Number(settings.ao), saturation: Number(settings.saturation) })
  const ensureMeshes = () => {
    if (!floor) {
      const m = new Mesh()
      m.quad([-14, 0, 9], [14, 0, 9], [14, 0, -9], [-14, 0, -9], [0, 1, 0], [0.16, 0.11, 0.075], MAT.lit)
      floor = upload(m)
    }
    const key = JSON.stringify(look())
    if (key !== lookKey) {
      for (const list of gpu.values()) for (const g of list) g.buf.destroy()
      gpu.clear()
      lookKey = key
    }
    for (const id of ids) {
      if (gpu.has(id)) continue
      const asset = library.get(id)
      if (asset) gpu.set(id, asset.lods.map(lod => upload(propMesh(lod, look()))))
    }
  }

  const slots = (): Slot[] => (settings.view === "grid" ? gridSlots(ids.filter(id => !library.failed.has(id))) : [{ id: String(settings.prop), x: 0, z: 0 }])

  const target = () => {
    if (settings.view === "grid") return { x: 0, y: 0.4, z: 0, dist: 15 }
    const [w, h, d] = propSpec(String(settings.prop)).size
    return { x: 0, y: h * 0.45, z: 0, dist: Math.max(2.2, Math.hypot(w, h, d) * 1.9) }
  }
  const frame = () => { const t = target(); stage.frameTarget(t.x, t.y, t.z, t.dist) }

  const viewGroup = "View & light"
  const lookGroup = "Prop look (shared with games)"
  const controls: LabControl[] = [
    { key: "view", label: "View", group: viewGroup, type: "select", options: [{ value: "grid", label: "Every prop" }, { value: "single", label: "One prop (turntable)" }], change: frame },
    { key: "prop", label: "Prop", group: viewGroup, type: "select", options: PROP_SPECS.map(s => ({ value: s.id, label: s.label })), change: frame, visible: s => s.view !== "grid" },
    { key: "lod", label: "Level of detail", group: viewGroup, type: "select", options: [{ value: 0, label: "LOD0 (close)" }, { value: 1, label: "LOD1 (far)" }] },
    { key: "spin", label: "Turntable speed", group: viewGroup, type: "range", min: 0, max: 2, step: 0.05, unit: "rad/s" },
    { key: "shading", label: "Shading", group: viewGroup, type: "select", options: [{ value: 0, label: "Lit" }, { value: 1, label: "Baked colour only" }] },
    { key: "brightness", label: "Albedo brightness", group: lookGroup, type: "range", min: 0.5, max: 2.5, step: 0.05, unit: "×" },
    { key: "ao", label: "Baked AO strength", group: lookGroup, type: "range", min: 0, max: 1, step: 0.05, unit: "" },
    { key: "saturation", label: "Saturation", group: lookGroup, type: "range", min: 0, max: 1.5, step: 0.05, unit: "×" },
    { key: "lightAzimuth", label: "Key light azimuth", group: viewGroup, type: "range", min: 0, max: 360, step: 5, unit: "°" },
    { key: "lightElevation", label: "Key light elevation", group: viewGroup, type: "range", min: 5, max: 90, step: 1, unit: "°" },
    { key: "lightIntensity", label: "Key light intensity", group: viewGroup, type: "range", min: 0, max: 5, step: 0.05, unit: "" },
    { key: "ambient", label: "Ambient", group: viewGroup, type: "range", min: 0, max: 1.5, step: 0.02, unit: "" },
  ]

  let drawList: { g: Gpu; first: number }[] = []
  return {
    id: "props",
    label: "Props",
    settings,
    controls,
    enter() {
      stage.sceneMode = 5
      frame()
    },
    update(dt) {
      spinAngle = (spinAngle + dt * Number(settings.spin)) % (Math.PI * 2)
    },
    frameTarget: target,
    prepare() {
      stage.sceneMode = 5
      ensureMeshes()
      const az = (Number(settings.lightAzimuth) * Math.PI) / 180
      const el = (Number(settings.lightElevation) * Math.PI) / 180
      uniforms.set([Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az), Number(settings.lightIntensity), Number(settings.ambient), spinAngle, 0, Number(settings.shading)])
      device.queue.writeBuffer(uniformBuf, 0, uniforms)
      // Instance 0 is the floor (a negative scale means it does not spin); then one per visible prop.
      const list = slots()
      const inst = new Float32Array(4 * (list.length + 1))
      inst.set([0, 0, 0, -1], 0)
      drawList = []
      list.forEach((s, i) => {
        const g = gpu.get(s.id)?.[Math.min(Number(settings.lod), 1)]
        inst.set([s.x, s.z, settings.view === "grid" ? 0 : -0.6, 1], (i + 1) * 4)
        if (g) drawList.push({ g, first: i + 1 })
      })
      device.queue.writeBuffer(instBuf, 0, inst)
    },
    draw(pass) {
      if (!floor) return
      const f = (stage as unknown as { frame?: Float32Array }).frame
      if (f) device.queue.writeBuffer(frameBuf, 0, f.buffer, f.byteOffset, Math.min(1024, f.byteLength))
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.setVertexBuffer(1, instBuf)
      pass.setVertexBuffer(0, floor.buf)
      pass.draw(floor.count, 1, 0, 0)
      for (const d of drawList) {
        pass.setVertexBuffer(0, d.g.buf)
        pass.draw(d.g.count, 1, 0, d.first)
      }
    },
    busy: () => loading,
    telemetry() {
      const lod = Math.min(Number(settings.lod), 1)
      const shown = slots().filter(s => library.get(s.id))
      const tris = shown.reduce((n, s) => n + propTriangles(library.get(s.id)!.lods[lod]!), 0)
      return `Props ${JSON.stringify({ loaded: ids.filter(id => library.get(id)).length, failed: [...library.failed], shown: shown.length, lod, triangles: tris })}`
    },
  }
}
