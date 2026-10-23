import { mat4 } from "wgpu-matrix"
import { isEditableEventTarget, isMetaKey, observeKeyLayout, requestCanvasPointerLock } from "./controls"
import { pushOut, type Rect } from "../sim/geom"
import { stepBody } from "../sim/move"

/** Grounded, pointer-locked camera. Y in the movement body is world Z, as in kit simulation. */
export class FirstPerson {
  readonly body = { x: 0, y: 0, vx: 0, vy: 0 }
  yaw = 0
  pitch = 0
  height = 1.7
  speed = 2.1
  sensitivity = 0.002
  fov = 68
  near = 0.08
  far = 350
  flashlight = false
  readonly eye: [number, number, number] = [0, 1.7, 0]
  readonly direction: [number, number, number] = [0, 0, -1]
  readonly viewProj = mat4.identity()
  private keys = new Set<string>()
  private abort = new AbortController()
  private projection = mat4.identity()
  private view = mat4.identity()
  onKey?: (code: string) => void
  /** Moves only the rendered view (a body-worn camera's mount and sway); aim, movement and `direction` stay the player's. */
  readonly mount = { yaw: 0, pitch: 0, roll: 0, height: 0, fov: 0 }
  /** Called at the start of each update to set `mount`. */
  rig?: (camera: FirstPerson, dt: number, aspect: number) => void
  /** Called after each collision move with where the body started it, to hold it inside a game's own bounds (a phone cord's reach). */
  constrain?: (body: { x: number; y: number }, from: readonly [number, number]) => void
  private look: [number, number, number] = [0, 0, -1]
  private up: [number, number, number] = [0, 1, 0]

  constructor(private canvas: HTMLCanvasElement, private blocked: () => boolean) {
    const options = { signal: this.abort.signal }
    canvas.addEventListener("click", () => {
      if (!blocked()) requestCanvasPointerLock(canvas)
    }, options)
    window.addEventListener("keydown", (e) => {
      if (isEditableEventTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      observeKeyLayout(e)
      if (e.code === "Backquote") { if (!e.repeat) this.onKey?.(e.code); return }
      if (blocked() || document.pointerLockElement !== canvas) return
      this.keys.add(e.code)
      if (e.code.startsWith("Arrow")) e.preventDefault()
      if (e.code === "KeyF" && !e.repeat) this.flashlight = !this.flashlight
    }, options)
    window.addEventListener("keyup", (e) => { this.keys.delete(e.code); if (isMetaKey(e.code)) this.release() }, options)
    window.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== canvas || blocked()) return
      this.yaw -= e.movementX * this.sensitivity
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - e.movementY * this.sensitivity))
    }, options)
    window.addEventListener("blur", () => this.release(), options)
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.release() }, options)
    document.addEventListener("pointerlockchange", () => this.release(), options)
  }

  release() { this.keys.clear(); this.body.vx = this.body.vy = 0 }
  dispose() { this.abort.abort(); this.release(); if (document.pointerLockElement === this.canvas) document.exitPointerLock() }

  update(dt: number, aspect: number, walls: readonly Rect[]) {
    if (this.blocked()) { this.release(); if (document.pointerLockElement === this.canvas) document.exitPointerLock() }
    const held = (a: string, b: string) => Number(this.keys.has(a) || this.keys.has(b))
    const forward = held("KeyW", "ArrowUp") - held("KeyS", "ArrowDown")
    const right = held("KeyD", "ArrowRight") - held("KeyA", "ArrowLeft")
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw)
    const from = [this.body.x, this.body.y] as const
    stepBody(this.body, right * c - forward * s, -right * s - forward * c,
      this.speed * (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? 1.8 : 1), walls, Math.min(dt, 0.05), 0.28, 18)
    // A clamp can pull the body into a wall or a rolled chair, so collisions get the last word.
    if (this.constrain) { this.constrain(this.body, from); pushOut(this.body, 0.28, walls) }
    this.rig?.(this, dt, aspect)
    const m = this.mount
    this.eye[0] = this.body.x; this.eye[1] = this.height + m.height; this.eye[2] = this.body.y
    this.direction[0] = -s * Math.cos(this.pitch)
    this.direction[1] = Math.sin(this.pitch)
    this.direction[2] = -c * Math.cos(this.pitch)
    return this.compose(aspect)
  }

  /** `viewProj` from `eye` along the aim plus `mount`, rolled about the view direction by `mount.roll + roll`. */
  protected compose(aspect: number, roll = 0) {
    const m = this.mount
    const yaw = this.yaw + m.yaw, pitch = Math.max(-1.5, Math.min(1.5, this.pitch + m.pitch)), r = roll + m.roll
    const s = Math.sin(yaw), c = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch)
    this.look[0] = this.eye[0] - s * cp; this.look[1] = this.eye[1] + sp; this.look[2] = this.eye[2] - c * cp
    // Up perpendicular to the view, turned towards the right vector by the roll.
    this.up[0] = s * sp * Math.cos(r) + c * Math.sin(r); this.up[1] = cp * Math.cos(r); this.up[2] = c * sp * Math.cos(r) - s * Math.sin(r)
    mat4.lookAt(this.eye, this.look, this.up, this.view)
    mat4.perspective((this.fov + m.fov) * Math.PI / 180, aspect, this.near, this.far, this.projection)
    mat4.multiply(this.projection, this.view, this.viewProj)
    return this.viewProj
  }
}
