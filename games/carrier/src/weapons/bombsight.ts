import type { LabControl } from "@arcade/kit/lab-panel"
import { type BombImpact, type Ground, type MissileLaunch, type MovingShip, bombImpact, bombLaunch, driftShip, makeBombImpact } from "../../shared/combat"
import { FLEET, waterlineDistance } from "../../shared/fleet"
import { type Plane, type Vec3, bodyToWorld, shipToWorld, worldToShip } from "../../shared/plane"
import { type Target, type VehicleKind, WEAPONS } from "../../shared/weapons"

/** The bombsight's look, typed settings bound to the Lab panel (debug menu, SIGHT tab). Live edits. */
export type SightStyleSettings = {
  /** Symbols: the fall line, the pipper and the readout. */
  sightInk: string
  /** The pipper over an enemy it would hit (or damage with a near miss). */
  sightCue: string
  /** Horizon and pitch bars in the bombsight view. */
  sightLadder: boolean
  /** Line width (CSS px). */
  sightLine: number
  /** Pipper radius (CSS px). */
  sightPip: number
}
export const SIGHT_STYLE_DEFAULTS: Readonly<SightStyleSettings> = { sightInk: "#f4f7fb", sightCue: "#9dffb8", sightLadder: true, sightLine: 1.4, sightPip: 9 }
export const SIGHT_STYLE: SightStyleSettings = { ...SIGHT_STYLE_DEFAULTS }

const COLORS = [
  { value: "#f4f7fb", label: "White" },
  { value: "#9dffb8", label: "Green" },
  { value: "#ffc861", label: "Amber" },
  { value: "#ff5a3a", label: "Red" },
] as const

export const SIGHT_STYLE_CONTROLS: LabControl[] = [
  { key: "sightInk", label: "Symbols", group: "Bombsight symbols", options: COLORS },
  { key: "sightCue", label: "On target", group: "Bombsight symbols", options: COLORS },
  { key: "sightLadder", label: "Horizon & pitch bars", group: "Bombsight symbols", type: "toggle" },
  { key: "sightLine", label: "Line width", group: "Bombsight symbols", min: 0.75, max: 3, step: 0.05, unit: "px" },
  { key: "sightPip", label: "Pipper radius", group: "Bombsight symbols", min: 5, max: 18, step: 0.5, unit: "px" },
]

/** A carrier the sight knows: its pose and course (to drift it through the bomb's fall) and its team. */
export type SightShip = MovingShip & { team: number }

/** What a bomb released now does (`aimBomb`). */
export type BombAim = {
  impact: BombImpact
  /**
   * Where to draw the pipper: the burst point carried back by the motion of the enemy it lands on or near over the
   * fall (a moving target's frame), so the pipper sitting on the ship as it is now means the bomb meets it.
   */
  draw: Vec3
  /** It would hit an enemy carrier, damage one with a near miss, or catch an enemy boat in the blast. */
  cue: boolean
  /** Slant range from the jet to the burst (m). */
  range: number
}

export const makeBombAim = (): BombAim => ({ impact: makeBombImpact(), draw: [0, 0, 0], cue: false, range: 0 })

/** Beyond this from a mover's predicted position (m) the pipper stops following it; within FOLLOW_IN it follows fully. */
const FOLLOW_OUT = 650
const FOLLOW_IN = 200

const launch: MissileLaunch = { owner: -1, seq: 0, t: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, target: -1 }
const ahead: MovingShip = { x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0, u: 0, v: 0, r: 0 }
const loc: Vec3 = [0, 0, 0]

/** A carrier `s` drifted along its course for `time` seconds (shared/combat.ts driftShip), into `ahead`. */
function shipAfter(s: MovingShip, time: number): MovingShip {
  ahead.x = s.x
  ahead.z = s.z
  ahead.heave = s.heave
  ahead.heading = s.heading
  ahead.pitch = s.pitch
  ahead.roll = s.roll
  ahead.u = s.u
  ahead.v = s.v
  ahead.r = s.r
  const n = Math.max(1, Math.ceil(time / 0.1))
  for (let i = 0; i < n; i++) driftShip(ahead, time / n)
  return ahead
}

/**
 * The continuously computed impact point (CCIP) of the next bomb from jet `p`: the game's own release
 * (shared/combat.ts bombLaunch) flown by the game's own bomb (bombImpact), and whether it lands on an enemy of `team`.
 */
export function aimBomb(p: Plane, vehicle: VehicleKind, bombs: number, max: number, g: Ground, ships: readonly SightShip[], boats: readonly Target[], team: number, out: BombAim): BombAim {
  bombLaunch(p, vehicle, bombs, max, launch)
  const im = bombImpact(g, ships, launch, out.impact)
  out.range = Math.hypot(im.x - p.x, im.y - p.y, im.z - p.z)
  out.draw[0] = im.x
  out.draw[1] = im.y
  out.draw[2] = im.z
  out.cue = false
  if (!im.kind) return out
  if (im.kind === "ship" && im.ship >= 0) {
    // On a deck: drawn on that deck as it is now.
    const s = ships[im.ship]!
    shipToWorld(s, im.local[0], im.local[1], im.local[2], out.draw)
    out.cue = s.team !== team
    return out
  }
  // Near a moving enemy: follow it (a sea burst beside a carrier steaming at 20 m/s lands 200 m from where it is now).
  let best = FOLLOW_OUT
  let dx = 0
  let dz = 0
  for (const s of ships) {
    if (s.team === team) continue
    const a = shipAfter(s, im.time)
    const l = worldToShip(a, im.x, im.y, im.z, loc)
    const d = waterlineDistance(l[0], l[2])
    if (im.kind === "sea" && d <= FLEET.near) out.cue = true
    if (d < best) {
      best = d
      dx = a.x - s.x
      dz = a.z - s.z
    }
  }
  for (const b of boats) {
    if (!b.alive || b.team === team) continue
    const bx = b.x + b.vx * im.time
    const bz = b.z + b.vz * im.time
    const d = Math.hypot(im.x - bx, im.z - bz)
    if (d <= WEAPONS.bomb.radius) out.cue = true
    if (d < best) {
      best = d
      dx = bx - b.x
      dz = bz - b.z
    }
  }
  const w = Math.max(0, Math.min(1, (FOLLOW_OUT - best) / (FOLLOW_OUT - FOLLOW_IN)))
  out.draw[0] -= dx * w
  out.draw[2] -= dz * w
  return out
}

type Px = { x: number; y: number } | null
type Project = (x: number, y: number, z: number) => Px

const CSS = `
#bs { position: fixed; inset: 0; pointer-events: none; filter: drop-shadow(0 1px 3px rgba(10, 30, 60, 0.55)); }
#bs[hidden], #bs [hidden] { display: none !important; }
#bs svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
#bs text { font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; font-weight: 300; font-size: calc(10.5px * var(--hud, 1));
  letter-spacing: 0.2em; font-variant-numeric: tabular-nums; }
#bs .ladder { opacity: 0.6; }
#bs .ladder text { font-size: calc(9px * var(--hud, 1)); opacity: 0.85; }
body.mn-open #bs { display: none; }
`

const BARS = [20, 10, -10, -20, -30, -45, -60]
const DEG = Math.PI / 180
const fw: Vec3 = [0, 0, 0]

/**
 * The bombsight's symbols, in the HUD's thin lines, no instruction text: the bomb fall line from the flight-path
 * marker to the pipper on the predicted impact point (solid in the cue colour on an enemy), the fall time and slant
 * range beside it, and in the bombsight view a horizon with pitch bars. Off screen, the line runs to the edge and ends
 * in a caret toward the impact point.
 */
export class BombSight {
  readonly root: HTMLElement
  private svg: SVGSVGElement
  private ladder: SVGGElement
  private horizon: SVGPathElement
  private bars: SVGPathElement
  private barText: SVGTextElement[] = []
  private fall: SVGLineElement
  private pip: SVGCircleElement
  private dot: SVGCircleElement
  private caret: SVGPathElement
  private read: SVGTextElement
  private t1: SVGTSpanElement
  private t2: SVGTSpanElement
  private lastRead = ""

  constructor(parent: HTMLElement = document.body) {
    if (!document.getElementById("bs-css")) {
      const style = document.createElement("style")
      style.id = "bs-css"
      style.textContent = CSS
      document.head.append(style)
    }
    const root = document.createElement("div")
    root.id = "bs"
    root.hidden = true
    root.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><g class="ladder"><path class="hz" fill="none"/><path class="bars" fill="none" stroke-dasharray="7 4"/>${BARS.map(() => "<text text-anchor=start dominant-baseline=middle></text>").join("")}</g>
<line class="fall" stroke-linecap="round"/><circle class="pip"/><circle class="dot"/><path class="caret" fill="none" stroke-linejoin="round"/>
<text class="read"><tspan class="t1"></tspan><tspan class="t2"></tspan></text></svg>`
    parent.append(root)
    this.root = root
    const q = <T extends Element>(s: string) => root.querySelector<T>(s)!
    this.svg = q("svg")
    this.ladder = q(".ladder")
    this.horizon = q(".hz")
    this.bars = q(".bars")
    this.barText = [...root.querySelectorAll<SVGTextElement>(".ladder text")]
    this.fall = q(".fall")
    this.pip = q(".pip")
    this.dot = q(".dot")
    this.caret = q(".caret")
    this.read = q(".read")
    this.t1 = q(".t1")
    this.t2 = q(".t2")
  }

  /**
   * Per frame while bombs are selected (null hides it). `aim` null: nothing left to drop (the line and pipper hide).
   * `view`: the bombsight camera is showing (horizon and pitch bars). `eye` the camera, `p` our jet.
   */
  update(v: { aim: BombAim | null; p: Plane; eye: ArrayLike<number>; view: boolean; project: Project } | null): void {
    this.root.hidden = !v
    if (!v) return
    const st = SIGHT_STYLE
    const ink = st.sightInk
    const w = innerWidth
    const h = innerHeight
    this.svg.setAttribute("stroke-width", String(st.sightLine))
    this.svg.style.color = ink
    this.drawLadder(v.view && st.sightLadder, v.p, v.eye, v.project, ink)

    const aim = v.aim
    const p = v.p
    const sp = Math.hypot(p.vx, p.vy, p.vz)
    const fpm = sp > 1 ? v.project(p.x + (p.vx / sp) * 1000, p.y + (p.vy / sp) * 1000, p.z + (p.vz / sp) * 1000) : null
    const at = aim && aim.impact.kind ? v.project(aim.draw[0], aim.draw[1], aim.draw[2]) : null
    const m = 28
    const inside = !!at && at.x > m && at.x < w - m && at.y > m && at.y < h - m
    const show = !!aim && !!at
    this.fall.toggleAttribute("hidden", !show || !fpm)
    this.pip.toggleAttribute("hidden", !inside)
    this.dot.toggleAttribute("hidden", !inside)
    this.caret.toggleAttribute("hidden", !show || inside || !fpm)
    this.read.toggleAttribute("hidden", !show)
    if (!aim || !at) return
    const cue = aim.cue
    const col = cue ? st.sightCue : ink
    // The fall line ends at the pipper's ring, or at the screen edge toward an impact point off it.
    let ex = at.x
    let ey = at.y
    if (!inside && fpm) {
      const k = clipToBox(fpm.x, fpm.y, at.x, at.y, m, m, w - m, h - m)
      ex = fpm.x + (at.x - fpm.x) * k
      ey = fpm.y + (at.y - fpm.y) * k
    }
    if (fpm) {
      const dx = ex - fpm.x
      const dy = ey - fpm.y
      const l = Math.hypot(dx, dy) || 1
      const r0 = 9
      const r1 = inside ? st.sightPip : 0
      this.fall.setAttribute("x1", (fpm.x + (dx / l) * r0).toFixed(1))
      this.fall.setAttribute("y1", (fpm.y + (dy / l) * r0).toFixed(1))
      this.fall.setAttribute("x2", (ex - (dx / l) * r1).toFixed(1))
      this.fall.setAttribute("y2", (ey - (dy / l) * r1).toFixed(1))
      this.fall.setAttribute("stroke", ink)
      this.fall.toggleAttribute("hidden", l < r0 + r1 + 2)
      if (!inside) {
        // A caret at the edge pointing on toward the impact point.
        const ux = dx / l
        const uy = dy / l
        const s = 7
        const bx = ex - ux * s
        const by = ey - uy * s
        this.caret.setAttribute("d", `M${(bx - uy * s).toFixed(1)} ${(by + ux * s).toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}L${(bx + uy * s).toFixed(1)} ${(by - ux * s).toFixed(1)}`)
        this.caret.setAttribute("stroke", ink)
      }
    }
    if (inside) {
      this.pip.setAttribute("cx", at.x.toFixed(1))
      this.pip.setAttribute("cy", at.y.toFixed(1))
      this.pip.setAttribute("r", String(st.sightPip))
      this.pip.setAttribute("stroke", col)
      this.pip.setAttribute("fill", cue ? col : "none")
      this.pip.setAttribute("fill-opacity", cue ? "0.45" : "0")
      this.pip.setAttribute("stroke-width", String(cue ? st.sightLine * 1.6 : st.sightLine))
      this.dot.setAttribute("cx", at.x.toFixed(1))
      this.dot.setAttribute("cy", at.y.toFixed(1))
      this.dot.setAttribute("r", String(Math.max(1.2, st.sightLine)))
      this.dot.setAttribute("fill", cue ? "#06101e" : ink)
      this.dot.setAttribute("stroke", "none")
    }
    // Fall time and slant range, beside the pipper (or the caret).
    const tx = (inside ? at.x : ex) + st.sightPip + 9
    const ty = inside ? at.y : ey
    this.read.setAttribute("x", tx.toFixed(1))
    this.read.setAttribute("y", (ty - 3).toFixed(1))
    this.read.setAttribute("fill", col)
    this.read.setAttribute("stroke", "none")
    this.t2.setAttribute("x", tx.toFixed(1))
    this.t2.setAttribute("dy", "1.3em")
    const key = `${aim.impact.time.toFixed(1)}|${(aim.range / 1000).toFixed(1)}`
    if (key !== this.lastRead) {
      this.lastRead = key
      this.t1.textContent = `${aim.impact.time.toFixed(1)} S`
      this.t2.textContent = `${(aim.range / 1000).toFixed(1)} KM`
    }
  }

  /** The horizon (gapped at the nose) and pitch bars every 10° (dashed below), drawn on the world's directions. */
  private drawLadder(on: boolean, p: Plane, eye: ArrayLike<number>, project: Project, ink: string): void {
    this.ladder.toggleAttribute("hidden", !on)
    if (!on) return
    const f = bodyToWorld(p, 0, 0, 1, fw)
    const hd = Math.atan2(f[0], -f[2])
    const sx = Math.sin(hd)
    const cz = -Math.cos(hd)
    // Right of the nose's heading, horizontally.
    const rx = Math.cos(hd)
    const rz = Math.sin(hd)
    const far = 20000
    const pt = (el: number, side: number): Px => {
      const ce = Math.cos(el)
      return project(eye[0]! + (sx * ce + rx * side) * far, eye[1]! + Math.sin(el) * far, eye[2]! + (cz * ce + rz * side) * far)
    }
    const seg = (el: number, a: number, b: number): string => {
      let d = ""
      for (const s of [-1, 1]) {
        const p0 = pt(el, s * a)
        const p1 = pt(el, s * b)
        if (p0 && p1) d += `M${p0.x.toFixed(1)} ${p0.y.toFixed(1)}L${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`
      }
      return d
    }
    this.horizon.setAttribute("stroke", ink)
    let up = ""
    let down = ""
    BARS.forEach((deg, i) => {
      const el = deg * DEG
      const d = seg(el, 0.025, 0.075)
      if (deg > 0) up += d
      else down += d
      const t = this.barText[i]!
      const end = pt(el, 0.08)
      t.toggleAttribute("hidden", !end || !d)
      if (end) {
        t.setAttribute("x", (end.x + 4).toFixed(1))
        t.setAttribute("y", end.y.toFixed(1))
        t.setAttribute("fill", ink)
        t.setAttribute("stroke", "none")
        if (t.textContent !== String(Math.abs(deg))) t.textContent = String(Math.abs(deg))
      }
    })
    this.horizon.setAttribute("d", seg(0, 0.05, 1.2) + up)
    this.bars.setAttribute("d", down)
    this.bars.setAttribute("stroke", ink)
  }
}

/** The fraction along (x0, y0) → (x1, y1) where it leaves the box (1 when it ends inside). */
function clipToBox(x0: number, y0: number, x1: number, y1: number, l: number, t: number, r: number, b: number): number {
  let k = 1
  const dx = x1 - x0
  const dy = y1 - y0
  if (dx > 0 && x1 > r) k = Math.min(k, (r - x0) / dx)
  if (dx < 0 && x1 < l) k = Math.min(k, (l - x0) / dx)
  if (dy > 0 && y1 > b) k = Math.min(k, (b - y0) / dy)
  if (dy < 0 && y1 < t) k = Math.min(k, (t - y0) / dy)
  return Math.max(0, k)
}
