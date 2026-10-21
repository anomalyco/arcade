import type { FirstPerson } from "@arcade/kit/client/first-person"
import { isEditableEventTarget } from "@arcade/kit/client/controls"

export type CameraPose = { x: number; y: number; z: number; yaw: number; pitch: number; fov: number }
export const cameraPose = (c: FirstPerson): CameraPose => ({ x: c.body.x, y: c.height, z: c.body.y, yaw: c.yaw, pitch: c.pitch, fov: c.fov })
export function parsePose(value: string | null): CameraPose | null {
  if (!value) return null
  const p = value.split(",").map(Number)
  if (p.length !== 6 || !p.every(Number.isFinite) || p[5]! < 20 || p[5]! > 120) return null
  return { x: p[0]!, y: p[1]!, z: p[2]!, yaw: p[3]!, pitch: p[4]!, fov: p[5]! }
}
export const poseQuery = (p: CameraPose) => [p.x,p.y,p.z,p.yaw,p.pitch,p.fov].join(",")

/** Preview-only comparison protocol. World-space eye position and YXZ angles match Three's camera convention. */
export function compareCamera(camera: FirstPerson, blocked: () => boolean) {
  const params = new URLSearchParams(location.search)
  const pose = parsePose(params.get("cam"))
  if (pose) { camera.body.x=pose.x; camera.body.y=pose.z; camera.height=pose.y; camera.yaw=pose.yaw; camera.pitch=pose.pitch; camera.fov=pose.fov }
  const reference = new URL(location.origin); reference.port="5253"
  const available = location.hostname.endsWith(".ts.net") || ["localhost","127.0.0.1"].includes(location.hostname)
  const parentOrigin = document.referrer ? new URL(document.referrer).origin : location.origin
  const enabled = params.has("compare") && new URL(parentOrigin).hostname === location.hostname
  let seq=0
  const referenceUrl = () => { const url=new URL(reference); url.searchParams.set("cam",poseQuery(cameraPose(camera))); url.searchParams.set("view","gate"); return url.href }
  window.addEventListener("keydown", e => {
    if (!available || e.code!=="KeyP" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || blocked() || isEditableEventTarget(e.target)) return
    e.preventDefault()
    const url=referenceUrl()
    void navigator.clipboard?.writeText(url).catch(()=>{})
    camera.release(); if(document.pointerLockElement) document.exitPointerLock()
    window.open(url,"ashwood-position")
  })
  return {
    available,
    referenceUrl,
    frame() { if(enabled && parent!==window) parent.postMessage({type:"lot-camera",seq:++seq,pose:cameraPose(camera)},parentOrigin) },
  }
}
