import { mat4, vec3 } from "wgpu-matrix"
import { Mesh, MAT } from "../gpu/mesh"
import type { FrameParts } from "../gpu/frame-parts"
import type { ForestView } from "../forest/view"
import type { FirstPerson } from "../client/first-person"
import type { ForestLake } from "../sim/forest-world"
import { lakePoint, lakeTime } from "./lake"

/** A local authoring prop drawn by the real forest renderer, never inserted into the world simulation. */
export function createLakeEditor(canvas: HTMLCanvasElement, forest: ForestView, camera: FirstPerson, lake: ForestLake, start: { x: number; z: number }) {
  const { level } = lake
  const state = { mode: "edit", torch: false }
  const log = forest.waterProbe
  Object.assign(log, lakePoint(lake, start.x - 2, start.z + 6))
  log.active = true
  const mesh = new Mesh()
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2, b = (i + 1) / 16 * Math.PI * 2
    const y0 = Math.cos(a) * 0.19, z0 = Math.sin(a) * 0.19
    const y1 = Math.cos(b) * 0.19, z1 = Math.sin(b) * 0.19
    const n = [0, Math.cos((a + b) / 2), Math.sin((a + b) / 2)]
    const tint = 0.15 + (i % 3) * 0.025
    mesh.quad([-1.3,y0,z0], [1.3,y0,z0], [1.3,y1,z1], [-1.3,y1,z1], n, [tint, tint * 0.72, tint * 0.48], MAT.lit)
    for (const side of [-1, 1]) {
      const x = side * 1.3, normal = [side,0,0]
      const rim = side > 0 ? [[x,y1,z1],[x,y0,z0]] : [[x,y0,z0],[x,y1,z1]]
      for (const p of [[x,0,0], ...rim]) mesh.vert(p, normal, [0.28,0.20,0.12], MAT.lit)
    }
  }
  const model = forest.renderer.addModel(mesh)
  let pointer: number | null = null, now = 0
  let offset = { x: 0, z: 0 }
  const point = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    const p = vec3.transformMat4([(e.clientX - rect.left) / rect.width * 2 - 1, 1 - (e.clientY - rect.top) / rect.height * 2, 0.5], mat4.inverse(camera.viewProj))
    const dy = p[1]! - camera.eye[1]
    if (dy >= -0.0001) return null
    const k = (level - camera.eye[1]) / dy
    return { x: camera.eye[0] + (p[0]! - camera.eye[0]) * k, z: camera.eye[2] + (p[2]! - camera.eye[2]) * k }
  }
  const stop = () => {
    if (pointer !== null && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer)
    pointer = null
  }
  canvas.addEventListener("pointerdown", e => {
    if (state.mode !== "edit" || e.button !== 0) return
    const p = point(e)
    if (!p || Math.hypot(p.x - log.x, p.z - log.z) > 2) return
    offset = { x: log.x - p.x, z: log.z - p.z }
    pointer = e.pointerId
    canvas.setPointerCapture(pointer)
  })
  canvas.addEventListener("pointermove", e => {
    if (state.mode !== "edit" || pointer !== e.pointerId) return
    const p = point(e)
    if (!p) return
    Object.assign(log, lakePoint(lake, p.x + offset.x, p.z + offset.z))
    log.at = now
  })
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(event, stop)
  addEventListener("blur", stop)
  return {
    state, stop,
    draw(fp: FrameParts, time: number) {
      now = time
      camera.flashlight = state.torch
      fp.push(model, log.x, level + 0.035 + Math.sin(lakeTime(time) * 13 * Math.PI * 2 / 64) * 0.015, log.z, 0, [1,1,1], 0, 0, 0)
    },
  }
}
