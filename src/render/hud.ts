// DOM HUD. Positions are written with compositor-only transforms every frame; text is throttled
// and only written when it changes, so the HUD never forces layout.
import { Vector3, type PerspectiveCamera } from "three"
import type { PlayerInfo, TeamId, Vec3, VehicleEntity, WeaponId } from "../sim/types"
import { VEHICLES, WEAPONS } from "../sim/vehicles"
import { AIRBASES, WORLD_HALF, groundHeight, segmentHitsGround, terrainHeight } from "../sim/geography"

export const TEAM_COLORS = ["#2f6fd1", "#e0902a", "#2fae5a", "#d13f3f"]
export const TEAM_NAMES = ["Cobalt", "Amber", "Emerald", "Crimson"]

export interface HudWeapon {
  id: WeaponId
  ammo: number
  /** Magazine size (-1 = unlimited). */
  cap: number
  /** 0..1 cooldown until the next shot can fire. */
  ready: number
  /** Magazine is regenerating right now. */
  regen: boolean
  lock: number
  locked: boolean
  keys?: string
}

/** Per-frame HUD input. The game reuses one object and mutates it. */
export interface HudFrame {
  camera: PerspectiveCamera
  time: number
  myId: string
  me: PlayerInfo | null
  vehicle: VehicleEntity | null
  seat: 0 | 1 | null
  /** World point the mouse-aim reticle sits on. */
  aimPoint: Vec3 | null
  /** World point the weapons actually point at (nose / turret). */
  borePoint: Vec3 | null
  vehicles: VehicleEntity[]
  players: Map<string, PlayerInfo>
  speed: number
  altitude: number
  heading: number
  throttle: number
  boost: boolean
  protected: boolean
  missileWarning: boolean
  lockTarget: Vec3 | null
  lockProgress: number
  lead: Vec3 | null
  weapons: HudWeapon[]
  scores: number[]
  teams: number
  remaining: number | null
  /** Between matches: the timer counts down to the next one. */
  intermission: boolean
  freeLook: boolean
  ping: number
  /** Direct steering: no mouse-aim circle; the boresight becomes the gun pipper. */
  direct: boolean
  /** Lock-on missile seeker cone half-angle (rad), drawn around `seekerCenter`. 0 = hidden. */
  seekerCone: number
  seekerCenter: Vec3 | null
  /** Radar officer scanner reticle (drawn at aimPoint). */
  scanner: boolean
  scannerCone: number
  /** Distance to the enemy under the scanner, meters. */
  scannerRange: number | null
  /** Scanner-guided missile in flight. */
  guide: { missile: Vec3; tti: number | null; lost: boolean } | null
  /** Seat hint (e.g. Blackbird pilot has no weapons). */
  hint: string | null
  /** Pilot is in cockpit view: draw the canopy frame. */
  cockpit?: boolean
}

export interface Hud {
  root: HTMLElement
  update(f: HudFrame): void
  killfeed(killer: string | null, killerTeam: TeamId | null, victim: string, victimTeam: TeamId, weapon: string, mine: boolean): void
  chat(name: string, team: TeamId | null, text: string): void
  banner(text: string, sub?: string, ms?: number): void
  hitmarker(kill?: boolean): void
  /** Own aircraft was hit; `from` = attacker position (draws a directional arc). */
  damage(from?: Vec3 | null): void
  /** Victim death card: killer null = crashed. */
  deathCard(killer: string | null, killerTeam: TeamId | null, weapon: string, distance: number | null): void
  /** True while the ground-proximity warning is showing (the game plays the warning tone). */
  readonly pullUp: boolean
  setVisible(flying: boolean): void
  openChat(onSend: (text: string | null) => void): void
  chatOpen(): boolean
  dispose(): void
}

const MARKERS = 48
const _v = new Vector3()
const _cam = new Vector3()

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html) e.innerHTML = html
  parent?.appendChild(e)
  return e
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

/** Cached text/style writer: avoids DOM writes when nothing changed. */
class Slot {
  private text = ""
  private tf = ""
  private cls = ""
  constructor(readonly el: HTMLElement) {}
  setText(t: string) { if (t !== this.text) { this.text = t; this.el.textContent = t } }
  setTransform(t: string) { if (t !== this.tf) { this.tf = t; this.el.style.transform = t } }
  setClass(c: string) { if (c !== this.cls) { this.cls = c; this.el.className = c } }
}

interface Marker { root: HTMLElement; label: Slot; glyph: Slot; dist: Slot; slot: Slot; tf: Slot; color: string; used: boolean }

/** Brighter team tints for text/lines on top of the 3D scene (the raw team colours are too dark on sky). */
const TEAM_TINTS = ["#8fb6ff", "#ffc06a", "#7fe0a0", "#ff8a80"]
const glyph = (t: number) => `<i class="tg t${t}" style="--c:${TEAM_TINTS[t]}"></i>`

export function createHud(parent: HTMLElement): Hud {
  const root = el("div", "hud", parent)
  root.innerHTML = `
    <div class="hud-canopy"><svg viewBox="0 0 1600 900" preserveAspectRatio="none"><path d="M70 900C150 520 340 230 640 110L800 84 960 110C1260 230 1450 520 1530 900" /><path class="bow" d="M800 84V-10M560 150 420 -10M1040 150 1180 -10" /></svg></div>
    <div class="hud-dmg"></div>
    <div class="hud-dir"><i></i></div>
    <div class="hud-pullup">PULL UP</div>
    <div class="hud-death"><div class="l1"></div><div class="l2"></div></div>
    <div class="hud-low"></div>
    <div class="hud-warnfx"></div>
    <div class="hud-markers"></div>
    <div class="hud-lead"></div>
    <div class="hud-seeker"><i></i></div>
    <div class="hud-scan"><i class="c"></i><i class="x"></i><span class="r"></span></div>
    <div class="hud-msl"><i></i><span>MSL</span></div>
    <div class="hud-lock"><i class="ring"></i><i class="br"></i><b>LOCK</b></div>
    <div class="hud-bore"><i></i></div>
    <div class="hud-aim"><i></i><div class="hud-hit"><i></i><i></i><i></i><i></i></div></div>
    <div class="hud-top z">
      <div class="hud-compass"><div class="strip"></div><i class="caret"></i><span class="hdg">000</span></div>
      <div class="hud-score"></div>
      <div class="hud-center-msg"><div class="protected"><i></i>SAFE ZONE<span>weapons safe</span></div><div class="warn"><b>›</b>MISSILE<b>‹</b></div><div class="freelook">FREE LOOK</div></div>
    </div>
    <div class="hud-banner z"><div class="t"></div><div class="s"></div></div>
    <div class="hud-guide z"><b></b><span></span></div>
    <div class="hud-hint z"></div>
    <div class="hud-tape left"><div class="win"><div class="ladder"></div></div><div class="box"><span class="val">0</span></div><div class="lbl">SPD <em>km/h</em></div><div class="thr"><i></i></div><div class="boost">BOOST</div></div>
    <div class="hud-tape right"><div class="win"><div class="ladder"></div></div><div class="box"><span class="val">0</span></div><div class="lbl">ALT <em>m</em></div></div>
    <div class="hud-bottom z">
      <div class="seat"><span class="nm"></span><span class="flares"></span></div>
      <div class="hp"><span class="hl">HULL</span><div class="bar"><i class="ghost"></i><i class="fill"></i></div><span class="hv"></span></div>
      <div class="weapons"></div>
    </div>
    <div class="hud-feed z"></div>
    <div class="hud-chat z"><div class="log"></div><input maxlength="140" placeholder="Say something… (Enter to send, Esc to cancel)" /></div>
    <div class="hud-mapwrap z"><canvas class="hud-map"></canvas><span class="n">N</span></div>
    <div class="hud-board z"></div>
    <div class="hud-ping z"></div>`
  const q = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector(s) as T
  const markerHost = q(".hud-markers")
  const aim = new Slot(q(".hud-aim"))
  const bore = new Slot(q(".hud-bore"))
  const lead = new Slot(q(".hud-lead"))
  const lockBox = new Slot(q(".hud-lock"))
  const lockLbl = new Slot(q(".hud-lock b"))
  const lockEl = q(".hud-lock")
  let lockP = -1
  const seeker = new Slot(q(".hud-seeker"))
  let seekerR = -1
  const scan = new Slot(q(".hud-scan"))
  let scanR = -1
  const scanRange = new Slot(q(".hud-scan .r"))
  const msl = new Slot(q(".hud-msl"))
  const guide = new Slot(q(".hud-guide"))
  const guideT = new Slot(q(".hud-guide b"))
  const guideS = new Slot(q(".hud-guide span"))
  const hint = new Slot(q(".hud-hint"))
  const hitEl = q(".hud-hit")
  const dmgEl = q(".hud-dmg")
  const dirEl = q(".hud-dir")
  const pullEl = new Slot(q(".hud-pullup"))
  const deathEl = q(".hud-death")
  let pullUp = false
  let lastCam: PerspectiveCamera | null = null
  const strip = q(".hud-compass .strip")
  const stripTf = new Slot(strip)
  const hdg = new Slot(q(".hud-compass .hdg"))
  const scoreEl = q(".hud-score")
  let scoreHtml = ""
  const centerMsg = new Slot(q(".hud-center-msg"))
  const banner = q(".hud-banner")
  const spd = new Slot(q(".hud-tape.left .val"))
  const spdLadder = new Slot(q(".hud-tape.left .ladder"))
  const thr = new Slot(q(".hud-tape.left .thr i"))
  const boostEl = new Slot(q(".hud-tape.left .boost"))
  const alt = new Slot(q(".hud-tape.right .val"))
  const altLadder = new Slot(q(".hud-tape.right .ladder"))
  const seatEl = new Slot(q(".hud-bottom .seat .nm"))
  const hpBar = new Slot(q(".hud-bottom .hp .fill"))
  const hpGhost = new Slot(q(".hud-bottom .hp .ghost"))
  const hpRow = new Slot(q(".hud-bottom .hp"))
  const hpTxt = new Slot(q(".hud-bottom .hp .hv"))
  const weaponsEl = q(".hud-bottom .weapons")
  const flares = new Slot(q(".hud-bottom .flares"))
  const feed = q(".hud-feed")
  const chatLog = q(".hud-chat .log")
  const chatInput = q<HTMLInputElement>(".hud-chat input")
  const map = q<HTMLCanvasElement>(".hud-map")
  const MAP_CSS = 172
  const mapDpr = Math.min(2, window.devicePixelRatio || 1)
  map.width = map.height = Math.round(MAP_CSS * mapDpr)
  const mapCtx = map.getContext("2d")!
  const board = q(".hud-board")
  const ping = new Slot(q(".hud-ping"))
  let lastHpFrac = -1
  let rootCls = ""
  let shown = false

  // Compass strip: 3 turns of labels so wrap-around is seamless; minor ticks come from a CSS gradient.
  const PX_PER_DEG = 3
  let stripHtml = ""
  for (let d = -360; d <= 720; d += 15) {
    const n = ((d % 360) + 360) % 360
    const label = n === 0 ? "N" : n === 90 ? "E" : n === 180 ? "S" : n === 270 ? "W" : n % 45 === 0 ? (n === 45 ? "NE" : n === 135 ? "SE" : n === 225 ? "SW" : "NW") : n % 30 === 0 ? String(n / 10).padStart(2, "0") : ""
    stripHtml += `<span style="left:${(d + 360) * PX_PER_DEG}px" class="${n % 90 === 0 ? "card" : n % 45 === 0 ? "ic" : ""}">${label}</span>`
  }
  strip.innerHTML = stripHtml

  const markers: Marker[] = []
  for (let i = 0; i < MARKERS; i++) {
    const m = el("div", "mk", markerHost, `<i class="br"></i><span class="lb"><i class="tg"></i><span class="nm"></span></span><span class="ds"></span>`)
    markers.push({ root: m, label: new Slot(m.querySelector(".nm")!), glyph: new Slot(m.querySelector(".tg")!), dist: new Slot(m.querySelector(".ds")!), slot: new Slot(m), tf: new Slot(m), color: "", used: false })
  }

  const weaponRows: { name: Slot; ammo: Slot; bar: Slot; row: Slot; key: Slot; full: number; wasRegen: boolean }[] = []
  for (let i = 0; i < 2; i++) {
    const r = el("div", "w", weaponsEl, `<span class="k">${i === 0 ? "LMB" : "RMB"}</span><span class="n"></span><span class="a"></span><i class="bar"><b></b></i>`)
    weaponRows.push({ name: new Slot(r.querySelector(".n")!), ammo: new Slot(r.querySelector(".a")!), bar: new Slot(r.querySelector(".bar b")!), row: new Slot(r), key: new Slot(r.querySelector(".k")!), full: 0, wasRegen: false })
  }

  const occlusion = new Map<string, { visible: boolean; at: number }>()
  let frame = 0
  let isDirect = false
  let lastMap = 0
  let lastBoard = 0
  let w = window.innerWidth, h = window.innerHeight
  const onResize = () => {
    w = window.innerWidth; h = window.innerHeight
    // UI chrome scales with the viewport (1.0 at 900 px tall).
    root.style.setProperty("--k", Math.max(0.78, Math.min(1.45, Math.min(h / 900, w / 1500))).toFixed(3))
  }
  onResize()
  window.addEventListener("resize", onResize)

  const project = (p: Vec3, cam: PerspectiveCamera): boolean => {
    _v.set(p[0], p[1], p[2]).project(cam)
    return _v.z < 1 && _v.z > -1
  }
  const sx = () => (_v.x * 0.5 + 0.5) * w
  const sy = () => (-_v.y * 0.5 + 0.5) * h
  const tf = (x: number, y: number) => `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`
  const HIDDEN = "translate3d(-9999px,0,0)"
  const coneR = (cone: number, cam: PerspectiveCamera) => (Math.tan(cone) / Math.tan((cam.fov * Math.PI) / 360)) * h * 0.5

  let chatCb: ((t: string | null) => void) | null = null
  chatInput.addEventListener("keydown", e => {
    e.stopPropagation()
    if (e.key === "Enter") { const t = chatInput.value.trim(); chatInput.value = ""; close(t || null) }
    else if (e.key === "Escape") { chatInput.value = ""; close(null) }
  })
  const close = (t: string | null) => {
    root.classList.remove("chatting")
    chatInput.blur()
    const cb = chatCb
    chatCb = null
    cb?.(t)
  }

  // Terrain backdrop for the minimap in the world's pastel bands, sampled once off the critical path.
  let mapBg: HTMLCanvasElement | null = null
  const BANDS: [number, number, number, number][] = [
    [-40, 0x2c, 0x4f, 0x78], [-8, 0x3f, 0x7f, 0x9a], [0, 0x7f, 0xd0, 0xc0], [14, 0xef, 0xcf, 0x98], [180, 0xb9, 0xb8, 0x66],
    [380, 0x9a, 0xab, 0x68], [620, 0x6f, 0x8a, 0x55], [900, 0xc4, 0x9a, 0x74], [1300, 0xd6, 0xb4, 0x8e], [Infinity, 0xef, 0xd2, 0xa6],
  ]

  const buildMapBg = () => {
    const N = 160
    const c = document.createElement("canvas")
    c.width = c.height = N
    const g = c.getContext("2d")!
    const img = g.createImageData(N, N)
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N - 0.5) * WORLD_HALF * 2, z = ((j + 0.5) / N - 0.5) * WORLD_HALF * 2
      const ht = terrainHeight(x, z)
      let b = BANDS[0]
      for (const band of BANDS) { b = band; if (ht < band[0]) break }
      const o = (j * N + i) * 4
      img.data[o] = b[1]; img.data[o + 1] = b[2]; img.data[o + 2] = b[3]; img.data[o + 3] = 255
    }
    g.putImageData(img, 0, 0)
    mapBg = c
  }
  const idle = (window as unknown as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 200))
  idle(buildMapBg)

  const glyphPath = (ctx: CanvasRenderingContext2D, t: number, x: number, y: number, r: number) => {
    ctx.beginPath()
    if (t === 0) ctx.arc(x, y, r, 0, Math.PI * 2)
    else if (t === 1) { ctx.moveTo(x, y - r * 1.15); ctx.lineTo(x + r * 1.1, y + r * 0.85); ctx.lineTo(x - r * 1.1, y + r * 0.85); ctx.closePath() }
    else if (t === 2) ctx.rect(x - r * 0.88, y - r * 0.88, r * 1.76, r * 1.76)
    else { ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 1.2, y); ctx.lineTo(x, y + r * 1.2); ctx.lineTo(x - r * 1.2, y); ctx.closePath() }
  }

  function drawMap(f: HudFrame) {
    const S = MAP_CSS
    const k = S / (WORLD_HALF * 2)
    const ctx = mapCtx
    ctx.setTransform(mapDpr, 0, 0, mapDpr, 0, 0)
    ctx.fillStyle = "#3f7f9a"
    ctx.fillRect(0, 0, S, S)
    if (mapBg) { ctx.imageSmoothingEnabled = true; ctx.drawImage(mapBg, 0, 0, S, S) }
    ctx.strokeStyle = "rgba(255,236,200,.16)"
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 1; i < 4; i++) { const g = Math.round((i * S) / 4) + 0.5; ctx.moveTo(g, 0); ctx.lineTo(g, S); ctx.moveTo(0, g); ctx.lineTo(S, g) }
    ctx.stroke()
    for (let t = 0; t < f.teams; t++) {
      const b = AIRBASES[t]
      const x = (b.center[0] + WORLD_HALF) * k, y = (b.center[2] + WORLD_HALF) * k
      ctx.fillStyle = TEAM_COLORS[t] + "33"
      ctx.strokeStyle = TEAM_COLORS[t]
      ctx.setLineDash([3, 2])
      ctx.beginPath(); ctx.arc(x, y, Math.max(5, b.safeRadius * k), 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      ctx.setLineDash([])
    }
    const myTeam = f.me?.team ?? -1
    ctx.lineWidth = 1.25
    for (const v of f.vehicles) {
      if (!v.alive) continue
      if (f.vehicle && v.id === f.vehicle.id) continue
      const spotted = v.spottedUntil > f.time
      if (v.team !== myTeam && !spotted) continue
      const x = (v.flight.position[0] + WORLD_HALF) * k, y = (v.flight.position[2] + WORLD_HALF) * k
      if (spotted && v.team !== myTeam) { ctx.strokeStyle = "rgba(195,181,255,.9)"; ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.stroke() }
      glyphPath(ctx, v.team, x, y, v.team === myTeam ? 2.6 : 3.2)
      ctx.fillStyle = TEAM_COLORS[v.team]
      ctx.fill()
      ctx.strokeStyle = "rgba(255,255,255,.85)"
      ctx.stroke()
    }
    if (f.vehicle) {
      const p = f.vehicle.flight.position
      const x = (p[0] + WORLD_HALF) * k, y = (p[2] + WORLD_HALF) * k
      const a = (f.heading * Math.PI) / 180
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(a)
      const cone = ctx.createRadialGradient(0, 0, 0, 0, 0, 34)
      cone.addColorStop(0, "rgba(255,255,255,.4)"); cone.addColorStop(1, "rgba(255,255,255,0)")
      ctx.fillStyle = cone
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 34, -Math.PI / 2 - 0.45, -Math.PI / 2 + 0.45); ctx.closePath(); ctx.fill()
      ctx.fillStyle = "#fff"
      ctx.strokeStyle = "#26204a"
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(0, -6.5); ctx.lineTo(4.5, 4.5); ctx.lineTo(0, 2.2); ctx.lineTo(-4.5, 4.5); ctx.closePath(); ctx.stroke(); ctx.fill()
      ctx.restore()
    }
  }

  function drawBoard(f: HudFrame) {
    const teams: PlayerInfo[][] = Array.from({ length: f.teams }, () => [])
    for (const p of f.players.values()) if (p.team < f.teams) teams[p.team].push(p)
    board.innerHTML = teams.map((list, t) => {
      list.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
      return `<div class="team${t === (f.me?.team ?? -1) ? " mine" : ""}" style="--c:${TEAM_COLORS[t]}"><h3><i class="tg t${t}"></i><span>${TEAM_NAMES[t]}</span><b>${f.scores[t] ?? 0}</b></h3>
        <table><tr><th>Pilot</th><th>K</th><th>D</th></tr>${list.map(p =>
          `<tr class="${p.id === f.myId ? "me" : ""}"><td>${esc(p.name)}${p.bot ? ' <em>BOT</em>' : ""}</td><td>${p.kills}</td><td>${p.deaths}</td></tr>`).join("") || `<tr><td class="none" colspan="3">No pilots</td></tr>`}</table></div>`
    }).join("")
  }

  return {
    root,
    update(f) {
      frame++
      const cam = f.camera
      lastCam = cam
      _cam.copy(cam.position)
      const flying = !!f.vehicle && f.vehicle.alive
      if (f.direct !== isDirect) {
        isDirect = f.direct
        ;(isDirect ? bore.el : aim.el).appendChild(hitEl)
      }
      // Aim reticle + boresight
      if (flying && f.aimPoint && project(f.aimPoint, cam)) aim.setTransform(tf(sx(), sy())); else aim.setTransform(HIDDEN)
      if (flying && f.borePoint && project(f.borePoint, cam)) bore.setTransform(tf(sx(), sy())); else bore.setTransform(HIDDEN)
      if (flying && f.lead && project(f.lead, cam)) lead.setTransform(tf(sx(), sy())); else lead.setTransform(HIDDEN)
      if (flying && f.lockTarget && f.lockProgress > 0 && project(f.lockTarget, cam)) {
        lockBox.setTransform(tf(sx(), sy()))
        const locked = f.lockProgress >= 1
        lockBox.setClass(locked ? "hud-lock locked" : "hud-lock")
        lockLbl.setText(locked ? "LOCKED" : `LOCK ${Math.round(f.lockProgress * 100)}`)
        const p = Math.round(f.lockProgress * 20) / 20
        if (p !== lockP) { lockP = p; lockEl.style.setProperty("--p", String(p)) }
      } else { lockBox.setTransform(HIDDEN); if (lockP !== -1) { lockP = -1; lockEl.style.setProperty("--p", "0") } }

      // Seeker circle: lock cone projected to pixels (radius = tan(cone) / tan(fov/2) * h/2).
      if (flying && f.seekerCone > 0 && f.seekerCenter && project(f.seekerCenter, cam)) {
        const r = Math.round(coneR(f.seekerCone, cam))
        if (r !== seekerR) { seekerR = r; seeker.el.style.setProperty("--r", `${r}px`) }
        seeker.setTransform(tf(sx(), sy()))
      } else seeker.setTransform(HIDDEN)
      // Scanner reticle replaces the aim circle for the radar officer.
      if (flying && f.scanner && f.aimPoint && project(f.aimPoint, cam)) {
        const r = Math.max(16, Math.round(coneR(f.scannerCone, cam)))
        scan.setTransform(tf(sx(), sy()))
        if (r !== scanR) { scanR = r; scan.el.style.setProperty("--r", `${r}px`) }
        if (frame % 6 === 0) scanRange.setText(f.scannerRange === null ? "NO TARGET" : `RNG ${(f.scannerRange / 1000).toFixed(1)} KM`)
      } else scan.setTransform(HIDDEN)
      if (flying && f.guide) {
        guide.setClass(f.guide.lost ? "hud-guide z on lost" : "hud-guide z on")
        if (frame % 4 === 0) {
          guideT.setText(f.guide.lost ? "GUIDANCE LOST · REACQUIRE" : "GUIDING · HOLD ON TARGET")
          guideS.setText(f.guide.tti === null ? "NO TARGET" : `IMPACT ${f.guide.tti.toFixed(1)}s`)
        }
        if (project(f.guide.missile, cam)) msl.setTransform(tf(sx(), sy())); else msl.setTransform(HIDDEN)
      } else { guide.setClass("hud-guide z"); msl.setTransform(HIDDEN) }
      if (frame % 10 === 0) { hint.setText(flying && f.hint ? f.hint : ""); hint.setClass(flying && f.hint ? "hud-hint z on" : "hud-hint z") }

      // Target markers
      const myTeam = f.me?.team ?? -1
      let mi = 0
      const ownId = f.vehicle?.id
      for (const v of f.vehicles) {
        if (mi >= MARKERS) break
        if (!v.alive || v.id === ownId) continue
        const p = v.flight.position
        const dist = Math.hypot(p[0] - _cam.x, p[1] - _cam.y, p[2] - _cam.z)
        const friend = v.team === myTeam
        const spotted = !friend && v.spottedUntil > f.time
        if (!friend && !spotted && dist > 3500) continue
        if (friend && dist > 6000) continue
        if (!friend && !spotted) {
          let o = occlusion.get(v.id)
          if (!o || f.time - o.at > 0.25) {
            const hit = segmentHitsGround([_cam.x, _cam.y, _cam.z], p)
            o = { visible: hit === null, at: f.time }
            occlusion.set(v.id, o)
          }
          if (!o.visible) continue
        }
        if (!project(p, cam)) continue
        const m = markers[mi++]
        m.used = true
        const color = TEAM_TINTS[v.team]
        if (m.color !== color) { m.color = color; m.root.style.setProperty("--c", color); m.glyph.setClass(`tg t${v.team}`) }
        m.slot.setClass(`mk ${friend ? "friend" : "enemy"}${spotted ? " spotted" : ""}${!friend && dist > 1800 && !spotted ? " far" : ""}`)
        const s = friend ? 1 : Math.max(0.6, Math.min(1.5, 1040 / Math.max(1, dist)))
        m.tf.setTransform(tf(sx(), sy()) + ` scale(${s.toFixed(2)})`)
        if ((frame + mi) % 8 === 0 || m.label.el.textContent === "") {
          const pilot = v.seats[0] ? f.players.get(v.seats[0]) : null
          m.label.setText(friend || dist < 1800 || spotted ? `${pilot?.name ?? VEHICLES[v.kind].name}` : "")
          m.dist.setText(dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`)
        }
      }
      for (let i = mi; i < MARKERS; i++) if (markers[i].used) { markers[i].used = false; markers[i].tf.setTransform(HIDDEN) }

      // Tapes: ladders scroll every frame (compositor-only transforms).
      if (flying) {
        const kmh = f.speed * 3.6
        spdLadder.setTransform(`translate3d(0,${(((kmh / 5) * 8) % 40).toFixed(1)}px,0)`)
        altLadder.setTransform(`translate3d(0,${(((Math.max(0, f.altitude) / 10) * 8) % 40).toFixed(1)}px,0)`)
        stripTf.setTransform(`translate3d(${(-(f.heading + 360) * PX_PER_DEG).toFixed(1)}px,0,0)`)
      }

      // Throttled text
      if (frame % 4 === 0) {
        hdg.setText(String(Math.round(f.heading) % 360).padStart(3, "0"))
        spd.setText(String(Math.round(f.speed * 3.6)))
        alt.setText(String(Math.round(f.altitude)))
        thr.setTransform(`scaleY(${Math.max(0, Math.min(1, f.throttle)).toFixed(2)})`)
        boostEl.setClass(f.boost ? "boost on" : "boost")
        centerMsg.setClass(`hud-center-msg${f.protected && flying ? " is-protected" : ""}${f.missileWarning && flying ? " is-warn" : ""}${f.freeLook && flying ? " is-free" : ""}`)
        const v = f.vehicle
        let low = false
        if (v) {
          const seatName = f.seat !== null ? VEHICLES[v.kind].seatNames[f.seat].toUpperCase() : ""
          seatEl.setText(`${VEHICLES[v.kind].name.toUpperCase()} · ${seatName}`)
          const hp = Math.max(0, v.hp / v.maxHp)
          low = hp < 0.3 && flying
          if (hp !== lastHpFrac) {
            hpBar.setTransform(`scaleX(${hp.toFixed(3)})`)
            hpGhost.setTransform(`scaleX(${hp.toFixed(3)})`)
            hpRow.setClass(`hp${hp < 0.3 ? " low" : hp < 0.6 ? " mid" : ""}${hp > lastHpFrac && lastHpFrac >= 0 ? " heal" : ""}`)
            lastHpFrac = hp
          }
          hpTxt.setText(String(Math.ceil(Math.max(0, v.hp))))
          flares.setText(f.seat === 0 ? `✦ ${v.flareCount}` : "")
        }
        const nowMs = performance.now()
        for (let i = 0; i < 2; i++) {
          const wr = weaponRows[i]
          const wpn = f.weapons[i]
          if (!wpn) { wr.row.setClass("w off"); continue }
          if (wpn.keys) wr.key.setText(wpn.keys)
          const spec = WEAPONS[wpn.id]
          const unlimited = wpn.cap < 0 || wpn.ammo < 0
          const empty = !unlimited && wpn.ammo <= 0
          // Magazine topped back up: brief glow.
          if (wr.wasRegen && !wpn.regen && !unlimited && wpn.ammo >= wpn.cap) wr.full = nowMs + 700
          wr.wasRegen = wpn.regen
          wr.row.setClass(`w${wpn.ready < 1 ? " reload" : ""}${wpn.locked ? " locked" : ""}${wpn.regen ? " regen" : ""}${empty ? " empty" : ""}${wr.full > nowMs ? " full" : ""}`)
          wr.name.setText(spec.name.toUpperCase())
          wr.ammo.setText(spec.kind === "pulse" ? (wpn.ready >= 1 ? "READY" : `${Math.round(wpn.ready * 100)}%`) : unlimited ? "∞" : empty ? "RELOAD" : String(wpn.ammo))
          const frac = spec.kind === "pulse" ? wpn.ready : unlimited ? 1 : wpn.ammo / Math.max(1, wpn.cap)
          wr.bar.setTransform(`scaleX(${Math.max(0, Math.min(1, frac)).toFixed(3)})`)
        }
        const cls = `hud${shown ? " flying" : ""}${f.cockpit && flying ? " cockpit" : ""}${isDirect ? " direct" : ""}${flying && f.scanner ? " scanning" : ""}${low ? " low" : ""}${f.missileWarning && flying ? " warn" : ""}`
        if (cls !== rootCls) {
          // Preserve externally toggled classes (scoreboard / chat).
          const keep = (root.classList.contains("board") ? " board" : "") + (root.classList.contains("chatting") ? " chatting" : "")
          rootCls = cls
          root.className = cls + keep
        }
        ping.setText(f.ping > 0 ? `${Math.round(f.ping)} ms` : "")
        // Ground proximity: project the velocity forward and look for terrain impact within 6 s.
        pullUp = false
        if (flying && f.vehicle) {
          const p = f.vehicle.flight.position, vel = f.vehicle.flight.velocity
          const agl = p[1] - groundHeight(p[0], p[2])
          if (agl < 300 && vel[1] < -2 && !f.vehicle.flight.onGround) {
            for (let t = 0.5; t <= 6; t += 0.5) {
              const x = p[0] + vel[0] * t, z = p[2] + vel[2] * t
              if (p[1] + vel[1] * t < groundHeight(x, z) + 2) { pullUp = true; break }
            }
          }
        }
        pullEl.setClass(pullUp ? "hud-pullup on" : "hud-pullup")
      }
      if (frame % 15 === 0) {
        let teams = ""
        for (let t = 0; t < f.teams; t++) teams += `<span class="sc${t === myTeam ? " mine" : ""}" style="--c:${TEAM_TINTS[t]}">${glyph(t)}<b>${f.scores[t] ?? 0}</b></span>`
        let timer = ""
        if (f.remaining !== null) {
          const r = Math.max(0, Math.ceil(f.remaining))
          timer = `<span class="timer${f.intermission ? " inter" : ""}${!f.intermission && r <= 60 ? " end" : ""}">${f.intermission ? "<em>NEXT</em>" : ""}${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}</span>`
        }
        const html = `<span class="teams">${teams}</span>${timer}`
        if (html !== scoreHtml) { scoreHtml = html; scoreEl.innerHTML = html }
      }
      const now = performance.now()
      if (flying && now - lastMap > 120) { lastMap = now; drawMap(f) }
      const showBoard = root.classList.contains("board")
      if (showBoard && now - lastBoard > 500) { lastBoard = now; drawBoard(f) }
    },

    killfeed(killer, killerTeam, victim, victimTeam, weapon, mine) {
      const row = el("div", mine ? "mine" : "", feed)
      const kt = killerTeam ?? 0
      row.innerHTML = killer
        ? `<b style="color:${TEAM_TINTS[kt]}">${glyph(kt)}${esc(killer)}</b><span>${esc(weapon)}</span><b style="color:${TEAM_TINTS[victimTeam]}">${glyph(victimTeam)}${esc(victim)}</b>`
        : `<b style="color:${TEAM_TINTS[victimTeam]}">${glyph(victimTeam)}${esc(victim)}</b><span>${esc(weapon)}</span>`
      setTimeout(() => row.classList.add("out"), 6500)
      setTimeout(() => row.remove(), 7200)
      while (feed.childElementCount > 6) feed.firstElementChild!.remove()
    },

    chat(name, team, text) {
      const row = el("div", "", chatLog)
      row.innerHTML = `<b style="color:${team === null ? "#d6d9e4" : TEAM_TINTS[team]}">${team === null ? "" : glyph(team)}${esc(name)}</b> ${esc(text)}`
      setTimeout(() => row.classList.add("out"), 12000)
      while (chatLog.childElementCount > 8) chatLog.firstElementChild!.remove()
    },

    banner(text, sub = "", ms = 2600) {
      banner.querySelector(".t")!.textContent = text
      banner.querySelector(".s")!.textContent = sub
      banner.classList.remove("show")
      void banner.offsetWidth
      banner.classList.add("show")
      clearTimeout((banner as unknown as { _t: number })._t)
      ;(banner as unknown as { _t: number })._t = window.setTimeout(() => banner.classList.remove("show"), ms)
    },

    hitmarker(kill = false) {
      hitEl.className = kill ? "hud-hit kill" : "hud-hit"
      void hitEl.offsetWidth
      hitEl.classList.add("on")
    },

    get pullUp() { return pullUp },

    deathCard(killer, killerTeam, weapon, distance) {
      const l1 = deathEl.querySelector(".l1")!, l2 = deathEl.querySelector(".l2")!
      if (killer) {
        const t = killerTeam ?? 0
        l1.innerHTML = `SHOT DOWN BY <b style="color:${TEAM_TINTS[t]}">${glyph(t)}${esc(killer)}</b>`
        l2.textContent = [weapon, distance !== null ? (distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} m`) : ""].filter(Boolean).join(" · ")
      } else {
        l1.textContent = "CRASHED"
        l2.textContent = weapon && weapon !== "crashed" ? weapon : "watch the ground"
      }
      deathEl.classList.remove("show")
      void deathEl.offsetWidth
      deathEl.classList.add("show")
      clearTimeout((deathEl as unknown as { _t: number })._t)
      ;(deathEl as unknown as { _t: number })._t = window.setTimeout(() => deathEl.classList.remove("show"), 2500)
    },

    damage(from) {
      if (from && lastCam) {
        // Direction of the attacker in camera space → screen angle (0 = up, clockwise).
        _v.set(from[0], from[1], from[2]).applyMatrix4(lastCam.matrixWorldInverse)
        const ang = Math.atan2(_v.x, _v.y) * 180 / Math.PI
        dirEl.style.setProperty("--a", `${ang.toFixed(0)}deg`)
        dirEl.classList.remove("on")
        void dirEl.offsetWidth
        dirEl.classList.add("on")
      }
      dmgEl.classList.remove("on")
      void dmgEl.offsetWidth
      dmgEl.classList.add("on")
    },

    setVisible(flying) {
      shown = flying
      root.classList.toggle("flying", flying)
      rootCls = ""
    },

    openChat(onSend) {
      chatCb = onSend
      root.classList.add("chatting")
      chatInput.focus()
    },

    chatOpen: () => chatCb !== null,

    dispose() {
      window.removeEventListener("resize", onResize)
      root.remove()
    },
  }
}

/** Toggle the Tab scoreboard. */
export function setScoreboard(hud: Hud, show: boolean): void {
  hud.root.classList.toggle("board", show)
}
