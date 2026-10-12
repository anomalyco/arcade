import { MODE, type Instances, type LightIn, type RenderFrame } from "../render/renderer"
import type { Snapshot } from "../../shared/sim/view"
import type { Camera } from "./camera"
import { RIPPLE_LIFE, RIPPLE_STYLE, type GameState } from "./state"

export const TEAM_COLOR: readonly [number, number, number][] = [
  [0.92, 0.28, 0.26],
  [0.3, 0.56, 0.98],
]
const FFA_PALETTE: readonly [number, number, number][] = [
  [0.92, 0.8, 0.35],
  [0.5, 0.85, 0.7],
  [0.85, 0.5, 0.9],
  [0.95, 0.55, 0.35],
  [0.55, 0.7, 0.95],
  [0.8, 0.8, 0.8],
  [0.6, 0.9, 0.45],
  [0.9, 0.45, 0.6],
]
const WALL: [number, number, number, number] = [0.34, 0.34, 0.36, 1]
const DOOR: [number, number, number, number] = [0.42, 0.33, 0.22, 1]
const RING: [number, number, number, number] = [0.92, 0.94, 1, 1]
const BODY: [number, number, number, number] = [0.05, 0.05, 0.055, 1]

/** Colour for a player: team colour in team modes, a palette slot per player in FFA. */
export function colorOf(snap: Snapshot | null, id: string, team: number, key: string): [number, number, number] {
  if (snap?.mode === "ffa") {
    const idx = snap.roster.findIndex((r) => r.id === id)
    return FFA_PALETTE[(idx < 0 ? 0 : idx) % FFA_PALETTE.length]!
  }
  void key
  return TEAM_COLOR[team] ?? TEAM_COLOR[0]!
}

export type Actor = { id: string; x: number; y: number; aim: number; color: [number, number, number] }

export type FrameInput = {
  g: GameState
  cam: Camera
  inst: Instances
  now: number
  width: number
  height: number
  me: { x: number; y: number; aim: number; color: [number, number, number]; alive: boolean } | null
  actors: Actor[]
}

/** Fills the instance buffer and returns the render frame for one view. */
export function buildFrame(f: FrameInput): RenderFrame {
  const { g, inst, now } = f
  const snap = g.snap
  inst.reset()

  inst.begin(false)
  for (const r of g.map.walls) inst.rect(r, MODE.wall, true, WALL)
  if (snap) {
    for (const d of snap.doors) {
      const door = g.map.doors.find((x) => x.id === d.id)
      if (!door) continue
      inst.rect(door.rect, MODE.wall, true, d.open ? [DOOR[0], DOOR[1], DOOR[2], 0.22] : DOOR)
    }
    for (const l of snap.lights) {
      if (l.kind !== "lamp") continue
      const flick = l.failing ? (Math.sin(now * 53 + l.id) > 0 ? 1 : 0.25) : 1
      const on = l.power > 0.02 && !l.broken
      const b = on ? Math.min(1, 0.55 + l.power * 0.5) * flick : 0.12
      inst.quad(l.x, l.y, 0.24, 0.24, 0, MODE.dot, false, [b * l.color[0], b * l.color[1], b * l.color[2], 1])
    }
  }

  inst.begin(true)
  if (snap) {
    for (const l of snap.lights) {
      if (l.kind === "lamp" && l.power > 0.02) inst.quad(l.x, l.y, 1.6, 1.6, 0, MODE.glow, false, [l.color[0], l.color[1], l.color[2], 1], [l.power * 0.42, 0, 0, 0])
      if (l.kind === "flare" && l.power > 0.02) inst.quad(l.x, l.y, 3.2, 3.2, 0, MODE.glow, false, [1, 0.36, 0.22, 1], [l.power * 0.85, 0, 0, 0])
    }
  }
  for (const t of g.tracers) {
    const a = 1 - (now - t.t0) / t.life
    inst.line(t.x0, t.y0, t.x1, t.y1, 0.04, [1, 1, 1, 1], a)
  }
  if (g.killcam) {
    const k = g.killcam
    const a = Math.max(0, 1 - (now - k.t0) / 4) * 0.9
    inst.line(k.x0, k.y0, k.x1, k.y1, 0.05, [1, 1, 1, 1], a)
  }

  inst.begin(false)
  if (snap) {
    for (const b of snap.bolts) inst.quad(b.x, b.y, 0.1, 0.1, 0, MODE.dot, true, [0.92, 0.92, 0.96, 1])
    for (const p of snap.projectiles) if (p.kind === "decoy" && p.landed) inst.quad(p.x, p.y, 0.14, 0.14, 0, MODE.dot, true, [0.8, 0.82, 0.9, 1])
    if (snap.you) {
      for (const m of snap.you.mines) {
        const c = m.armed ? [0.95, 0.25, 0.2] : [0.35, 0.18, 0.18]
        inst.quad(m.x, m.y, 0.14, 0.14, 0, MODE.dot, false, [c[0]!, c[1]!, c[2]!, 1])
      }
    }
  }
  for (const a of f.actors) {
    inst.quad(a.x, a.y, 0.34, 0.34, 0, MODE.actor, false, BODY, [a.color[0], a.color[1], a.color[2], 0])
    inst.line(a.x, a.y, a.x + Math.cos(a.aim) * 0.6, a.y + Math.sin(a.aim) * 0.6, 0.045, [0.82, 0.84, 0.88, 1], 1)
  }
  if (f.me && f.me.alive) {
    const m = f.me
    inst.quad(m.x, m.y, 1.2, 1.2, 0, MODE.glow, false, [0.5, 0.55, 0.62, 1], [0.05, 0, 0, 0])
    inst.quad(m.x, m.y, 0.34, 0.34, 0, MODE.actor, false, BODY, [m.color[0], m.color[1], m.color[2], 0])
    inst.line(m.x, m.y, m.x + Math.cos(m.aim) * 0.62, m.y + Math.sin(m.aim) * 0.62, 0.045, [0.9, 0.92, 0.96, 1], 1)
  }

  inst.begin(true)
  for (const r of g.ripples) {
    const e = now - r.t0
    const D = RIPPLE_LIFE(r.r)
    const st = RIPPLE_STYLE[r.kind]
    for (let k = 0; k < 3; k++) {
      const ep = (e - k * 0.13) / D
      if (ep < 0 || ep > 1) continue
      const rad = r.r * (1 - (1 - ep) * (1 - ep)) * (1 - k * 0.04)
      if (rad < 0.1) continue
      const alpha = Math.pow(1 - ep, 1.6) * st.strength * (k === 0 ? 1 : 0.55) * (r.mine ? 0.7 : 1)
      inst.quad(r.x, r.y, rad + 0.5, rad + 0.5, 0, MODE.ring, false, RING, [rad, r.t0 * 3.1, alpha, st.jag * rad])
    }
  }
  if (snap) {
    for (const p of snap.projectiles) {
      if (p.landed) continue
      const rad = 0.2 + 0.7 * Math.min(1, p.left / 0.6)
      inst.quad(p.x, p.y, rad + 0.4, rad + 0.4, 0, MODE.ring, false, RING, [rad, 0, 0.5, 0])
    }
  }
  if (g.killcam) {
    const k = g.killcam
    inst.quad(k.x0, k.y0, 1.7, 1.7, 0, MODE.ring, false, RING, [1.2, 0, 0.9, 0])
  }

  const eye = f.me && f.me.alive ? { x: f.me.x, y: f.me.y } : null
  const lights: LightIn[] = (snap?.lights ?? []).map((l) => ({ x: l.x, y: l.y, r: l.r, power: l.power, color: l.color }))
  return {
    cam: { x: f.cam.x, y: f.cam.y },
    ppm: f.cam.ppm,
    time: now,
    ambient: eye ? 0.012 : 0.02,
    lights,
    walls: g.walls,
    eye,
    inst,
  }
}
