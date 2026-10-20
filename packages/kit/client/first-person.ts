import { mat4 } from "wgpu-matrix"
import { isEditableEventTarget, isMetaKey, observeKeyLayout, requestCanvasPointerLock } from "./controls"
import type { Rect } from "../sim/geom"
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
  flashlight = false
  readonly eye: [number, number, number] = [0, 1.7, 0]
  readonly direction: [number, number, number] = [0, 0, -1]
  readonly viewProj = mat4.identity()
  private keys = new Set<string>()
  private abort = new AbortController()
  private projection = mat4.identity()
  private view = mat4.identity()
  onKey?: (code: string) => void

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
    stepBody(this.body, right * c - forward * s, -right * s - forward * c,
      this.speed * (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? 1.8 : 1), walls, Math.min(dt, 0.05), 0.28, 18)
    this.eye[0] = this.body.x; this.eye[1] = this.height; this.eye[2] = this.body.y
    this.direction[0] = -s * Math.cos(this.pitch)
    this.direction[1] = Math.sin(this.pitch)
    this.direction[2] = -c * Math.cos(this.pitch)
    mat4.lookAt(this.eye, this.eye.map((v, i) => v + this.direction[i]!), [0, 1, 0], this.view)
    mat4.perspective(this.fov * Math.PI / 180, aspect, 0.08, 350, this.projection)
    mat4.multiply(this.projection, this.view, this.viewProj)
    return this.viewProj
  }
}
