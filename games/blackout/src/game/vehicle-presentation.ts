import { Chassis, wheelRotation } from "../../../../packages/kit/vehicle/chassis"
import { bodyPoint, type BodyPose } from "../../../../packages/kit/vehicle/body-pose"
import { EmissionState } from "../../../../packages/kit/vehicle/emissions"
import type { VehicleSpec, VehicleView, Controls } from "../../../../packages/kit/vehicle/types"
import { VEHICLES, forwardSpeed, lateralSpeed, type VehicleKind } from "../../shared/sim/vehicle"
import { LAMPS, WHEELS } from "../render/vehicle-mesh"
import type { VehDraw, PartFn } from "./vehicles"

/** Blackout uses kilograms and +X forward; Kit uses tonnes and +Z forward. */
export function presentationSpec(kind: VehicleKind): VehicleSpec {
  const s = VEHICLES[kind], l = LAMPS[kind]
  const wheels = WHEELS[kind].map(w => ({ x: -w.s, z: w.f }))
  return { id: kind === "scooter" ? "bike" : kind, width: s.width, length: s.length, mass: s.mass / 1000,
    accel: s.accel, grip: s.grip, boost: 0, drivetrain: kind === "jeep" ? "awd" : "rwd", popSpeed: s.maxSpeed * 0.5,
    wheels: kind === "scooter" ? [wheels[0]!, wheels[0]!, wheels[1]!, wheels[1]!] : wheels,
    lamps: { frontX: Math.abs(l.head[0]![1]), frontY: l.h, frontZ: l.head[0]![0] - 0.065,
      rearX: Math.abs(l.tail[0]![1]), rearY: kind === "scooter" ? 0.5 : l.h, rearZ: l.tail[0]![0] + 0.075 } }
}

/** Flat collision terrain: the map's visual kerbs are not driveable heightfields. */
export const groundHeight = (_x: number, _z: number) => 0

export class VehiclePresentation {
  readonly spec: VehicleSpec
  readonly view: VehicleView
  readonly input: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false }
  readonly emissions = new EmissionState()
  readonly chassis: Chassis
  readonly pose: BodyPose = { height: 0, roll: 0, pitch: 0 }
  private rotation = { yaw: 0, roll: 0, pitch: 0 }
  constructor(d: Pick<VehDraw, "id" | "kind" | "x" | "y" | "h" | "vx" | "vy">) {
    this.spec = presentationSpec(d.kind)
    this.view = { id: d.id, vehicle: d.kind, x: d.x, z: d.y, h: Math.PI / 2 - d.h,
      vx: d.vx, vz: d.vy, speed: 0, drift: 0, impact: 0, stun: 0, boost: 0 }
    this.chassis = new Chassis(this.view, WHEELS[d.kind].map(w => ({ x: -w.s, y: w.r, z: w.f })), (height, x, z) => height(x, z))
  }
  update(d: VehDraw, dt: number, suspension: boolean) {
    const v = this.view, s = d.s, forward = forwardSpeed(d)
    v.x = d.x; v.z = d.y; v.h = Math.PI / 2 - d.h; v.vx = d.vx; v.vz = d.vy
    v.speed = Math.hypot(d.vx, d.vy); v.drift = Math.abs(lateralSpeed(d)); v.engineOff = !!s.wreck || !s.seats[0]
    v.braking = !v.engineOff && (s.thr < 0 && forward > 0.5 || !!s.hb)
    this.input.throttle = v.engineOff ? 0 : s.thr < 0 && forward > 0.5 ? 0 : Math.abs(s.thr)
    this.input.brake = v.braking ? 1 : 0; this.input.steer = -s.steer; this.input.handbrake = !!s.hb
    this.chassis.update(v, this.spec, groundHeight, dt, { suspension, vehicleFeel: suspension, wheelContact: true, visibleWheels: true }, this.input)
    this.pose.height = this.chassis.lift.x
    this.pose.roll = this.chassis.roll.x; this.pose.pitch = this.chassis.pitch.x
    v.impact = 0
  }
  /** Re-express Kit's Z/X/Y rotations in Blackout's Z/X/-Y instance convention.
   * Convert the basis, not just the signs: combined pitch/roll changes the Euler yaw. */
  part(push: PartFn, model: number, pose: BodyPose, tint: [number, number, number], flash = 0) {
    const v = this.view, a = this.rotation
    instanceRotation(a, v.h, pose.roll ?? 0, pose.pitch ?? 0)
    push(model, v.x, pose.height ?? 0, v.z, a.yaw, tint, a.pitch, a.roll, flash)
  }
  wheels(push: PartFn, model: number) {
    for (let i = 0; i < this.chassis.contacts.length; i++) {
      const w = this.chassis.contacts[i]!, p = this.chassis.axles[i]!
      wheelRotation(w, this.view.h, this.spec.id === "bike" ? this.chassis.roll.x : 0, 0, p.z > 0 ? this.chassis.steer : 0, w.spin)
      instanceRotation(this.rotation, w.yaw, w.roll, w.pitch)
      push(model, w.x, w.y, w.z, this.rotation.yaw, [1, 1, 1], this.rotation.pitch, this.rotation.roll, 0)
    }
  }
}

export function instanceRotation(out: { yaw: number; roll: number; pitch: number }, yaw: number, roll: number, pitch: number) {
  const c = { x: 0, z: 0, h: yaw }, pose = { roll, pitch }
  const x = bodyPoint(c, pose, [0, 0, 1]), y = bodyPoint(c, pose, [0, 1, 0]), z = bodyPoint(c, pose, [-1, 0, 0])
  out.roll = Math.asin(Math.max(-1, Math.min(1, -z[1])))
  out.pitch = Math.atan2(x[1], y[1])
  out.yaw = Math.atan2(-z[0], z[2])
}
