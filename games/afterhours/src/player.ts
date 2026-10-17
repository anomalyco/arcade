import type * as THREE from "three/webgpu"
import type { WorldContext } from "./world/context"
import { heightAt } from "./world/height"
import { VIEWPOINTS, type ViewpointName } from "./world/layout"

const RADIUS = 0.3
const EYE = 1.65
const STEP = 0.45

/** First-person walker: pointer-lock mouse look, WASD by physical key, Shift to run, collision against the world. */
export class Player {
  readonly pos = { x: 0, y: 0, z: 0 }
  yaw = 0
  pitch = 0
  vy = 0
  flashlight = false
  fly = false
  private keys = new Set<string>()
  private bob = 0
  private speed = 0

  constructor(
    private camera: THREE.PerspectiveCamera,
    private canvas: HTMLCanvasElement,
    private ctx: WorldContext,
    enabled: boolean,
  ) {
    if (!enabled) return
    canvas.addEventListener("click", () => canvas.requestPointerLock())
    document.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== canvas) return
      const sens = Number(ctx.settings["player.sensitivity"] ?? 1) * 0.0022
      this.yaw -= e.movementX * sens
      this.pitch = Math.min(1.45, Math.max(-1.45, this.pitch - e.movementY * sens))
    })
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return
      this.keys.add(e.code)
      if (e.code === "KeyF" && !e.repeat) this.flashlight = !this.flashlight
      if (e.code === "KeyN" && !e.repeat) this.fly = !this.fly
      const views = Object.keys(VIEWPOINTS) as ViewpointName[]
      const digit = e.code.startsWith("Digit") ? Number(e.code.slice(5)) : 0
      if (digit >= 1 && digit <= views.length) this.teleport(views[digit - 1]!)
    })
    window.addEventListener("keyup", (e) => this.keys.delete(e.code))
    window.addEventListener("blur", () => this.keys.clear())
  }

  release() {
    this.keys.clear()
  }

  teleport(name: ViewpointName) {
    const v = VIEWPOINTS[name]
    this.pos.x = v.pos[0]
    this.pos.z = v.pos[2]
    this.pos.y = v.pos[1] - EYE + this.groundAt(this.pos.x, this.pos.z, 99)
    this.yaw = v.yaw
    this.pitch = v.pitch
    this.vy = 0
    this.apply()
  }

  update(dt: number) {
    const k = this.keys
    const fwd = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0)
    const side = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0)
    const run = k.has("ShiftLeft") || k.has("ShiftRight")
    const walk = Number(this.ctx.settings["player.walk"] ?? 1.9)
    const target = (fwd || side ? 1 : 0) * walk * (run ? (this.fly ? 8 : 2.3) : 1) * (this.fly ? 6 : 1)
    this.speed += (target - this.speed) * Math.min(1, dt * 8)
    const len = Math.hypot(fwd, side) || 1
    const sin = Math.sin(this.yaw)
    const cos = Math.cos(this.yaw)
    const dx = ((-sin * fwd + cos * side) / len) * this.speed * dt
    const dz = ((-cos * fwd - sin * side) / len) * this.speed * dt

    const ladder = this.fly ? undefined : this.ladderAt()
    if (ladder) {
      this.vy = 0
      this.pos.y = Math.min(Math.max(this.pos.y + fwd * 1.4 * dt, ladder.min[1] - 0.05), ladder.max[1])
      this.move(dx * 0.4, 0)
      this.move(0, dz * 0.4)
      const top = this.groundAt(this.pos.x, this.pos.z, this.pos.y + STEP)
      if (this.pos.y < top) this.pos.y = top
      this.bob += Math.abs(fwd) * dt * 2.5
    } else if (this.fly) {
      this.pos.x += dx
      this.pos.z += dz
      const up = (k.has("Space") ? 1 : 0) - (k.has("KeyC") ? 1 : 0)
      this.pos.y += up * this.speed * dt + Math.sin(this.pitch) * fwd * this.speed * dt
    } else {
      this.move(dx, 0)
      this.move(0, dz)
      const ground = this.groundAt(this.pos.x, this.pos.z, this.pos.y + STEP)
      this.vy -= 9.81 * dt
      this.pos.y += this.vy * dt
      if (this.pos.y <= ground) {
        this.pos.y = ground
        this.vy = 0
      }
      this.bob += this.speed * dt * 1.9
    }
    this.apply()
  }

  private apply() {
    const bobAmt = this.fly ? 0 : Math.min(this.speed, 4) * 0.012
    this.camera.position.set(this.pos.x, this.pos.y + EYE + Math.sin(this.bob * 2) * bobAmt, this.pos.z)
    this.camera.rotation.set(this.pitch, this.yaw, Math.sin(this.bob) * bobAmt * 0.15, "YXZ")
  }

  private ladderAt() {
    const p = this.pos
    return this.ctx.ladders.find(
      (l) => p.x >= l.min[0] && p.x <= l.max[0] && p.z >= l.min[2] && p.z <= l.max[2] && p.y + 0.3 >= l.min[1] && p.y <= l.max[1],
    )
  }

  /** Highest walkable surface at (x, z) that is no higher than `maxY`. */
  private groundAt(x: number, z: number, maxY: number) {
    let g = heightAt(x, z)
    for (const f of this.ctx.floors) {
      if (x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1] && f.y <= maxY && f.y > g) g = f.y
    }
    return g
  }

  private move(dx: number, dz: number) {
    const nx = this.pos.x + dx
    const nz = this.pos.z + dz
    const feet = this.pos.y + STEP
    const head = this.pos.y + EYE + 0.1
    for (const b of this.ctx.colliders) {
      if (b.max[1] < feet || b.min[1] > head) continue
      const cx = Math.max(b.min[0], Math.min(nx, b.max[0]))
      const cz = Math.max(b.min[2], Math.min(nz, b.max[2]))
      if ((nx - cx) ** 2 + (nz - cz) ** 2 < RADIUS * RADIUS) return
    }
    this.pos.x = nx
    this.pos.z = nz
  }
}
