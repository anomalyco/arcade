import type { MountKind } from "../../shared/gunnery"

type Pt = { x: number; y: number }

/** What the turret HUD shows each frame (CSS px for screen points). */
export type TurretHudView = {
  kind: MountKind
  /** "CIWS", "SAM", "5-IN". */
  label: string
  /** CIWS heat 0..1, locked out. */
  heat: number
  overheated: boolean
  /** SAM cells loaded and the next cell's reload 0..1 (1: none reloading). */
  cells: number
  cellsMax: number
  reload: number
  /** The gun's breech 0..1 (1: ready). */
  ready: number
  /** Where the barrel points (it trails the aim while the turret slews). */
  bore: Pt | null
  /** The turret's place in its arcs (0..1 left to right on screen, 0..1 up) and how hard the aim presses on a limit
   *  (−1..1: + toward port/left and up). */
  arcYaw: number
  arcPitch: number
  limitYaw: number
  limitPitch: number
  /** SAM seeker box. */
  lock: (Pt & { progress: number; locked: boolean }) | null
  /** Lead pip on the target nearest the aim, and its range (m). */
  lead: (Pt & { range: number }) | null
  /** The gun's predicted impact on the water and its range (m) and time of flight (s). */
  impact: (Pt & { range: number; time: number }) | null
  /** Range readout without a marker (impact behind the camera or in the air). */
  range: number
}

const CSS = `
#tg { position: fixed; inset: 0; pointer-events: none; color: var(--ink, #f4f7fb); font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace;
  font-weight: 300; text-transform: uppercase; text-shadow: 0 1px 8px rgba(10, 30, 60, 0.45); }
#tg[hidden], #tg [hidden] { display: none !important; }
#tg .mark { position: absolute; left: 0; top: 0; will-change: transform; }
#tg .aim { left: 50%; top: 50%; width: 0; height: 0; }
#tg .aim i { position: absolute; background: rgba(244, 247, 251, 0.92); box-shadow: 0 0 4px rgba(10, 30, 60, 0.6); }
#tg .aim i:nth-child(1) { left: -22px; top: -0.5px; width: 13px; height: 1px; }
#tg .aim i:nth-child(2) { left: 9px; top: -0.5px; width: 13px; height: 1px; }
#tg .aim i:nth-child(3) { left: -0.5px; top: 9px; width: 1px; height: 11px; }
#tg .aim i:nth-child(4) { left: -1px; top: -1px; width: 2px; height: 2px; border-radius: 1px; }
#tg.sam .aim i:nth-child(1), #tg.sam .aim i:nth-child(2) { width: 8px; }
#tg.sam .aim::before, #tg.sam .aim::after { content: ""; position: absolute; top: -26px; width: 10px; height: 52px; border: 1px solid rgba(244, 247, 251, 0.6); }
#tg.sam .aim::before { left: -54px; border-right: 0; }
#tg.sam .aim::after { right: -54px; border-left: 0; }
#tg.gun .aim i:nth-child(3) { height: 34px; background: linear-gradient(rgba(244,247,251,0.9) 1px, transparent 1px) 0 0 / 1px 8px; width: 7px; left: -3.5px;
  background: repeating-linear-gradient(to bottom, rgba(244,247,251,0.9) 0 1px, transparent 1px 8px); }
#tg .bore { width: 22px; height: 22px; margin: -11px 0 0 -11px; border: 1px solid rgba(255, 200, 97, 0.85); border-radius: 50%; transition: opacity 0.2s; }
#tg .bore.on { opacity: 0.35; }
#tg .lock { width: 64px; height: 64px; margin: -32px 0 0 -32px; border: 1.5px dashed rgba(255, 200, 97, 0.9); }
#tg .lock.locked { border: 2px solid #ff5a3a; box-shadow: 0 0 10px rgba(255, 70, 40, 0.6); }
#tg .lead { width: 12px; height: 12px; margin: -6px 0 0 -6px; border: 1px solid rgba(255, 200, 97, 0.95); transform-origin: 6px 6px; }
#tg .lead b, #tg .imp b { position: absolute; left: 18px; top: -3px; font-weight: 300; font-size: 10px; letter-spacing: 0.2em; white-space: nowrap; color: rgba(255, 220, 160, 0.95); }
#tg .imp { width: 26px; height: 10px; margin: -5px 0 0 -13px; border: 1px solid rgba(255, 200, 97, 0.95); border-radius: 50%; }
#tg .imp b { left: 32px; top: -2px; }
#tg .arc { position: absolute; left: 50%; bottom: 46px; width: 240px; margin-left: -120px; height: 1px; background: rgba(244, 247, 251, 0.28); zoom: var(--hud, 1); }
#tg .arc::before, #tg .arc::after { content: ""; position: absolute; top: -4px; width: 1px; height: 9px; background: rgba(244, 247, 251, 0.55); }
#tg .arc::before { left: 0; }
#tg .arc::after { right: 0; }
#tg .arc i { position: absolute; top: -3px; width: 2px; height: 7px; margin-left: -1px; background: var(--ink, #f4f7fb); }
#tg .arc.lo::before, #tg .arc.hi::after, #tg .el.lo::after, #tg .el.hi::before { background: #ffc861; box-shadow: 0 0 6px #ff9a2e; }
#tg .el { position: absolute; right: 38%; top: 50%; height: 140px; margin-top: -70px; width: 1px; background: rgba(244, 247, 251, 0.22); zoom: var(--hud, 1); }
#tg .el::before, #tg .el::after { content: ""; position: absolute; left: -4px; width: 9px; height: 1px; background: rgba(244, 247, 251, 0.5); }
#tg .el::before { top: 0; }
#tg .el::after { bottom: 0; }
#tg .el i { position: absolute; left: -3px; width: 7px; height: 2px; margin-top: -1px; background: var(--ink, #f4f7fb); }
#tg .edge { position: absolute; top: 30%; bottom: 30%; width: 3px; opacity: 0; transition: opacity 0.15s; background: linear-gradient(transparent, rgba(255, 200, 97, 0.7), transparent); }
#tg .edge.l { left: 18px; }
#tg .edge.r { right: 18px; }
#tg .edge.u, #tg .edge.d { top: auto; bottom: auto; left: 30%; right: 30%; width: auto; height: 3px; background: linear-gradient(90deg, transparent, rgba(255, 200, 97, 0.7), transparent); }
#tg .edge.u { top: 18px; }
#tg .edge.d { bottom: 18px; }
#tg .arm { position: absolute; right: 28px; bottom: 112px; display: flex; gap: 14px; align-items: center; font-size: 11px; letter-spacing: 0.28em; margin-right: -0.28em; zoom: var(--hud, 1); }
#tg .heat, #tg .bar { position: relative; width: 64px; height: 4px; border: 1px solid rgba(244, 247, 251, 0.75); }
#tg .heat i, #tg .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ink, #f4f7fb); }
#tg .heat.hot i { background: #ff8a3d; box-shadow: 0 0 8px #ff6a1a; }
#tg .bar.wait i { background: rgba(244, 247, 251, 0.5); }
#tg .pips { display: flex; gap: 3px; }
#tg .pips b { width: 4px; height: 11px; border: 1px solid rgba(244, 247, 251, 0.75); }
#tg .pips b.full { background: var(--ink, #f4f7fb); }
#tg .rng { min-width: 5.5em; text-align: right; opacity: 0.85; }
#tg .hitm { left: 50%; top: 50%; width: 30px; height: 30px; margin: -15px 0 0 -15px; opacity: 0; }
#tg .hitm i { position: absolute; width: 9px; height: 2px; background: #fff; box-shadow: 0 0 5px rgba(255, 255, 255, 0.6); }
#tg .hitm i:nth-child(1) { left: -2px; top: 4px; transform: rotate(45deg); }
#tg .hitm i:nth-child(2) { right: -2px; top: 4px; transform: rotate(-45deg); }
#tg .hitm i:nth-child(3) { left: -2px; bottom: 4px; transform: rotate(-45deg); }
#tg .hitm i:nth-child(4) { right: -2px; bottom: 4px; transform: rotate(45deg); }
#tg .hitm.kill i { background: #ff5a3a; box-shadow: 0 0 6px rgba(255, 70, 40, 0.8); }
body.mn-open #tg { display: none; }
`

const HIT_TIME = 0.16

/**
 * The gunner's HUD, Blackout/Carrier typography and no instruction text: a crosshair on the aim (per weapon: a cross,
 * SAM brackets, a ranging ladder for the gun), an amber ring where the barrel points while it slews onto the aim, the
 * turret's place in its training and elevation arcs (the end the aim presses on lights up, with a soft edge glow on that
 * side), the weapon's state bottom right (CIWS heat, SAM cells and reload, the gun's breech and range), the SAM's seeker
 * box, a lead pip on the target nearest the aim, the gun's predicted splash on the water, and a brief hit marker.
 */
export class TurretHud {
  readonly root: HTMLElement
  private q: (s: string) => HTMLElement
  private lastArm = ""
  private lastKind = ""
  private hitLeft = 0

  constructor(parent: HTMLElement = document.body) {
    if (!document.getElementById("tg-css")) {
      const style = document.createElement("style")
      style.id = "tg-css"
      style.textContent = CSS
      document.head.append(style)
    }
    const root = document.createElement("div")
    root.id = "tg"
    root.hidden = true
    root.innerHTML = `<div class="mark aim"><i></i><i></i><i></i><i></i></div><div class="mark bore"></div><div class="mark lock" hidden></div>
<div class="mark lead" hidden><b></b></div><div class="mark imp" hidden><b></b></div><div class="arc"><i></i></div><div class="el"><i></i></div>
<div class="edge l"></div><div class="edge r"></div><div class="edge u"></div><div class="edge d"></div><div class="arm"></div>
<div class="mark hitm"><i></i><i></i><i></i><i></i></div>`
    parent.append(root)
    this.root = root
    this.q = (s: string) => root.querySelector<HTMLElement>(s)!
  }

  /** Per frame: the view, or null to hide (not manning a turret, or a menu is open). */
  update(dt: number, v: TurretHudView | null): void {
    this.hitLeft = Math.max(0, this.hitLeft - dt)
    this.root.hidden = !v
    if (!v) return
    const q = this.q
    if (v.kind !== this.lastKind) {
      this.lastKind = v.kind
      this.root.className = v.kind
    }
    q(".hitm").style.opacity = this.hitLeft > 0 ? String(Math.min(1, this.hitLeft / 0.06)) : "0"
    const place = (el: HTMLElement, p: Pt | null, extra = "") => {
      el.hidden = !p
      if (p) el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)${extra}`
    }
    const bore = q(".bore")
    place(bore, v.bore)
    if (v.bore) bore.classList.toggle("on", Math.hypot(v.bore.x - innerWidth / 2, v.bore.y - innerHeight / 2) < 4)
    const lock = q(".lock")
    if (v.lock) {
      const s = v.lock.locked ? 0.62 : 0.62 + (1 - v.lock.progress) * 0.8
      place(lock, v.lock, ` scale(${s.toFixed(3)})`)
      lock.classList.toggle("locked", v.lock.locked)
    } else lock.hidden = true
    const lead = q(".lead")
    place(lead, v.lead, " rotate(45deg)")
    if (v.lead) lead.querySelector("b")!.textContent = ""
    const imp = q(".imp")
    place(imp, v.impact)
    if (v.impact) imp.querySelector("b")!.textContent = `${(v.impact.range / 1000).toFixed(1)} KM`
    const arc = q(".arc")
    arc.querySelector("i")!.style.left = `${(v.arcYaw * 100).toFixed(1)}%`
    // Yaw grows to port, which is on the left facing the bore: the left end is the arc's maximum.
    arc.classList.toggle("lo", v.limitYaw > 0.01)
    arc.classList.toggle("hi", v.limitYaw < -0.01)
    const el = q(".el")
    el.querySelector("i")!.style.top = `${((1 - v.arcPitch) * 100).toFixed(1)}%`
    el.classList.toggle("lo", v.limitPitch < -0.01)
    el.classList.toggle("hi", v.limitPitch > 0.01)
    const glow = (s: string, x: number) => (q(s).style.opacity = x > 0.01 ? String(Math.min(1, 0.35 + x * 3)) : "0")
    // Turret yaw grows to port (left on screen when facing the bore).
    glow(".edge.l", v.limitYaw)
    glow(".edge.r", -v.limitYaw)
    glow(".edge.u", v.limitPitch)
    glow(".edge.d", -v.limitPitch)

    const rng = v.impact ? v.impact.range : v.range
    const key = `${v.kind}|${Math.round(v.heat * 64)}|${v.overheated}|${v.cells}|${Math.round(v.reload * 64)}|${Math.round(v.ready * 64)}|${Math.round(rng / 100)}|${v.lead ? Math.round(v.lead.range / 50) : -1}`
    if (key !== this.lastArm) {
      this.lastArm = key
      const pips = (n: number, max: number) => `<span class="pips">${Array.from({ length: max }, (_, i) => `<b class="${i < n ? "full" : ""}"></b>`).join("")}</span>`
      const bar = (k: number, wait: boolean) => `<span class="bar${wait ? " wait" : ""}"><i style="width:${(k * 100).toFixed(1)}%"></i></span>`
      const lr = v.lead ? `<span class="rng">${(v.lead.range / 1000).toFixed(2)} KM</span>` : ""
      if (v.kind === "ciws") q(".arm").innerHTML = `${lr}<span>${v.label}</span><span class="heat${v.overheated ? " hot" : ""}"><i style="width:${(v.heat * 100).toFixed(1)}%"></i></span>`
      else if (v.kind === "sam") q(".arm").innerHTML = `${lr}<span>${v.label}</span>${pips(v.cells, v.cellsMax)}${v.cells < v.cellsMax ? bar(v.reload, true) : ""}`
      else q(".arm").innerHTML = `<span class="rng">${rng > 0 ? `${(rng / 1000).toFixed(1)} KM` : ""}</span><span>${v.label}</span>${bar(v.ready, v.ready < 1)}`
    }
  }

  /** Our rounds or a burst hit (a kill or an intercept shows red). */
  hit(kill = false): void {
    this.hitLeft = HIT_TIME * (kill ? 2.5 : 1)
    this.q(".hitm").classList.toggle("kill", kill)
  }
}
