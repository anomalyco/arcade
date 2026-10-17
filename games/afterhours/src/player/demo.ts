import * as THREE from "three/webgpu"
import type { WorldContext } from "../world/context"
import type { Player } from "../player"

// Automation only (query parameters, `?shot` captures where the Player takes no input): scripted movement to exercise
// the body, and a third-person debug camera to look at it.
//
//   bodyDemo   walk | run | back | strafe | turn | circle | stand   scripted input
//   bodyAt     x,z[,y]      start position (default: the view's), on the floor at or below y (default: the view's)
//   bodyYaw    radians      start facing (default: the view's)
//   bodyPitch  radians      view pitch (e.g. -1.2 to look at your feet)
//   bodyHold   0            arms down even with the flashlight on (light a 3p shot without the torch pose)
//   bodyReach  seconds      freeze the E door reach at that time (0.375 = full reach)
//   bodyCam    3p           third-person debug camera; bodyCamYaw (degrees around the body, 0 = in front),
//                            bodyCamDist (m), bodyCamHeight (m)

const EYE = 1.65
const STEP = 0.45

export function createDemo(ctx: WorldContext, player: Player, groundAt: (x: number, z: number, maxY: number) => number) {
  const q = ctx.params
  const mode = q.has("shot") ? q.get("bodyDemo") : null
  const thirdPerson = q.get("bodyCam") === "3p"
  const camYaw = (Number(q.get("bodyCamYaw") ?? 30) * Math.PI) / 180
  const camDist = Number(q.get("bodyCamDist") ?? 2.6)
  const camHeight = Number(q.get("bodyCamHeight") ?? 1.5)
  const camera = ctx.camera
  // Where the eye is, in third person.
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), new THREE.MeshBasicNodeMaterial({ color: 0xff2020, depthTest: false }))
  eye.renderOrder = 10
  eye.visible = false
  if (thirdPerson) ctx.scene.add(eye)
  let t = 0
  let started = false
  let yaw0 = 0

  const start = () => {
    started = true
    const at = q.get("bodyAt")?.split(",").map(Number)
    if (at && at.length >= 2) {
      player.pos.x = at[0]!
      player.pos.z = at[1]!
      player.pos.y = groundAt(at[0]!, at[1]!, (at[2] ?? player.pos.y) + STEP)
    }
    if (q.has("bodyYaw")) player.yaw = Number(q.get("bodyYaw"))
    if (q.has("bodyPitch")) player.pitch = Number(q.get("bodyPitch"))
    yaw0 = player.yaw
  }

  function update(dt: number) {
    if (!mode && !q.has("bodyPitch") && !q.has("bodyAt")) return
    if (!q.has("shot")) return
    // Wait for the whole world (floors and stairs register as modules stream in).
    const status = (globalThis as { __afterhours?: { complete: boolean } }).__afterhours
    if (status && !status.complete) return
    if (!started) start()
    t += dt
    let fwd = 0
    let side = 0
    let speed = 1.9
    switch (mode) {
      case "walk": fwd = 1; break
      case "run": fwd = 1; speed = 1.9 * 2.3; break
      case "back": fwd = -1; break
      case "strafe": side = Math.sin(t * 0.6) > 0 ? 1 : -1; break
      case "circle": fwd = 1; player.yaw = yaw0 + t * 0.6; break
      case "turn": player.yaw = yaw0 + Math.sin(t * 0.7) * 1.8; break
    }
    // Ease in like the Player does.
    const ramp = Math.min(1, t / 0.6)
    const len = Math.hypot(fwd, side) || 1
    const s = Math.sin(player.yaw)
    const c = Math.cos(player.yaw)
    const dx = ((-s * fwd + c * side) / len) * speed * ramp * dt
    const dz = ((-c * fwd - s * side) / len) * speed * ramp * dt
    player.pos.x += dx
    player.pos.z += dz
    player.pos.y = groundAt(player.pos.x, player.pos.z, player.pos.y + STEP)
    camera.position.set(player.pos.x, player.pos.y + EYE, player.pos.z)
    camera.rotation.set(player.pitch, player.yaw, 0, "YXZ")
  }

  /** Third-person camera, placed after the body has posed. */
  function after(pelvis: THREE.Vector3, facing: number) {
    if (!thirdPerson) return
    eye.visible = true
    eye.position.set(player.pos.x, player.pos.y + EYE, player.pos.z)
    const a = facing + camYaw
    camera.position.set(pelvis.x - Math.sin(a) * camDist, pelvis.y - 0.95 + camHeight, pelvis.z - Math.cos(a) * camDist)
    camera.lookAt(pelvis.x, pelvis.y - 0.15, pelvis.z)
  }

  /** `bodyHold=0`: arms at the sides even with the flashlight on (a 3p debug shot lit by the camera's torch). */
  const hold = q.get("bodyHold") !== "0"
  /** `bodyReach=<0..0.75>`: hold the E reach at that time (seconds into it), -1 when unset. */
  const reach = q.has("bodyReach") ? Number(q.get("bodyReach")) : -1
  return { update, after, thirdPerson, hold, reach }
}
