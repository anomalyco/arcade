import { mat4d, vec3d } from "wgpu-matrix"
import { LabPanel } from "@arcade/kit/lab-panel"
import { keyLabel, moveClusterLabel } from "@arcade/kit/client/controls"
import { WATER_CONTROLS } from "@arcade/kit/water/controls"
import { createWaterSettings, OCEAN_WATER } from "@arcade/kit/water/settings"
import { copyBoat } from "../../shared/boat"
import { seaHeight, type Sea } from "../../shared/sea"
import type { BoatDriver } from "./boat"
import type { Ocean } from "../render/ocean"
import type { Camera } from "../render/camera"
import type { Input } from "../input"

type Host = {
  ocean: Ocean; driver: BoatDriver; camera: Camera; input: Input; sea: Sea
  paused: boolean; autoRelaunch: boolean
  shipCam: { eye: [number, number, number]; at: [number, number, number] } | null
  place(ahead: number, side: number, knots?: number): void
}

/** Authoring uses the actual boat/wake passes; Edit owns placement, Play owns the real boat solver. */
export function createWaterEditor(canvas: HTMLCanvasElement, host: Host, params: URLSearchParams) {
  const state = { interaction: "edit", paused: false }
  host.autoRelaunch = false
  host.place(-30, -150)
  host.shipCam = { eye: [250, 170, -260], at: [75, 0, -30] }
  host.input.lockable = false
  if (params.get("waterLook") === "continuous") Object.assign(host.ocean.water, OCEAN_WATER)
  const panel = new LabPanel({}, [], new URLSearchParams(), () => host.input.release(), { open: true, capture: "focus" })
  panel.header.textContent = "Water Lab"
  panel.addControls(host.ocean.water, WATER_CONTROLS, createWaterSettings())
  panel.addControls(state, [
    { key: "interaction", label: "Boat", group: "Interaction", type: "select", options: [{ label: "Edit", value: "edit" }, { label: "Play", value: "play" }], change: () => { stop(); host.input.release() } },
    { key: "paused", label: "Pause sea", group: "Interaction", type: "toggle", change: () => { host.paused = state.paused } },
    { key: "help", label: "Controls", group: "Interaction", type: "readout", read: () => state.interaction === "edit" ? "Drag the boat" : `${moveClusterLabel()} · ${keyLabel("ShiftLeft")} boost` },
  ])
  document.body.append(panel.host)
  const inv = new Float64Array(16)
  let pointer: number | null = null
  let target: { x: number; z: number } | null = null
  let offset = { x: 0, z: 0 }
  const point = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    mat4d.inverse(host.camera.viewProj, inv)
    const p = vec3d.transformMat4([(e.clientX - r.left) / r.width * 2 - 1, 1 - (e.clientY - r.top) / r.height * 2, 0.5], inv)
    const eye = host.camera.eye, dy = p[1]! - eye[1]!
    if (dy >= -1e-6) return null
    const t = -eye[1]! / dy
    if (!(t > 0)) return null
    return { x: eye[0]! + (p[0]! - eye[0]!) * t, z: eye[2]! + (p[2]! - eye[2]!) * t }
  }
  function stop() {
    if (pointer !== null && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer)
    pointer = null; target = null
    host.driver.boat.u = 0
  }
  canvas.addEventListener("pointerdown", e => {
    if (state.interaction !== "edit" || e.button !== 0) return
    const p = point(e), b = host.driver.boat
    if (!p || Math.hypot(p.x - b.x, p.z - b.z) > 15) return
    offset = { x: b.x - p.x, z: b.z - p.z }
    pointer = e.pointerId
    target = { x: b.x, z: b.z }
    canvas.setPointerCapture(pointer)
  })
  canvas.addEventListener("pointermove", e => {
    if (pointer !== e.pointerId) return
    const p = point(e)
    if (p) target = { x: p.x + offset.x, z: p.z + offset.z }
  })
  canvas.addEventListener("pointerup", stop)
  canvas.addEventListener("lostpointercapture", stop)
  canvas.addEventListener("pointercancel", stop)
  addEventListener("blur", stop)
  return {
    panel,
    get editing() { return state.interaction === "edit" },
    update(t: number, dt: number) {
      if (state.interaction !== "edit") return
      const b = host.driver.boat
      const dx = target ? target.x - b.x : 0, dz = target ? target.z - b.z : 0
      const distance = Math.hypot(dx, dz)
      if (target) { b.x = target.x; b.z = target.z }
      if (distance > 0.01) b.heading = Math.atan2(dx, -dz)
      b.u = !state.paused && dt > 0 ? Math.min(distance / dt, 25) : 0
      b.v = 0; b.r = 0; b.t = t
      b.heave = seaHeight(host.sea, b.x, b.z, t)
      b.pitch = 0; b.roll = 0
      copyBoat(b, host.driver.prev)
    },
  }
}
