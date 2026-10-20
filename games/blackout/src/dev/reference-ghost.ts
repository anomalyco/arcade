// Lab-only reference ghost for the Characters page: plays an openly licensed reference cycle (100STYLE mocap,
// CC BY 4.0, or Quaternius UAL, CC0), retargeted onto the rig by scripts/animation/reference-clips.ts --bake, beside
// the selected actor. Its phase advances with the distance the actor travels, so planted feet don't skate when the
// actor walks at the clip's speed. Presentation only; nothing here touches gameplay.
import type { LabControl } from "@arcade/kit/lab-panel"
import type { HumanBody } from "@arcade/kit/human-pose"
import { jointsToBody, POSE_JOINTS, type RigJointMap } from "@arcade/kit/pose-diff"
import type { V3 } from "@arcade/kit/rig"
import baked from "./reference-clips.json"

type BakedClip = { id: string; label: string; licence: string; source: string; speed: number; cycleSec: number; frames: number[][] }
const clips = (baked as { clips: BakedClip[] }).clips

export const REFERENCE_CLIP_IDS = ["off", ...clips.map(c => c.id)]

export const REFERENCE_CREDITS = (baked as { credits: Record<string, string> }).credits

export const referenceGhostControls: LabControl[] = [
  {
    key: "referenceClip",
    label: "Reference clip",
    group: "Reference",
    options: [{ label: "Off", value: "off" }, ...clips.map(c => ({ label: `${c.label} (${c.licence})`, value: c.id }))],
  },
  { key: "referenceOffset", label: "Ghost offset · m", group: "Reference", min: -2, max: 2, step: 0.05, unit: "m" },
  { key: "referenceRate", label: "Phase source", group: "Reference", options: [{ label: "Actor distance", value: "distance" }, { label: "Clip time", value: "time" }] },
]

export const referenceGhostDefaults = { referenceClip: "off", referenceOffset: 0.9, referenceRate: "distance" }

export class ReferenceGhost {
  settings = { ...referenceGhostDefaults }
  private phase = 0
  private heading = 0
  private last: [number, number] | null = null

  get clip(): BakedClip | undefined {
    return clips.find(c => c.id === this.settings.referenceClip)
  }

  /** Advances the cycle from the actor's root motion (or clip time when the actor stands still or the setting asks). */
  step(x: number, y: number, aim: number, dt: number): void {
    const clip = this.clip
    if (!clip) {
      this.last = null
      return
    }
    const [px, py] = this.last ?? [x, y]
    const dx = x - px, dy = y - py
    const dist = Math.hypot(dx, dy)
    this.last = [x, y]
    if (dist > 2) return
    const stride = Math.max(0.05, clip.speed * clip.cycleSec)
    const byTime = this.settings.referenceRate === "time" || clip.speed < 0.2 || dist / Math.max(dt, 1e-4) < 0.15
    this.phase = (this.phase + (byTime ? dt / clip.cycleSec : dist / stride)) % 1
    const target = dist > 1e-4 ? Math.atan2(dy, dx) : aim
    let d = target - this.heading
    d = Math.atan2(Math.sin(d), Math.cos(d))
    this.heading += d * Math.min(1, dt * 8)
  }

  /** The ghost's pose beside the actor at (x, y), or null when off. */
  body(x: number, y: number): HumanBody | null {
    const clip = this.clip
    if (!clip) return null
    const n = clip.frames.length
    const u = this.phase * n
    const i0 = Math.floor(u) % n, i1 = (i0 + 1) % n, t = u - Math.floor(u)
    const a = clip.frames[i0]!, b = clip.frames[i1]!
    const c = Math.cos(this.heading), s = Math.sin(this.heading)
    // Offset to the actor's right (game plan: +x forward, +y right at heading 0).
    const off = this.settings.referenceOffset
    const ox = x - s * off, oy = y + c * off
    const joints = {} as RigJointMap
    POSE_JOINTS.forEach((id, k) => {
      const lx = a[k * 3]! + (b[k * 3]! - a[k * 3]!) * t
      const ly = a[k * 3 + 1]! + (b[k * 3 + 1]! - a[k * 3 + 1]!) * t
      const lz = a[k * 3 + 2]! + (b[k * 3 + 2]! - a[k * 3 + 2]!) * t
      // Clip axes: +x forward, +y up, +z right. World: (x, height, y) with yaw about the vertical.
      joints[id] = [ox + lx * c - lz * s, ly, oy + lx * s + lz * c] as V3
    })
    return jointsToBody(joints)
  }
}
