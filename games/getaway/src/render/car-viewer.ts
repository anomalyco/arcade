/**
 * Dev-only turntable for the vehicle models (http://localhost:<port>/car-viewer.html). Not part of the production
 * build. Query: dist (camera distance, m), cy / cp (camera yaw / pitch), yaw (car heading), spin (rad/s),
 * only (comma list of vehicle ids, "heli"), cols (grid columns), lamps (0 to turn street lamps off), spot (1 = heli
 * spotlight on the first car), siren (phase, -1 off), yaws (comma list: one column per heading), glows=0, brake,
 * still, and sirenX / sirenY / sirenK / sirenR / glowS / glowA to try siren light and glow placements.
 */
import { mat4, vec4 } from "wgpu-matrix"
import { VEHICLES } from "../../shared/config"
import { paintAtlas } from "./atlas"
import { buildCar, buildHeli, buildRotor } from "./car-mesh"
import { MAT, Mesh } from "./mesh"
import { FRAME_FLOATS, INST_FLOATS, Renderer, SPRITE_FLOATS } from "./renderer"
import { MAX_LIGHTS } from "./shaders"

const q = new URLSearchParams(location.search)
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d)

function normalize(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!)
  return [v[0]! / l, v[1]! / l, v[2]! / l]
}

function lightMatrix(eye: number[], target: number[]) {
  const z = normalize([eye[0]! - target[0]!, eye[1]! - target[1]!, eye[2]! - target[2]!])
  const x = normalize([z[2], 0, -z[0]])
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
  const S = 40
  const near = 10
  const far = 400
  const d = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
  const view = [x[0], y[0]!, z[0], 0, x[1], y[1]!, z[1], 0, x[2], y[2]!, z[2], 0, -d(x, eye), -d(y, eye), -d(z, eye), 1]
  const proj = [1 / S, 0, 0, 0, 0, 1 / S, 0, 0, 0, 0, -1 / (far - near), 0, 0, 0, -near / (far - near), 1]
  const r = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) for (let k = 0; k < 4; k++) r[c * 4 + rr]! += proj[k * 4 + rr]! * view[c * 4 + k]!
  return r
}

function ground() {
  const m = new Mesh()
  const asphalt: [number, number, number] = [0.13, 0.135, 0.15]
  m.quad([-200, 0, -200], [-200, 0, 200], [200, 0, 200], [200, 0, -200], [0, 1, 0], asphalt, MAT.flat)
  for (let x = -60; x <= 60; x += 7) m.quad([x - 0.06, 0.01, -60], [x - 0.06, 0.01, 60], [x + 0.06, 0.01, 60], [x + 0.06, 0.01, -60], [0, 1, 0], [0.5, 0.48, 0.4], MAT.flat)
  return m
}

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  const device = await adapter!.requestDevice()
  device.addEventListener("uncapturederror", (e) => console.error("gpu: " + (e as GPUUncapturedErrorEvent).error.message))
  const context = canvas.getContext("webgpu")!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  const renderer = new Renderer(device, context, format)
  renderer.setAtlas(await paintAtlas())
  renderer.setCity(ground())

  const only = q.get("only")?.split(",")
  type Item = { id: string; model: number; length: number; width: number; heli?: boolean; swat?: boolean; cop: boolean; yaw?: number }
  let items: Item[] = []
  for (const v of VEHICLES) {
    if (only && !only.includes(v.id)) continue
    items.push({ id: v.id, model: renderer.addModel(buildCar(v)), length: v.length, width: v.width, swat: v.id === "swat", cop: v.role === "cop" })
  }
  const rotor = renderer.addModel(buildRotor())
  if (!only || only.includes("heli")) items.push({ id: "heli", model: renderer.addModel(buildHeli()), length: 9, width: 3, heli: true, cop: false })

  // yaws=a,b,c repeats every model once per heading, one heading per column.
  const yaws = q.get("yaws")?.split(",").map(Number)
  if (yaws) items = items.flatMap((it) => yaws.map((y) => ({ ...it, yaw: y })))

  const resize = () => {
    canvas.width = Math.floor(innerWidth * Math.min(devicePixelRatio, 2))
    canvas.height = Math.floor(innerHeight * Math.min(devicePixelRatio, 2))
    renderer.resize(canvas.width, canvas.height)
  }
  resize()
  addEventListener("resize", resize)

  const cols = num("cols", yaws ? yaws.length : Math.min(items.length, 4))
  const spacing = num("gap", 7.5)
  const heliSpacing = 14
  const camYaw = num("cy", Math.PI / 4 + 0.16)
  const camPitch = num("cp", 0.93)
  const dist = num("dist", 26)
  const carYaw = num("yaw", 0.9)
  const spin = num("spin", 0)
  const sirenPhase = num("siren", 0.15)
  const right: [number, number] = [-Math.cos(camYaw), Math.sin(camYaw)]
  const fwd: [number, number] = [Math.sin(camYaw), Math.cos(camYaw)]
  const rows = Math.ceil(items.length / cols)
  const slots = items.map((it, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    const gap = it.heli ? heliSpacing : spacing
    const ox = (c - (cols - 1) / 2) * gap
    const oz = ((rows - 1) / 2 - r) * spacing * 1.1
    return { x: right[0] * ox + fwd[0] * oz, z: right[1] * ox + fwd[1] * oz }
  })

  const frame = new Float32Array(FRAME_FLOATS)
  const lights = new Float32Array(MAX_LIGHTS * 12)
  const add = new Float32Array(400 * SPRITE_FLOATS)
  const alpha = new Float32Array(4 * SPRITE_FLOATS)
  const start = performance.now()
  const draw = () => {
    const t = (performance.now() - start) / 1000
    const w = canvas.width
    const h = canvas.height
    const target = [0, 0.8, 0]
    const hd = Math.cos(camPitch) * dist
    const eye = [target[0]! - Math.sin(camYaw) * hd, Math.sin(camPitch) * dist, target[2]! - Math.cos(camYaw) * hd]
    const vp = mat4.multiply(mat4.perspective(0.6, w / h, 1, 900), mat4.lookAt(eye, target, [0, 1, 0]))
    const moon = normalize([-0.55, 0.62, -0.55])
    frame.set(vp, 0)
    frame.set(lightMatrix([moon[0] * 120, moon[1] * 120, moon[2] * 120], [0, 0, 0]), 16)
    let o = 32
    const put = (a: number, b: number, c: number, d: number) => {
      frame[o++] = a
      frame[o++] = b
      frame[o++] = c
      frame[o++] = d
    }
    put(eye[0]!, eye[1]!, eye[2]!, t)
    put(0, 1, 0, 0)
    put(w, h, 0, t)
    put(moon[0], moon[1], moon[2], 0.6)
    const spot = q.get("spot") === "1" && slots[0]
    if (spot) {
      put(spot.x + 6, 30, spot.z - 10, 1)
      const dir = normalize([-6, -30, 10])
      put(dir[0], dir[1], dir[2], Math.cos(Math.atan(7.5 / 32)))
    } else {
      put(0, 0, 0, 0)
      put(0, -1, 0, 1)
    }
    put(0.035, 0.045, 0.085, 0.0035)
    const clip = vec4.transformMat4([0, 1, 0, 1], vp)
    put(clip[0]! / clip[3]!, clip[1]! / clip[3]!, clip[2]! / clip[3]!, 0)

    let n = 0
    const light = (x: number, y: number, z: number, radius: number, r: number, g: number, b: number, k: number, dx = 0, dy = 0, dz = 0, cone = -2) => {
      if (n >= MAX_LIGHTS) return
      lights.set([x, y, z, radius, r, g, b, k, dx, dy, dz, cone], n * 12)
      n++
    }
    let di = 0
    const glow = (x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number) => {
      add.set([x, y, z, size, r, g, b, a, 0, 0, 1, 0], di++ * SPRITE_FLOATS)
    }
    if (q.get("lamps") !== "0") {
      for (const [x, z] of [
        [-14, -6],
        [12, 8],
        [-4, 14],
        [6, -14],
      ] as const)
        light(x, 6, z, 22, 1, 0.58, 0.26, 4)
    }
    const batches = new Map<number, number[]>()
    const inst = (model: number, vals: number[]) => {
      let a = batches.get(model)
      if (!a) batches.set(model, (a = []))
      a.push(...vals)
    }
    items.forEach((it, i) => {
      const s = slots[i]!
      const yaw = (it.yaw ?? carYaw) + t * spin
      if (it.heli) {
        const y = num("heliY", 2.5)
        inst(it.model, [s.x, y, s.z, yaw, 0, 0, -1, 0, 1, 1, 1, 1.2])
        inst(rotor, [s.x, y + 3.1, s.z, t * 25 * (q.has("still") ? 0 : 1) + 0.4, 0, 0, -1, 0, 1, 1, 1, 1.2])
        inst(rotor, [s.x + Math.sin(yaw) * -7.9 + Math.cos(yaw) * 0.3, y + 2.3, s.z + Math.cos(yaw) * -7.9, t * 40, 0, 0, -1, 0, 1, 1, 1, 0.12])
        return
      }
      const siren = it.cop ? sirenPhase + (q.has("strobe") ? t * 1.7 : 0) : -1
      inst(it.model, [s.x, 0, s.z, yaw, 0, 0, siren, q.has("brake") ? 1 : 0, 1, 1, 1, 1])
      const fx = Math.sin(yaw)
      const fz = Math.cos(yaw)
      const rx = Math.cos(yaw)
      const rz = -Math.sin(yaw)
      const half = it.length / 2
      light(s.x + fx * (half + 0.5), 1.3, s.z + fz * (half + 0.5), 36, 1, 0.92, 0.78, 3.2, fx * 0.95, -0.3, fz * 0.95, 0.8)
      light(s.x - fx * (half + 0.6), 0.9, s.z - fz * (half + 0.6), 7, 1, 0.1, 0.06, 1.2)
      const hw = it.width / 2 - 0.25
      if (q.get("glows") !== "0") {
        for (const sd of it.id === "bike" ? [0] : [-1, 1]) {
          glow(s.x + fx * (half + 0.1) + rx * hw * sd, 0.75, s.z + fz * (half + 0.1) + rz * hw * sd, 0.55, 1, 0.95, 0.85, 1.4)
          glow(s.x - fx * (half + 0.05) + rx * hw * sd, 0.75, s.z - fz * (half + 0.05) + rz * hw * sd, 0.55, 1, 0.12, 0.08, 1.1)
        }
      }
      if (siren >= 0) {
        const tt = siren - Math.floor(siren)
        const strobe = (tt * 4) % 1 >= 0.5 ? 1 : 0
        const red = (tt <= 0.5 ? 1 : 0) * (0.5 + 0.5 * strobe)
        const blue = (tt >= 0.5 ? 1 : 0) * (0.5 + 0.5 * strobe)
        const y = it.swat ? 2.9 : 1.9
        const ly = y + num("sirenY", 0.6)
        const lx = num("sirenX", 0.7)
        const lk = num("sirenK", 1)
        const lr = num("sirenR", 20)
        light(s.x - rx * lx, ly, s.z - rz * lx, lr, 1, 0.08, 0.08, 5 * red * lk)
        light(s.x + rx * lx, ly, s.z + rz * lx, lr, 0.15, 0.3, 1, 6 * blue * lk)
        if (q.get("glows") !== "0") {
          const gs = num("glowS", 1.5)
          const ga = num("glowA", 1)
          if (red > 0) glow(s.x - rx * 0.45, y, s.z - rz * 0.45, gs, 1, 0.1, 0.1, 1.5 * red * ga)
          if (blue > 0) glow(s.x + rx * 0.45, y, s.z + rz * 0.45, gs, 0.2, 0.35, 1, 1.7 * blue * ga)
        }
      }
    })
    frame[42] = n
    renderer.setBeams(new Float32Array(0), 0)
    renderer.render({
      frame,
      lights,
      batches: [...batches].map(([model, arr]) => ({ model, data: new Float32Array(arr), count: arr.length / INST_FLOATS })),
      ghosts: [],
      sprites: { alpha, alphaCount: 0, add, addCount: di },
      bloom: 0.9,
      flash: 0,
    })
    requestAnimationFrame(draw)
  }
  requestAnimationFrame(draw)
}

void main()
