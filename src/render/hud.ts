// DOM HUD. Positions are written with compositor-only transforms every frame; text is throttled
// and only written when it changes, so the HUD never forces layout.
import { Vector3, type PerspectiveCamera } from "three"
import type { PlayerInfo, TeamId, Vec3, VehicleEntity, WeaponId } from "../sim/types"
import { VEHICLES, WEAPONS } from "../sim/vehicles"
import { WORLD_HALF, segmentHitsGround, terrainHeight } from "../sim/geography"
import { AA_RANGE, FLEET, type Ship } from "../sim/fleet"
import { posedFleet, posedShip } from "../sim/geography"
import { RECON_KINDS, SPOT_CONE, SPOT_DECAY, SPOT_RANGE, SPOT_TIME } from "../sim/combat"

/** Muted team colours (match render/aircraft.ts TEAM_COLORS). */
export const TEAM_COLORS = ["#3c6ea8", "#c98a2e", "#4e8a5a", "#b04a44"]
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
  /** Gunner optical zoom (1 = none). */
  zoom?: number
  /** Seconds of spawn protection left. */
  protectedLeft?: number
  /** Distance to the nearest enemy ship while inside its anti-air umbrella (null = clear). */
  aaDist?: number | null
  /** Enemy AA is firing at us right now. */
  aaFire?: boolean
}

export interface Hud {
  root: HTMLElement
  update(f: HudFrame): void
  killfeed(killer: string | null, killerTeam: TeamId | null, victim: string, victimTeam: TeamId, weapon: string, mine: boolean, bots?: { killer?: boolean; victim?: boolean }): void
  /** Recon spot confirmation line ("you spotted red fox"). */
  spotted(by: string | null, byTeam: TeamId | null, target: string, targetTeam: TeamId, mine: boolean): void
  chat(name: string, team: TeamId | null, text: string): void
  banner(text: string, sub?: string, ms?: number): void
  hitmarker(kill?: boolean): void
  /** Own aircraft was hit; `from` = attacker position (draws a directional arc). */
  damage(from?: Vec3 | null): void
  /** Victim death card: killer null = crashed. */
  deathCard(killer: string | null, killerTeam: TeamId | null, weapon: string, distance: number | null): void
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

interface Marker { root: HTMLElement; label: Slot; dist: Slot; slot: Slot; tf: Slot; arc: HTMLElement; arcP: number; color: string; used: boolean }
interface Edge { slot: Slot; tf: Slot; color: string; used: boolean }
const EDGES = 12

/** Brighter team tints for text/lines on top of the 3D scene (the raw team colours are too dark on sky). */
/** Lighter tints of the muted team colours, for text and lines over the world. */
const TEAM_TINTS = ["#b4d0f0", "#f2c98a", "#b4dcba", "#efb2aa"]
const sentence = (t: string) => { const l = t.toLowerCase(); return l.charAt(0).toUpperCase() + l.slice(1) }
const glyph = (_t: number) => ""

export function createHud(parent: HTMLElement): Hud {
  const root = el("div", "hud", parent)
  root.innerHTML = `
    <div class="hud-canopy"><svg viewBox="0 0 1600 900" preserveAspectRatio="none"><path d="M70 900C150 520 340 230 640 110L800 84 960 110C1260 230 1450 520 1530 900" /><path class="bow" d="M800 84V-10M560 150 420 -10M1040 150 1180 -10" /></svg></div>
    <div class="hud-dmg"></div>
    <div class="hud-dir"><i></i></div>
    <div class="hud-death"><div class="l1"></div><div class="l2"></div></div>
    <div class="hud-low"></div>
    <div class="hud-warnfx"></div>
    <div class="hud-markers"></div>
    <div class="hud-edges"></div>
    <div class="hud-spot"><b></b></div>
    <div class="hud-ships"></div>
    <div class="hud-aa"><b>enemy fleet — anti-air</b><span></span></div>
    <div class="hud-prot"></div>
    <div class="hud-zoom"></div>
    <div class="hud-lead"></div>
    <div class="hud-scan"><i class="c"></i><i class="x"></i><span class="r"></span></div>
    <div class="hud-msl"><i></i><span>msl</span></div>
    <div class="hud-lock"><i class="ring"></i><i class="br"></i><b>lock</b></div>
    <div class="hud-bore"><i></i></div>
    <div class="hud-aim"><i></i><div class="hud-hit"><i></i><i></i><i></i><i></i></div></div>
    <div class="hud-top z">
      <div class="hud-compass"><div class="strip"></div><i class="caret"></i><span class="hdg">000</span></div>
      <div class="hud-score"></div>
      <div class="hud-center-msg"><div class="protected"></div><div class="warn">Missile</div><div class="freelook">free look</div></div>
    </div>
    <div class="hud-banner z"><div class="t"></div><div class="s"></div></div>
    <div class="hud-guide z"><b></b><span></span></div>
    <div class="hud-hint z"></div>
    <div class="hud-tape left"><div class="win"><div class="ladder"></div></div><div class="box"><span class="val">0</span></div><div class="lbl">km/h</div><div class="thr"><i></i></div><div class="boost">boost</div></div>
    <div class="hud-tape right"><div class="win"><div class="ladder"></div></div><div class="box"><span class="val">0</span></div><div class="lbl">m</div></div>
    <div class="hud-bottom z">
      <div class="seat"><span class="nm"></span><span class="flares"></span></div>
      <div class="hp"><span class="hl">hull</span><div class="bar"><i class="ghost"></i><i class="fill"></i></div><span class="hv"></span></div>
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
  const deathEl = q(".hud-death")
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
  let accentTeam = -2

  // Compass strip: 3 turns of labels so wrap-around is seamless; minor ticks come from a CSS gradient.
  const PX_PER_DEG = 3
  let stripHtml = ""
  for (let d = -360; d <= 720; d += 15) {
    const n = ((d % 360) + 360) % 360
    const label = n === 0 ? "n" : n === 90 ? "e" : n === 180 ? "s" : n === 270 ? "w" : n % 45 === 0 ? (n === 45 ? "ne" : n === 135 ? "se" : n === 225 ? "sw" : "nw") : n % 30 === 0 ? String(n).padStart(3, "0") : ""
    stripHtml += `<span style="left:${(d + 360) * PX_PER_DEG}px" class="${n % 90 === 0 ? "card" : n % 45 === 0 ? "ic" : ""}">${label}</span>`
  }
  strip.innerHTML = stripHtml

  const markers: Marker[] = []
  for (let i = 0; i < MARKERS; i++) {
    const m = el("div", "mk", markerHost, `<i class="br"></i><i class="arc"></i><span class="lb"><span class="nm"></span></span><span class="ds"></span>`)
    markers.push({ root: m, arc: m.querySelector(".arc") as HTMLElement, arcP: -1, label: new Slot(m.querySelector(".nm")!), dist: new Slot(m.querySelector(".ds")!), slot: new Slot(m), tf: new Slot(m), color: "", used: false })
  }

  const edgeHost = q(".hud-edges")
  const edges: Edge[] = []
  for (let i = 0; i < EDGES; i++) {
    const e = el("i", "edge", edgeHost)
    edges.push({ slot: new Slot(e), tf: new Slot(e), color: "", used: false })
  }
  const shipHost = q(".hud-ships")
  const shipMk = FLEET.map(sh => {
    const e = el("div", "shp", shipHost, `<i></i><span class="ds"></span>`)
    return { sh, tf: new Slot(e), cls: new Slot(e), ds: new Slot(e.querySelector(".ds")!) }
  })
  const aaEl = new Slot(q(".hud-aa"))
  const aaTxt = new Slot(q(".hud-aa span"))
  const protEl = new Slot(q(".hud-prot"))
  const spotEl = new Slot(q(".hud-spot"))
  const spotLbl = new Slot(q(".hud-spot b"))
  const zoomEl = new Slot(q(".hud-zoom"))
  // Local look-to-spot estimate (the wire may not carry spotProgress): mirrors combat.updateSpotting.
  let spotCand: string | null = null
  let spotProg = 0
  let spotDoneAt = -1
  let spotDoneName = ""
  let lastT = 0
  const _fwd = new Vector3()

  const weaponRows: { name: Slot; ammo: Slot; bar: Slot; row: Slot; key: Slot; full: number; wasRegen: boolean }[] = []
  for (let i = 0; i < 2; i++) {
    const r = el("div", "w", weaponsEl, `<span class="k">${i === 0 ? "lmb" : "rmb"}</span><span class="n"></span><span class="a"></span><i class="bar"><b></b></i>`)
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
    [-40, 0x2f, 0x5d, 0x78], [-8, 0x3f, 0x72, 0x88], [0, 0x6f, 0xa6, 0xa8], [14, 0xd4, 0xc3, 0x9a], [220, 0x7f, 0x9a, 0x5a],
    [520, 0x66, 0x82, 0x4c], [850, 0x7a, 0x74, 0x6b], [1300, 0x9a, 0x95, 0x8c], [Infinity, 0xee, 0xf1, 0xf2],
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

  const glyphPath = (ctx: CanvasRenderingContext2D, _t: number, x: number, y: number, r: number) => {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
  }

  function drawMap(f: HudFrame) {
    const S = MAP_CSS
    const k = S / (WORLD_HALF * 2)
    const ctx = mapCtx
    ctx.setTransform(mapDpr, 0, 0, mapDpr, 0, 0)
    ctx.fillStyle = "#2f5d78"
    ctx.fillRect(0, 0, S, S)
    if (mapBg) { ctx.imageSmoothingEnabled = true; ctx.drawImage(mapBg, 0, 0, S, S) }
    ctx.strokeStyle = "rgba(236,234,228,.14)"
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 1; i < 4; i++) { const g = Math.round((i * S) / 4) + 0.5; ctx.moveTo(g, 0); ctx.lineTo(g, S); ctx.moveTo(0, g); ctx.lineTo(S, g) }
    ctx.stroke()
    // Fleets: enemy anti-air umbrellas as faint dashed rings; each ship a small hull tick in the team colour.
    const mt = f.me?.team ?? -1
    for (const sh of posedFleet()) {
      const x = (sh.position[0] + WORLD_HALF) * k, y = (sh.position[2] + WORLD_HALF) * k
      if (sh.team !== mt) {
        ctx.strokeStyle = "rgba(255,122,46,.55)"
        ctx.setLineDash([2, 3])
        ctx.beginPath(); ctx.arc(x, y, AA_RANGE * k, 0, Math.PI * 2); ctx.stroke()
        ctx.setLineDash([])
      }
      const L = sh.kind === "carrier" ? 5 : 3, W = sh.kind === "carrier" ? 1.6 : 1.1
      ctx.save(); ctx.translate(x, y); ctx.rotate(-sh.heading)
      ctx.fillStyle = TEAM_COLORS[sh.team]; ctx.strokeStyle = "rgba(236,234,228,.9)"; ctx.lineWidth = 1
      ctx.beginPath(); ctx.rect(-W, -L, W * 2, L * 2); ctx.fill(); ctx.stroke()
      ctx.restore()
    }
    const myTeam = f.me?.team ?? -1
    ctx.lineWidth = 1.25
    for (const v of f.vehicles) {
      if (!v.alive) continue
      if (f.vehicle && v.id === f.vehicle.id) continue
      const spotted = v.spottedUntil > f.time
      if (v.team !== myTeam && !spotted) continue
      const x = (v.flight.position[0] + WORLD_HALF) * k, y = (v.flight.position[2] + WORLD_HALF) * k
      if (spotted && v.team !== myTeam) { ctx.strokeStyle = "#ff7a2e"; ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.stroke() }
      glyphPath(ctx, v.team, x, y, v.team === myTeam ? 2.6 : 3.2)
      ctx.fillStyle = TEAM_COLORS[v.team]
      ctx.fill()
      ctx.strokeStyle = "rgba(236,234,228,.85)"
      ctx.stroke()
    }
    if (f.vehicle) {
      const p = f.vehicle.flight.position
      const x = (p[0] + WORLD_HALF) * k, y = (p[2] + WORLD_HALF) * k
      const a = (f.heading * Math.PI) / 180
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(a)
      ctx.fillStyle = "rgba(236,234,228,.16)"
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 34, -Math.PI / 2 - 0.45, -Math.PI / 2 + 0.45); ctx.closePath(); ctx.fill()
      ctx.fillStyle = "#eceae4"
      ctx.strokeStyle = "#22262a"
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
      return `<div class="team${t === (f.me?.team ?? -1) ? " mine" : ""}" style="--c:${TEAM_COLORS[t]}"><h3><span>${TEAM_NAMES[t]}</span><b>${f.scores[t] ?? 0}</b></h3>
        <table><tr><th>Pilot</th><th>K</th><th>D</th></tr>${list.map(p =>
          `<tr class="${p.id === f.myId ? "me" : ""}"><td>${esc(p.name.toLowerCase())}${p.id === f.myId ? '<em>you</em>' : ""}${p.bot ? '<em>bot</em>' : ""}</td><td>${p.kills}</td><td>${p.deaths}</td></tr>`).join("") || `<tr><td class="none" colspan="3">no pilots</td></tr>`}</table></div>`
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
        const ld = Math.hypot(f.lockTarget[0] - _cam.x, f.lockTarget[1] - _cam.y, f.lockTarget[2] - _cam.z)
        lockLbl.setText(`${locked ? "locked" : `lock ${Math.round(f.lockProgress * 100)}`} · ${ld >= 1000 ? `${(ld / 1000).toFixed(1)} km` : `${Math.round(ld / 10) * 10} m`}`)
        const p = Math.round(f.lockProgress * 20) / 20
        if (p !== lockP) { lockP = p; lockEl.style.setProperty("--p", String(p)) }
      } else { lockBox.setTransform(HIDDEN); if (lockP !== -1) { lockP = -1; lockEl.style.setProperty("--p", "0") } }

      // Scanner reticle replaces the aim circle for the radar officer.
      if (flying && f.scanner && f.aimPoint && project(f.aimPoint, cam)) {
        const r = Math.max(14, Math.min(30, Math.round(coneR(f.scannerCone, cam))))
        scan.setTransform(tf(sx(), sy()))
        if (r !== scanR) { scanR = r; scan.el.style.setProperty("--r", `${r}px`) }
        if (frame % 6 === 0) scanRange.setText(f.scannerRange === null ? "no target" : `rng ${(f.scannerRange / 1000).toFixed(1)} km`)
      } else scan.setTransform(HIDDEN)
      if (flying && f.guide) {
        guide.setClass(f.guide.lost ? "hud-guide z on lost" : "hud-guide z on")
        if (frame % 4 === 0) {
          guideT.setText(f.guide.lost ? "guidance lost · reacquire" : "guiding · hold on target")
          guideS.setText(f.guide.tti === null ? "no target" : `impact ${f.guide.tti.toFixed(1)} s`)
        }
        if (project(f.guide.missile, cam)) msl.setTransform(tf(sx(), sy())); else msl.setTransform(HIDDEN)
      } else { guide.setClass("hud-guide z"); msl.setTransform(HIDDEN) }
      if (frame % 10 === 0) { hint.setText(flying && f.hint ? f.hint.toLowerCase() : ""); hint.setClass(flying && f.hint ? "hud-hint z on" : "hud-hint z") }

      // Target markers
      const myTeam = f.me?.team ?? -1
      if (myTeam !== accentTeam) { accentTeam = myTeam; root.style.setProperty("--team", myTeam >= 0 ? TEAM_TINTS[myTeam] : "#5aa2ff") }
      let mi = 0
      const ownId = f.vehicle?.id
      const cx = w / 2, cy = h / 2, k = Number(root.style.getPropertyValue("--k")) || 1
      // Tape zones (speed left, altitude right): markers there fade so the numbers stay readable.
      const inTape = (x: number, y: number) => Math.abs(y - cy) < 46 * k && Math.abs(Math.abs(x - cx) - 360 * k) < 90 * k

      // Recon pilot spotting: server progress when available, else a local estimate.
      const dtT = Math.max(0, Math.min(0.1, f.time - lastT))
      lastT = f.time
      const recon = flying && f.seat === 0 && !!f.vehicle && RECON_KINDS.has(f.vehicle.kind)
      if (recon && f.vehicle) {
        const sv = f.vehicle as VehicleEntity & { spotProgress?: number; spotCandidate?: string | null }
        if (sv.spotProgress !== undefined) { spotProg = sv.spotProgress; spotCand = sv.spotCandidate ?? null }
        else {
          cam.getWorldDirection(_fwd)
          let best: string | null = null, bestAng = SPOT_CONE
          for (const v of f.vehicles) {
            if (!v.alive || v.team === myTeam || v.spottedUntil > f.time + 1) continue
            const p = v.flight.position
            const dx = p[0] - _cam.x, dy = p[1] - _cam.y, dz = p[2] - _cam.z, d = Math.hypot(dx, dy, dz)
            if (d > SPOT_RANGE || d < 1) continue
            const ang = Math.acos(Math.max(-1, Math.min(1, (dx * _fwd.x + dy * _fwd.y + dz * _fwd.z) / d)))
            const lim = v.id === spotCand ? SPOT_CONE * 1.2 : bestAng
            if (ang < lim && (best === null || ang < bestAng)) { best = v.id; bestAng = ang }
          }
          if (best) {
            if (best !== spotCand) spotProg = 0
            spotCand = best
            spotProg = Math.min(1, spotProg + dtT / SPOT_TIME)
          } else { spotProg = Math.max(0, spotProg - SPOT_DECAY * dtT); if (spotProg === 0) spotCand = null }
        }
      } else { spotProg = 0; spotCand = null }

      let ei = 0
      for (const v of f.vehicles) {
        if (mi >= MARKERS) break
        if (!v.alive || v.id === ownId) continue
        const p = v.flight.position
        const dist = Math.hypot(p[0] - _cam.x, p[1] - _cam.y, p[2] - _cam.z)
        const friend = v.team === myTeam
        const spotted = !friend && v.spottedUntil > f.time
        const candidate = recon && v.id === spotCand && spotProg > 0
        if (!friend && !spotted && !candidate && dist > 3500) continue
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
        const onScreen = project(p, cam) && _v.x > -1 && _v.x < 1 && _v.y > -1 && _v.y < 1
        if (!onScreen) {
          // Off-screen enemies (in range or spotted): small chevron on the screen edge, pointing at them.
          if (friend || ei >= EDGES || dist > 4000 && !spotted) continue
          _v.set(p[0], p[1], p[2]).applyMatrix4(cam.matrixWorldInverse)
          let ex = _v.x, ey = _v.y
          if (_v.z > 0 && Math.abs(ex) < 1e-3 && Math.abs(ey) < 1e-3) ey = -1
          const ang = Math.atan2(ex, ey)
          const mx = cx - 40, my = cy - 40
          const sc = Math.min(mx / Math.max(1e-3, Math.abs(Math.sin(ang))), my / Math.max(1e-3, Math.abs(Math.cos(ang))))
          const e = edges[ei++]
          e.used = true
          const color = spotted ? "var(--or)" : TEAM_TINTS[v.team]
          if (e.color !== color) { e.color = color; e.slot.el.style.setProperty("--c", color) }
          e.slot.setClass(spotted ? "edge spotted" : "edge")
          e.tf.setTransform(tf(cx + Math.sin(ang) * sc, cy - Math.cos(ang) * sc) + ` rotate(${(ang * 180 / Math.PI).toFixed(0)}deg)`)
          continue
        }
        const x = sx(), y = sy()
        const m = markers[mi++]
        m.used = true
        const color = TEAM_TINTS[v.team]
        if (m.color !== color) { m.color = color; m.root.style.setProperty("--c", color) }
        const near = dist < 1800
        m.slot.setClass(`mk ${friend ? "friend" : "enemy"}${spotted ? " spotted" : ""}${candidate ? " spotting" : ""}${!friend && !near && !spotted ? " far" : ""}${inTape(x, y) ? " tape" : ""}`)
        // Whole pixels: fractional translate3d blurs the label text on its compositor layer.
        m.tf.setTransform(`translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`)
        if (candidate) {
          const pr = Math.round(spotProg * 40) / 40
          if (pr !== m.arcP) { m.arcP = pr; m.arc.style.setProperty("--sp", String(pr)) }
        }
        if ((frame + mi) % 8 === 0 || m.label.el.textContent === "") {
          const pilot = v.seats[0] ? f.players.get(v.seats[0]) : null
          m.label.setText(friend || near || spotted || candidate ? `${(pilot?.name ?? VEHICLES[v.kind].name).toLowerCase()}` : "")
          m.dist.setText(dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist / 10) * 10} m`)
        }
      }
      for (let i = ei; i < EDGES; i++) if (edges[i].used) { edges[i].used = false; edges[i].tf.setTransform(HIDDEN) }
      // Fleets: small hull markers with mono distance (enemy fleets within 9 km; own carrier always).
      for (const m of shipMk) {
        const sh: Ship = posedShip(m.sh.id) ?? m.sh
        if (sh.team >= f.teams || !flying) { m.tf.setTransform(HIDDEN); continue }
        const own = sh.team === myTeam
        const p: Vec3 = [sh.position[0], 30, sh.position[2]]
        const d = Math.hypot(p[0] - _cam.x, p[1] - _cam.y, p[2] - _cam.z)
        if ((own && (sh.kind !== "carrier" || d < 1500)) || (!own && d > 9000) || !project(p, cam) || Math.abs(_v.x) > 1 || Math.abs(_v.y) > 1) { m.tf.setTransform(HIDDEN); continue }
        m.cls.setClass(`shp${own ? " own" : ""}${!own && d < AA_RANGE ? " hot" : ""}`)
        m.tf.setTransform(`translate3d(${Math.round(sx())}px,${Math.round(sy())}px,0)`)
        // Distance only on carriers and on escorts that are close (keeps the fleet from cluttering the centre).
        const label = own || sh.kind === "carrier" || d < AA_RANGE * 1.5
        if ((frame + m.sh.position[0]) % 10 < 1 || m.ds.el.textContent === "" !== !label) m.ds.setText(!label ? "" : own ? "home" : d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`)
      }
      if (frame % 4 === 0) {
        const aa = flying && f.aaDist != null
        aaEl.setClass(aa ? `hud-aa on${f.aaFire ? " fire" : ""}` : "hud-aa")
        if (aa) aaTxt.setText(` · ${(f.aaDist! / 1000).toFixed(1)} km`)
        const pl = flying ? f.protectedLeft ?? 0 : 0
        protEl.setClass(pl > 0 ? "hud-prot on" : "hud-prot")
        if (pl > 0) protEl.setText(`protected · ${Math.ceil(pl)}s`)
      }
      // Spotting status under the crosshair.
      if (recon && (spotCand && spotProg > 0 || f.time - spotDoneAt < 1.6)) {
        const done = f.time - spotDoneAt < 1.6
        spotEl.setClass(done ? "hud-spot on done" : "hud-spot on")
        spotLbl.setText(done ? `spotted ${spotDoneName}` : `spotting… ${Math.round(spotProg * 100)}`)
      } else spotEl.setClass("hud-spot")
      // Gunner zoom readout.
      const z = flying && f.seat === 1 ? (f.zoom ?? 1) : 0
      zoomEl.setClass(z > 1.05 ? "hud-zoom on" : "hud-zoom")
      if (z > 1.05) zoomEl.setText(`${z.toFixed(1)}×`)
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
        centerMsg.setClass(`hud-center-msg${f.missileWarning && flying ? " is-warn" : ""}${f.freeLook && flying ? " is-free" : ""}`)
        const v = f.vehicle
        let low = false
        if (v) {
          const seatName = f.seat !== null ? VEHICLES[v.kind].seatNames[f.seat].toLowerCase() : ""
          seatEl.setText(`${VEHICLES[v.kind].name.toLowerCase()} · ${seatName}`)
          const hp = Math.max(0, v.hp / v.maxHp)
          low = hp < 0.3 && flying
          if (hp !== lastHpFrac) {
            hpBar.setTransform(`scaleX(${hp.toFixed(3)})`)
            hpGhost.setTransform(`scaleX(${hp.toFixed(3)})`)
            hpRow.setClass(`hp${hp < 0.3 ? " low" : hp < 0.6 ? " mid" : ""}${hp > lastHpFrac && lastHpFrac >= 0 ? " heal" : ""}`)
            lastHpFrac = hp
          }
          hpTxt.setText(String(Math.ceil(Math.max(0, v.hp))))
          flares.setText(f.seat === 0 ? `flares ${v.flareCount}` : "")
        }
        const nowMs = performance.now()
        for (let i = 0; i < 2; i++) {
          const wr = weaponRows[i]
          const wpn = f.weapons[i]
          if (!wpn) { wr.row.setClass("w off"); continue }
          if (wpn.keys) wr.key.setText(wpn.keys.toLowerCase())
          const spec = WEAPONS[wpn.id]
          const unlimited = wpn.cap < 0 || wpn.ammo < 0
          const empty = !unlimited && wpn.ammo <= 0
          // Magazine topped back up: brief glow.
          if (wr.wasRegen && !wpn.regen && !unlimited && wpn.ammo >= wpn.cap) wr.full = nowMs + 700
          wr.wasRegen = wpn.regen
          wr.row.setClass(`w${wpn.ready < 1 ? " reload" : ""}${wpn.locked ? " locked" : ""}${wpn.regen ? " regen" : ""}${empty ? " empty" : ""}${wr.full > nowMs ? " full" : ""}`)
          wr.name.setText(spec.name.toLowerCase())
          wr.ammo.setText(spec.kind === "pulse" ? (wpn.ready >= 1 ? "ready" : `${Math.round(wpn.ready * 100)}%`) : unlimited ? "∞" : empty ? "reload" : String(wpn.ammo))
          const frac = spec.kind === "pulse" ? wpn.ready : unlimited ? 1 : wpn.ammo / Math.max(1, wpn.cap)
          wr.bar.setTransform(`scaleX(${Math.max(0, Math.min(1, frac)).toFixed(3)})`)
        }
        const cls = `hud${shown ? " flying" : ""}${f.cockpit && flying ? " cockpit" : ""}${isDirect ? " direct" : ""}${flying && f.scanner ? " scanning" : ""}${low ? " low" : ""}${f.missileWarning && flying ? " warn" : ""}${f.aaFire && flying ? " aafire" : ""}`
        if (cls !== rootCls) {
          // Preserve externally toggled classes (scoreboard / chat).
          const keep = (root.classList.contains("board") ? " board" : "") + (root.classList.contains("chatting") ? " chatting" : "")
          rootCls = cls
          root.className = cls + keep
        }
        ping.setText(f.ping > 0 ? `${Math.round(f.ping)} ms` : "")
      }
      if (frame % 15 === 0) {
        let teams = ""
        for (let t = 0; t < f.teams; t++) teams += `${t ? '<i class="dash">—</i>' : ""}<span class="sc${t === myTeam ? " mine" : ""}" style="--c:${TEAM_TINTS[t]}">${String(f.scores[t] ?? 0).padStart(2, "0")}</span>`
        let timer = ""
        if (f.remaining !== null) {
          const r = Math.max(0, Math.ceil(f.remaining))
          timer = `<span class="timer${f.intermission ? " inter" : ""}${!f.intermission && r <= 60 ? " end" : ""}">${f.intermission ? "<em>next </em>" : ""}${String(Math.floor(r / 60)).padStart(2, "0")}:${String(r % 60).padStart(2, "0")}</span>`
        }
        const html = `<span class="teams">${teams}</span>${timer}`
        if (html !== scoreHtml) { scoreHtml = html; scoreEl.innerHTML = html }
      }
      const now = performance.now()
      if (flying && now - lastMap > 120) { lastMap = now; drawMap(f) }
      const showBoard = root.classList.contains("board")
      if (showBoard && now - lastBoard > 500) { lastBoard = now; drawBoard(f) }
    },

    killfeed(killer, killerTeam, victim, victimTeam, weapon, mine, bots) {
      const row = el("div", mine ? "mine" : "", feed)
      const kt = killerTeam ?? 0
      const bt = (b?: boolean) => (b ? `<em>bot</em>` : "")
      row.innerHTML = killer
        ? `<b style="color:${TEAM_TINTS[kt]}">${esc(killer.toLowerCase())}${bt(bots?.killer)}</b><span>${esc(weapon.toLowerCase())}</span><b style="color:${TEAM_TINTS[victimTeam]}">${esc(victim.toLowerCase())}${bt(bots?.victim)}</b>`
        : `<b style="color:${TEAM_TINTS[victimTeam]}">${esc(victim.toLowerCase())}${bt(bots?.victim)}</b><span>${esc(weapon.toLowerCase())}</span>`
      setTimeout(() => row.classList.add("out"), 6500)
      setTimeout(() => row.remove(), 7200)
      while (feed.childElementCount > 6) feed.firstElementChild!.remove()
    },

    spotted(by, byTeam, target, targetTeam, mine) {
      if (mine) { spotDoneAt = lastT; spotDoneName = target.toLowerCase() }
      const row = el("div", mine ? "mine spot" : "spot", feed)
      row.innerHTML = `${by ? `<b style="color:${TEAM_TINTS[byTeam ?? 0]}">${esc(mine ? "you" : by.toLowerCase())}</b>` : ""}<span>spotted</span><b style="color:${TEAM_TINTS[targetTeam]}">${esc(target.toLowerCase())}</b>`
      setTimeout(() => row.classList.add("out"), 5000)
      setTimeout(() => row.remove(), 5700)
      while (feed.childElementCount > 6) feed.firstElementChild!.remove()
    },

    chat(name, team, text) {
      const row = el("div", "", chatLog)
      row.innerHTML = `<b style="color:${team === null ? "#eceae4" : TEAM_TINTS[team]}">${esc(name.toLowerCase())}</b> ${esc(text)}`
      setTimeout(() => row.classList.add("out"), 12000)
      while (chatLog.childElementCount > 8) chatLog.firstElementChild!.remove()
    },

    banner(text, sub = "", ms = 2600) {
      banner.querySelector(".t")!.textContent = sentence(text)
      banner.querySelector(".s")!.textContent = sub.toLowerCase()
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

    deathCard(killer, killerTeam, weapon, distance) {
      const l1 = deathEl.querySelector(".l1")!, l2 = deathEl.querySelector(".l2")!
      if (killer) {
        const t = killerTeam ?? 0
        l1.innerHTML = `Shot down by <b style="color:${TEAM_TINTS[t]}">${esc(killer.toLowerCase())}</b>`
        l2.textContent = [weapon.toLowerCase(), distance !== null ? (distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} m`) : ""].filter(Boolean).join(" · ")
      } else {
        l1.textContent = "Crashed"
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
