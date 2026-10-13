import { mat4d } from "wgpu-matrix"
import { FAR, FOV, NEAR } from "./camera"

/**
 * Camera-relative view for the sea, sky and clouds. The Frame's viewProj bakes the eye in, so feeding it vertices
 * kilometres away (or taking derivatives of world positions) costs millimetres of f32 precision. These matrices use a
 * rotation-only view: positions are relative to the eye, built in f64 on the CPU and stored as small f32 numbers.
 */
export class RelView {
  /** proj * view without translation. */
  readonly viewProjRel = new Float32Array(16)
  /** Inverse of viewProjRel: NDC to an eye-relative direction (sky rays). */
  readonly invViewProjRel = new Float32Array(16)
  /** Full world view-projection in f64, for frustum culling. */
  readonly viewProj = new Float64Array(16)
  /** viewProjRel in f64, for culling eye-relative boxes. */
  readonly viewProjRel64 = new Float64Array(16)
  readonly eye = new Float64Array(3)
  private view = new Float64Array(16)
  private proj = new Float64Array(16)
  private vp = new Float64Array(16)
  private inv = new Float64Array(16)
  private zero = new Float64Array(3)
  private neg = new Float64Array(3)
  private target = new Float64Array(3)
  private up = new Float64Array([0, 1, 0])

  update(eye: ArrayLike<number>, forward: ArrayLike<number>, aspect: number): void {
    this.eye[0] = eye[0]!
    this.eye[1] = eye[1]!
    this.eye[2] = eye[2]!
    this.target[0] = forward[0]!
    this.target[1] = forward[1]!
    this.target[2] = forward[2]!
    mat4d.lookAt(this.zero, this.target, this.up, this.view)
    mat4d.perspectiveReverseZ(FOV, aspect, NEAR, FAR, this.proj)
    mat4d.multiply(this.proj, this.view, this.vp)
    this.viewProjRel.set(this.vp)
    this.viewProjRel64.set(this.vp)
    mat4d.inverse(this.vp, this.inv)
    this.invViewProjRel.set(this.inv)
    // World viewProj = vp * translate(-eye).
    this.neg[0] = -this.eye[0]!
    this.neg[1] = -this.eye[1]!
    this.neg[2] = -this.eye[2]!
    mat4d.translate(this.vp, this.neg, this.viewProj)
  }
}
