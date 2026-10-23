import type { LabControl } from "@arcade/kit/lab-panel"
import { leadPoint } from "../../shared/gunnery"
import { type Plane, type Vec3, bodyToWorld } from "../../shared/plane"
import { type Target, type WeaponKind, WEAPONS } from "../../shared/weapons"

/** The gun and seeker reticles' look, typed settings bound to the Lab panel (dev panel, Flight tab). Live edits. */
export type ReticleSettings = {
  /** Gun ring radius (CSS px). */
  gunRing: number
  /** Range ticks round the gun ring. */
  gunTicks: boolean
  /** The lead cue: where to put the pipper so rounds meet the nearest enemy jet in range. */
  gunLead: boolean
  /** The lead cue follows enemies up to this far off the boresight (degrees). */
  leadCone: number
  /** Show the seeker's keep cone (lock cone × keep) while it tracks. */
  seekerKeep: boolean
  /** How fast the seeker diamond slews onto its target (1/s). */
  seekerSlew: number
  /** Line width (CSS px). */
  reticleLine: number
  /** Weapon change: how long the new reticle takes to settle (ms) and how large it starts. */
  switchMs: number
  switchScale: number
}
export const RETICLE_DEFAULTS: Readonly<ReticleSettings> = {
  gunRing: 26,
  gunTicks: true,
  gunLead: true,
  leadCone: 25,
  seekerKeep: true,
  seekerSlew: 14,
  reticleLine: 1.5,
  switchMs: 120,
  switchScale: 1.5,
}
export const RETICLE: ReticleSettings = { ...RETICLE_DEFAULTS }

export const RETICLE_CONTROLS: LabControl[] = [
  { key: "gunRing", label: "Gun ring radius", group: "Reticles", min: 14, max: 48, step: 1, unit: "px" },
  { key: "gunTicks", label: "Gun range ticks", group: "Reticles", type: "toggle" },
  { key: "gunLead", label: "Gun lead cue", group: "Reticles", type: "toggle" },
  { key: "leadCone", label: "Lead cue reach", group: "Reticles", min: 5, max: 60, step: 1, unit: "°" },
  { key: "seekerKeep", label: "Seeker keep cone", group: "Reticles", type: "toggle" },
  { key: "seekerSlew", label: "Seeker slew", group: "Reticles", min: 2, max: 40, step: 1, unit: "/s" },
  { key: "reticleLine", label: "Line width", group: "Reticles", min: 0.75, max: 3, step: 0.05, unit: "px" },
  { key: "switchMs", label: "Switch time", group: "Reticles", min: 0, max: 400, step: 10, unit: "ms" },
  { key: "switchScale", label: "Switch start scale", group: "Reticles", min: 1, max: 2.5, step: 0.05, unit: "×" },
]

/** Where to aim the gun at one enemy jet (`gunLead`). */
export type GunLead = {
  /** Unit direction from the muzzle to the aim point: the boresight on it puts the rounds on the target. */
  dir: Vec3
  /** Round flight time to the target (s) and as a fraction of the round's life (the gun's range, 0..1). */
  time: number
  range: number
  /** The boresight is close enough to the aim point that the rounds pass within the hit sphere. */
  solution: boolean
}

export const makeGunLead = (): GunLead => ({ dir: [0, 0, 0], time: 0, range: 0, solution: false })

const muzzle: Vec3 = [0, 0, 0]
const aim: Vec3 = [0, 0, 0]
const fwd: Vec3 = [0, 0, 0]

/**
 * The gun's lead on the enemy jet nearest the boresight (within `leadCone`) that a round can reach within its life:
 * the round as `Bullets.fire` launches it (muzzle speed along the boresight plus the jet's velocity, gravity), aimed by
 * shared/gunnery.ts `leadPoint`. Null when no enemy is in reach.
 */
export function gunLead(p: Plane, jets: Iterable<Target>, team: number, out: GunLead): GunLead | null {
  const g = WEAPONS.gun
  bodyToWorld(p, 0, 0, 1, fwd)
  bodyToWorld(p, g.muzzleAt[0], g.muzzleAt[1], g.muzzleAt[2], muzzle)
  const mx = p.x + muzzle[0]
  const my = p.y + muzzle[1]
  const mz = p.z + muzzle[2]
  const reach = Math.cos((RETICLE.leadCone * Math.PI) / 180)
  let best = -2
  for (const t of jets) {
    if (!t.alive || t.team === team || t.surface) continue
    const dx = t.x - mx
    const dy = t.y - my
    const dz = t.z - mz
    const d = Math.hypot(dx, dy, dz)
    if (d < 1) continue
    const c = (dx * fwd[0] + dy * fwd[1] + dz * fwd[2]) / d
    if (c < reach || c <= best) continue
    const time = leadPoint(mx, my, mz, p.vx, p.vy, p.vz, g.muzzle, t.x, t.y, t.z, t.vx, t.vy, t.vz, g.gravity, aim)
    if (!(time <= g.life)) continue
    const ax = aim[0] - mx
    const ay = aim[1] - my
    const az = aim[2] - mz
    const ad = Math.hypot(ax, ay, az)
    best = c
    out.dir[0] = ax / ad
    out.dir[1] = ay / ad
    out.dir[2] = az / ad
    out.time = time
    out.range = time / g.life
    const off = Math.acos(Math.max(-1, Math.min(1, out.dir[0] * fwd[0] + out.dir[1] * fwd[1] + out.dir[2] * fwd[2])))
    out.solution = off <= Math.atan(g.hitRadius / ad) + g.spread * 0.5
  }
  return best > -2 ? out : null
}

/** What the reticle shows each frame (CSS px), from src/weapons/hud.ts. */
export type ReticleView = {
  /** The selected weapon (bombs draw no reticle: the bombsight is theirs). */
  weapon: WeaponKind
  nose: { x: number; y: number }
  /** The seeker's lock cone radius on screen, projected through the live camera. */
  cone: number
  overheated: boolean
  /** Gun: the lead cue on screen and the target's range (0..1 of the gun's reach), or null. */
  lead: { x: number; y: number; range: number; solution: boolean } | null
  missiles: number
  missileMax: number
  /** Rearm progress of the next missile, 0..1 (0 with full rails). */
  rearm: number
  /** The seeker's target on screen, lock progress and state, or null while it searches. */
  lock: { x: number; y: number; progress: number; locked: boolean } | null
}

const CSS = `
#wp .ret { --ln: 1.5px; --amber: #ffc861; --red: #ff5a3a; }
#wp .ret > div { position: absolute; left: 0; top: 0; }
#wp .ret svg { position: absolute; overflow: visible; filter: drop-shadow(0 0 1px rgba(6, 16, 30, 0.85)) drop-shadow(0 1px 5px rgba(10, 30, 60, 0.4)); }
#wp .ret .gun { color: rgba(244, 247, 251, 0.92); }
#wp .ret .gun.hot { color: #ff8a3d; }
#wp .ret .gun .arc { stroke: var(--amber); }
#wp .ret .cone { position: absolute; border: var(--ln) solid rgba(244, 247, 251, 0.85); border-radius: 50%; color: rgba(244, 247, 251, 0.85);
  box-shadow: 0 0 0 1px rgba(6, 16, 30, 0.3), inset 0 0 0 1px rgba(6, 16, 30, 0.3); }
#wp .ret .cone i { position: absolute; background: currentColor; box-shadow: 0 0 0 1px rgba(6, 16, 30, 0.3); }
#wp .ret .cone i:nth-child(1) { left: 50%; top: -7px; width: var(--ln); height: 6px; margin-left: calc(var(--ln) / -2); }
#wp .ret .cone i:nth-child(2) { left: 50%; bottom: -7px; width: var(--ln); height: 6px; margin-left: calc(var(--ln) / -2); }
#wp .ret .cone i:nth-child(3) { top: 50%; left: -7px; height: var(--ln); width: 6px; margin-top: calc(var(--ln) / -2); }
#wp .ret .cone i:nth-child(4) { top: 50%; right: -7px; height: var(--ln); width: 6px; margin-top: calc(var(--ln) / -2); }
#wp .ret .msl.track .cone { border-color: var(--amber); color: var(--amber); }
#wp .ret .msl.locked .cone { border-color: var(--red); color: var(--red); }
#wp .ret .msl.empty .cone { opacity: 0.4; }
#wp .ret .keep { position: absolute; border-radius: 50%; border: 1px dashed rgba(255, 200, 97, 0.38); }
#wp .ret .rails { position: absolute; display: flex; gap: 4px; transform: translateX(-50%); }
#wp .ret .rails b { position: relative; width: 4px; height: 10px; border: 1px solid rgba(244, 247, 251, 0.8); box-shadow: 0 0 0 1px rgba(6, 16, 30, 0.25); }
#wp .ret .rails b i { position: absolute; left: 0; right: 0; bottom: 0; background: var(--ink); }
#wp .ret .rails b.next i { opacity: 0.45; }
#wp .dia { width: 12px; height: 12px; margin: -6px 0 0 -6px; }
#wp .dia i { position: absolute; inset: 0; border: 1.5px solid rgba(244, 247, 251, 0.9); transform: rotate(45deg) scale(0.78);
  box-shadow: 0 0 0 1px rgba(6, 16, 30, 0.35); }
#wp .dia.track i { border-color: #ffc861; transform: rotate(45deg) scale(1); }
#wp .dia.locked i { border: 2px solid #ff5a3a; background: rgba(255, 90, 58, 0.55); transform: rotate(45deg) scale(1.15); box-shadow: 0 0 8px rgba(255, 70, 40, 0.7); }
#wp .lead { width: 0; height: 0; }
#wp .lead svg { position: absolute; left: -9px; top: -9px; overflow: visible; color: rgba(244, 247, 251, 0.92);
  filter: drop-shadow(0 0 1px rgba(6, 16, 30, 0.85)) drop-shadow(0 1px 5px rgba(10, 30, 60, 0.4)); }
#wp .lead.on svg { color: #ffc861; }
#wp .lead.on svg .fill { fill: #ffc861; }
#wp .lline { height: 0; border-top: 1px dashed rgba(244, 247, 251, 0.55); transform-origin: 0 0; }
`

const ease = "cubic-bezier(0.2, 0.9, 0.3, 1)"

/**
 * The aim symbol at the boresight, distinct per weapon so the selection reads at a glance: the gun's classic sight (a
 * centre pipper in a ring with range ticks, an amber range arc to the target and a lead cue joined by a dashed line,
 * amber when the rounds would hit) and the AIM-9's seeker (a circle the size of the real lock cone with a diamond that
 * slews onto the tracked jet, amber while tracking, solid red on lock; the rail pips below). Bombs draw nothing here
 * (src/weapons/bombsight.ts). A weapon change pops the new reticle in (`RETICLE.switchMs`).
 */
export class Reticle {
  private root: HTMLElement
  private gun: HTMLElement
  private gunSvg: SVGSVGElement
  private arc: SVGCircleElement | null = null
  private msl: HTMLElement
  private cone: HTMLElement
  private keep: HTMLElement
  private rails: HTMLElement
  private dia: HTMLElement
  private lead: HTMLElement
  private lline: HTMLElement
  private kind: WeaponKind | null = null
  private gunKey = ""
  private railKey = ""
  private arcFrac = -1
  /** The diamond's offset from the boresight (CSS px), slewed toward the target. */
  private dx = 0
  private dy = 0

  constructor(parent: HTMLElement) {
    if (!document.getElementById("ret-css")) {
      const style = document.createElement("style")
      style.id = "ret-css"
      style.textContent = CSS
      document.head.append(style)
    }
    const h = (cls: string, html = "") => {
      const el = document.createElement("div")
      el.className = cls
      el.innerHTML = html
      el.hidden = true
      return el
    }
    this.lline = h("mark lline")
    this.lead = h(
      "mark lead",
      `<svg width="18" height="18" viewBox="-9 -9 18 18"><circle r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle class="fill" r="1.6" fill="currentColor"/></svg>`,
    )
    this.root = h("mark ret", `<div class="gun"><svg></svg></div><div class="msl"><div class="keep"></div><div class="cone"><i></i><i></i><i></i><i></i></div><div class="rails"></div></div>`)
    this.dia = h("mark dia", "<i></i>")
    parent.append(this.lline, this.lead, this.root, this.dia)
    const q = (s: string) => this.root.querySelector<HTMLElement>(s)!
    this.gun = q(".gun")
    this.gunSvg = this.gun.querySelector("svg")!
    this.msl = q(".msl")
    this.cone = q(".cone")
    this.keep = q(".keep")
    this.rails = q(".rails")
  }

  /** Whether a reticle shows (the flight HUD's boresight cross steps aside for it). */
  get shown(): boolean {
    return !this.root.hidden
  }

  update(dt: number, v: ReticleView | null): void {
    const kind = v && v.weapon !== "bomb" ? v.weapon : null
    if (kind !== this.kind) {
      this.kind = kind
      this.gun.hidden = kind !== "gun"
      this.msl.hidden = kind !== "missile"
      this.dx = this.dy = 0
      const el = kind === "gun" ? this.gun : kind === "missile" ? this.msl : null
      if (el && RETICLE.switchMs > 0) {
        el.getAnimations().forEach((a) => a.cancel())
        el.animate([{ opacity: 0, transform: `scale(${RETICLE.switchScale})`, easing: ease }, { opacity: 1, transform: "scale(1)" }], { duration: RETICLE.switchMs })
      }
    }
    this.root.hidden = !kind
    if (!v || !kind) {
      this.dia.hidden = this.lead.hidden = this.lline.hidden = true
      return
    }
    this.root.style.setProperty("--ln", `${RETICLE.reticleLine}px`)
    this.root.style.transform = `translate(${v.nose.x.toFixed(1)}px, ${v.nose.y.toFixed(1)}px)`
    if (kind === "gun") this.drawGun(v)
    else {
      this.lead.hidden = this.lline.hidden = true
      this.drawSeeker(dt, v)
    }
  }

  private drawGun(v: ReticleView): void {
    this.dia.hidden = true
    const r = RETICLE.gunRing
    const ln = RETICLE.reticleLine
    const key = `${r}|${ln}|${RETICLE.gunTicks}`
    if (key !== this.gunKey) {
      this.gunKey = key
      const s = r + 10
      let ticks = ""
      if (RETICLE.gunTicks) {
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2
          const len = i % 3 === 0 ? 6 : 3
          const c = Math.cos(a)
          const n = Math.sin(a)
          ticks += `<line x1="${(c * r).toFixed(2)}" y1="${(n * r).toFixed(2)}" x2="${(c * (r - len)).toFixed(2)}" y2="${(n * (r - len)).toFixed(2)}"/>`
        }
      }
      const arcR = r + 4
      this.gunSvg.setAttribute("width", `${2 * s}`)
      this.gunSvg.setAttribute("height", `${2 * s}`)
      this.gunSvg.setAttribute("viewBox", `${-s} ${-s} ${2 * s} ${2 * s}`)
      this.gunSvg.style.left = this.gunSvg.style.top = `${-s}px`
      this.gunSvg.innerHTML = `<g fill="none" stroke="currentColor" stroke-width="${ln}" stroke-linecap="round"><circle r="${r}"/>${ticks}</g>
<circle r="${(ln * 1.3).toFixed(2)}" fill="currentColor"/>
<circle class="arc" r="${arcR}" fill="none" stroke-width="${(ln * 1.6).toFixed(2)}" pathLength="1" transform="rotate(-90)" stroke-dasharray="0 1"/>`
      this.arc = this.gunSvg.querySelector<SVGCircleElement>(".arc")
      this.arcFrac = -1
    }
    this.gun.classList.toggle("hot", v.overheated)
    const lead = RETICLE.gunLead ? v.lead : null
    // The range arc unwinds clockwise from 12 o'clock with the target's range (full at the gun's reach).
    const frac = v.lead ? Math.round(Math.min(1, v.lead.range) * 100) / 100 : 0
    if (frac !== this.arcFrac && this.arc) {
      this.arcFrac = frac
      this.arc.setAttribute("stroke-dasharray", `${frac} ${1 - frac + 0.001}`)
    }
    this.lead.hidden = !lead
    if (!lead) {
      this.lline.hidden = true
      return
    }
    this.lead.style.transform = `translate(${lead.x.toFixed(1)}px, ${lead.y.toFixed(1)}px)`
    this.lead.classList.toggle("on", lead.solution)
    // A dashed line from the ring to the cue while it sits outside the ring.
    const ex = lead.x - v.nose.x
    const ey = lead.y - v.nose.y
    const d = Math.hypot(ex, ey)
    const len = d - r - 10
    this.lline.hidden = len < 6
    if (len >= 6) {
      const ux = ex / d
      const uy = ey / d
      this.lline.style.width = `${len.toFixed(1)}px`
      this.lline.style.transform = `translate(${(v.nose.x + ux * (r + 3)).toFixed(1)}px, ${(v.nose.y + uy * (r + 3)).toFixed(1)}px) rotate(${Math.atan2(uy, ux).toFixed(4)}rad)`
    }
  }

  private drawSeeker(dt: number, v: ReticleView): void {
    const r = Math.max(8, v.cone)
    const c = this.cone.style
    c.width = c.height = `${(2 * r).toFixed(1)}px`
    c.left = c.top = `${(-r).toFixed(1)}px`
    const l = v.missiles > 0 ? v.lock : null
    this.msl.classList.toggle("track", !!l && !l.locked)
    this.msl.classList.toggle("locked", !!l?.locked)
    this.msl.classList.toggle("empty", v.missiles <= 0)
    const showKeep = !!l && RETICLE.seekerKeep
    this.keep.hidden = !showKeep
    if (showKeep) {
      const k = r * WEAPONS.missile.keep
      const s = this.keep.style
      s.width = s.height = `${(2 * k).toFixed(1)}px`
      s.left = s.top = `${(-k).toFixed(1)}px`
    }
    // Rail pips below the circle: full, or the next one filling as it rearms.
    this.rails.style.top = `${(r + 10).toFixed(1)}px`
    const railKey = `${v.missiles}/${v.missileMax}|${Math.round(v.rearm * 10)}`
    if (railKey !== this.railKey) {
      this.railKey = railKey
      this.rails.innerHTML = Array.from({ length: v.missileMax }, (_, i) => {
        if (i < v.missiles) return `<b><i style="height:100%"></i></b>`
        if (i === v.missiles) return `<b class="next"><i style="height:${(v.rearm * 100).toFixed(0)}%"></i></b>`
        return "<b></b>"
      }).join("")
    }
    // The seeker diamond: caged on the boresight while it searches, slewing onto the target while it tracks.
    this.dia.hidden = v.missiles <= 0
    const tx = l ? l.x - v.nose.x : 0
    const ty = l ? l.y - v.nose.y : 0
    const k = 1 - Math.exp(-RETICLE.seekerSlew * dt)
    this.dx += (tx - this.dx) * k
    this.dy += (ty - this.dy) * k
    if (l?.locked) {
      this.dx = tx
      this.dy = ty
    }
    this.dia.style.transform = `translate(${(v.nose.x + this.dx).toFixed(1)}px, ${(v.nose.y + this.dy).toFixed(1)}px)`
    this.dia.classList.toggle("track", !!l && !l.locked)
    this.dia.classList.toggle("locked", !!l?.locked)
  }
}
