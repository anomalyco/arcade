// DOM HUD. Positions are written with compositor-only transforms every frame; text is throttled
// and only written when it changes, so the HUD never forces layout.
import { Vector3, type PerspectiveCamera } from "three"
import type { PlayerInfo, TeamId, Vec3, VehicleEntity, WeaponId } from "../sim/types"
import { VEHICLES, WEAPONS } from "../sim/vehicles"
import { AIRBASES, WORLD_HALF, segmentHitsGround, terrainHeight } from "../sim/geography"

export const TEAM_COLORS = ["#2f6fd1", "#e0902a", "#2fae5a", "#d13f3f"]
export const TEAM_NAMES = ["Cobalt", "Amber", "Emerald", "Crimson"]

export interface HudWeapon { id: WeaponId; ammo: number; ready: number; lock: number; locked: boolean }

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
}

export interface Hud {
  root: HTMLElement
  update(f: HudFrame): void
  killfeed(killer: string | null, killerTeam: TeamId | null, victim: string, victimTeam: TeamId, weapon: string, mine: boolean): void
  chat(name: string, team: TeamId | null, text: string): void
  banner(text: string, sub?: string, ms?: number): void
  hitmarker(kill?: boolean): void
  damage(): void
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

interface Marker { root: HTMLElement; label: Slot; dist: Slot; slot: Slot; tf: Slot; color: string; used: boolean }

export function createHud(parent: HTMLElement): Hud {
  const root = el("div", "hud", parent)
  root.innerHTML = `
    <div class="hud-dmg"></div>
    <div class="hud-markers"></div>
    <div class="hud-lead"></div>
    <div class="hud-lock"><i></i><b>LOCK</b></div>
    <div class="hud-bore"></div>
    <div class="hud-aim"><div class="hud-hit"></div></div>
    <div class="hud-top">
      <div class="hud-compass"><div class="strip"></div><i class="caret"></i></div>
      <div class="hud-score"><span class="teams"></span><span class="timer"></span></div>
    </div>
    <div class="hud-center-msg"><div class="protected">PROTECTED</div><div class="warn">MISSILE</div><div class="freelook">FREE LOOK</div></div>
    <div class="hud-banner"><div class="t"></div><div class="s"></div></div>
    <div class="hud-tape left"><div class="lbl">SPD</div><div class="val">0</div><div class="unit">KM/H</div><div class="thr"><i></i></div><div class="boost">BOOST</div></div>
    <div class="hud-tape right"><div class="lbl">ALT</div><div class="val">0</div><div class="unit">M</div></div>
    <div class="hud-bottom">
      <div class="seat"></div>
      <div class="hp"><i></i><span></span></div>
      <div class="weapons"></div>
      <div class="flares"></div>
    </div>
    <div class="hud-feed"></div>
    <div class="hud-chat"><div class="log"></div><input maxlength="140" placeholder="Say something… (Enter to send, Esc to cancel)" /></div>
    <canvas class="hud-map" width="180" height="180"></canvas>
    <div class="hud-board"></div>
    <div class="hud-ping"></div>`
  const q = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector(s) as T
  const markerHost = q(".hud-markers")
  const aim = new Slot(q(".hud-aim"))
  const bore = new Slot(q(".hud-bore"))
  const lead = new Slot(q(".hud-lead"))
  const lockBox = new Slot(q(".hud-lock"))
  const lockLbl = new Slot(q(".hud-lock b"))
  const hitEl = q(".hud-hit")
  const dmgEl = q(".hud-dmg")
  const strip = q(".hud-compass .strip")
  const stripTf = new Slot(strip)
  const teamsEl = q(".hud-score .teams")
  const timer = new Slot(q(".hud-score .timer"))
  const centerMsg = new Slot(q(".hud-center-msg"))
  const banner = q(".hud-banner")
  const spd = new Slot(q(".hud-tape.left .val"))
  const thr = new Slot(q(".hud-tape.left .thr i"))
  const boostEl = new Slot(q(".hud-tape.left .boost"))
  const alt = new Slot(q(".hud-tape.right .val"))
  const seatEl = new Slot(q(".hud-bottom .seat"))
  const hpBar = new Slot(q(".hud-bottom .hp i"))
  const hpTxt = new Slot(q(".hud-bottom .hp span"))
  const weaponsEl = q(".hud-bottom .weapons")
  const flares = new Slot(q(".hud-bottom .flares"))
  const feed = q(".hud-feed")
  const chatLog = q(".hud-chat .log")
  const chatInput = q<HTMLInputElement>(".hud-chat input")
  const map = q<HTMLCanvasElement>(".hud-map")
  const mapCtx = map.getContext("2d")!
  const board = q(".hud-board")
  const ping = new Slot(q(".hud-ping"))

  // Compass strip: 3 turns of labels so wrap-around is seamless.
  const PX_PER_DEG = 4
  let stripHtml = ""
  for (let d = -360; d <= 720; d += 15) {
    const n = ((d % 360) + 360) % 360
    const label = n === 0 ? "N" : n === 90 ? "E" : n === 180 ? "S" : n === 270 ? "W" : n % 45 === 0 ? String(n) : "·"
    stripHtml += `<span style="left:${(d + 360) * PX_PER_DEG}px" class="${n % 90 === 0 ? "card" : ""}">${label}</span>`
  }
  strip.innerHTML = stripHtml

  const markers: Marker[] = []
  for (let i = 0; i < MARKERS; i++) {
    const m = el("div", "mk", markerHost, `<i class="br"></i><span class="lb"></span><span class="ds"></span>`)
    markers.push({ root: m, label: new Slot(m.querySelector(".lb")!), dist: new Slot(m.querySelector(".ds")!), slot: new Slot(m), tf: new Slot(m), color: "", used: false })
  }

  const weaponRows: { name: Slot; ammo: Slot; bar: Slot; row: Slot }[] = []
  for (let i = 0; i < 2; i++) {
    const r = el("div", "w", weaponsEl, `<span class="k">${i === 0 ? "LMB" : "RMB"}</span><span class="n"></span><span class="a"></span><i></i>`)
    weaponRows.push({ name: new Slot(r.querySelector(".n")!), ammo: new Slot(r.querySelector(".a")!), bar: new Slot(r.querySelector("i")!), row: new Slot(r) })
  }

  const occlusion = new Map<string, { visible: boolean; at: number }>()
  let frame = 0
  let lastMap = 0
  let lastBoard = 0
  let w = window.innerWidth, h = window.innerHeight
  const onResize = () => { w = window.innerWidth; h = window.innerHeight }
  window.addEventListener("resize", onResize)

  const project = (p: Vec3, cam: PerspectiveCamera): boolean => {
    _v.set(p[0], p[1], p[2]).project(cam)
    return _v.z < 1 && _v.z > -1
  }
  const sx = () => (_v.x * 0.5 + 0.5) * w
  const sy = () => (-_v.y * 0.5 + 0.5) * h
  const tf = (x: number, y: number) => `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`
  const HIDDEN = "translate3d(-9999px,0,0)"

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

  // Terrain backdrop for the minimap, sampled once (≈14k height queries) off the critical path.
  let mapBg: HTMLCanvasElement | null = null
  const buildMapBg = () => {
    const N = 120
    const c = document.createElement("canvas")
    c.width = c.height = N
    const g = c.getContext("2d")!
    const img = g.createImageData(N, N)
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N - 0.5) * WORLD_HALF * 2, z = ((j + 0.5) / N - 0.5) * WORLD_HALF * 2
      const h = terrainHeight(x, z)
      const o = (j * N + i) * 4
      if (h <= 0) { const d = Math.max(0, Math.min(1, -h / 60)); img.data[o] = 10; img.data[o + 1] = 22 + 14 * (1 - d); img.data[o + 2] = 40 + 24 * (1 - d); img.data[o + 3] = 200 }
      else { const e = Math.min(1, h / 900); img.data[o] = 40 + 90 * e; img.data[o + 1] = 70 + 60 * e; img.data[o + 2] = 46 + 80 * e; img.data[o + 3] = 230 }
    }
    g.putImageData(img, 0, 0)
    mapBg = c
  }
  const idle = (window as unknown as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 200))
  idle(buildMapBg)

  function drawMap(f: HudFrame) {
    const S = map.width
    const k = S / (WORLD_HALF * 2)
    const ctx = mapCtx
    ctx.clearRect(0, 0, S, S)
    ctx.fillStyle = "rgba(6,8,16,.72)"
    ctx.fillRect(0, 0, S, S)
    if (mapBg) { ctx.imageSmoothingEnabled = true; ctx.drawImage(mapBg, 0, 0, S, S) }
    ctx.strokeStyle = "rgba(190,205,255,.08)"
    ctx.lineWidth = 1
    for (let i = 1; i < 6; i++) {
      ctx.beginPath(); ctx.moveTo((i * S) / 6, 0); ctx.lineTo((i * S) / 6, S); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, (i * S) / 6); ctx.lineTo(S, (i * S) / 6); ctx.stroke()
    }
    for (let t = 0; t < f.teams; t++) {
      const b = AIRBASES[t]
      ctx.strokeStyle = TEAM_COLORS[t]
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.arc((b.center[0] + WORLD_HALF) * k, (b.center[2] + WORLD_HALF) * k, Math.max(4, b.safeRadius * k), 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    const myTeam = f.me?.team ?? -1
    for (const v of f.vehicles) {
      if (!v.alive) continue
      const own = f.vehicle && v.id === f.vehicle.id
      const spotted = v.spottedUntil > f.time
      if (v.team !== myTeam && !spotted) continue
      const x = (v.flight.position[0] + WORLD_HALF) * k, y = (v.flight.position[2] + WORLD_HALF) * k
      if (own) continue
      ctx.fillStyle = TEAM_COLORS[v.team]
      ctx.beginPath()
      ctx.arc(x, y, v.team === myTeam ? 2.5 : 3.2, 0, Math.PI * 2)
      ctx.fill()
      if (spotted && v.team !== myTeam) { ctx.strokeStyle = "#fff"; ctx.stroke() }
    }
    if (f.vehicle) {
      const p = f.vehicle.flight.position
      const x = (p[0] + WORLD_HALF) * k, y = (p[2] + WORLD_HALF) * k
      const a = (f.heading * Math.PI) / 180
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(a)
      ctx.fillStyle = "#fff"
      ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(4, 4); ctx.lineTo(0, 2); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill()
      ctx.restore()
    }
  }

  function drawBoard(f: HudFrame) {
    const teams: PlayerInfo[][] = Array.from({ length: f.teams }, () => [])
    for (const p of f.players.values()) if (p.team < f.teams) teams[p.team].push(p)
    board.innerHTML = teams.map((list, t) => {
      list.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
      return `<div class="team" style="--c:${TEAM_COLORS[t]}"><h3><span>${TEAM_NAMES[t]}</span><b>${f.scores[t] ?? 0}</b></h3>
        <table><tr><th>Pilot</th><th>K</th><th>D</th></tr>${list.map(p =>
          `<tr class="${p.id === f.myId ? "me" : ""}"><td>${esc(p.name)}${p.bot ? ' <em>BOT</em>' : ""}</td><td>${p.kills}</td><td>${p.deaths}</td></tr>`).join("")}</table></div>`
    }).join("")
  }

  return {
    root,
    update(f) {
      frame++
      const cam = f.camera
      _cam.copy(cam.position)
      const flying = !!f.vehicle && f.vehicle.alive
      // Aim reticle + boresight
      if (flying && f.aimPoint && project(f.aimPoint, cam)) aim.setTransform(tf(sx(), sy())); else aim.setTransform(HIDDEN)
      if (flying && f.borePoint && project(f.borePoint, cam)) bore.setTransform(tf(sx(), sy())); else bore.setTransform(HIDDEN)
      if (flying && f.lead && project(f.lead, cam)) lead.setTransform(tf(sx(), sy())); else lead.setTransform(HIDDEN)
      if (flying && f.lockTarget && f.lockProgress > 0 && project(f.lockTarget, cam)) {
        lockBox.setTransform(tf(sx(), sy()) + ` scale(${(1.8 - f.lockProgress * 0.8).toFixed(2)})`)
        lockBox.setClass(f.lockProgress >= 1 ? "hud-lock locked" : "hud-lock")
        lockLbl.setText(f.lockProgress >= 1 ? "LOCKED" : "LOCK")
      } else lockBox.setTransform(HIDDEN)

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
        const color = TEAM_COLORS[v.team]
        if (m.color !== color) { m.color = color; m.root.style.setProperty("--c", color) }
        m.slot.setClass(`mk ${friend ? "friend" : "enemy"}${spotted ? " spotted" : ""}`)
        const s = friend ? 1 : Math.max(0.55, Math.min(1.6, 260 / Math.max(1, dist) * 4))
        m.tf.setTransform(tf(sx(), sy()) + ` scale(${s.toFixed(2)})`)
        if ((frame + mi) % 8 === 0 || m.label.el.textContent === "") {
          const pilot = v.seats[0] ? f.players.get(v.seats[0]) : null
          m.label.setText(friend || dist < 1800 || spotted ? `${pilot?.name ?? VEHICLES[v.kind].name}` : "")
          m.dist.setText(dist >= 1000 ? `${(dist / 1000).toFixed(1)}km` : `${Math.round(dist)}m`)
        }
      }
      for (let i = mi; i < MARKERS; i++) if (markers[i].used) { markers[i].used = false; markers[i].tf.setTransform(HIDDEN) }

      // Throttled text
      if (frame % 4 === 0) {
        stripTf.setTransform(`translate3d(${(-(f.heading + 360) * PX_PER_DEG).toFixed(1)}px,0,0)`)
        spd.setText(String(Math.round(f.speed * 3.6)))
        alt.setText(String(Math.round(f.altitude)))
        thr.setTransform(`scaleY(${Math.max(0, Math.min(1, f.throttle)).toFixed(2)})`)
        boostEl.setClass(f.boost ? "boost on" : "boost")
        centerMsg.setClass(`hud-center-msg${f.protected && flying ? " is-protected" : ""}${f.missileWarning && flying ? " is-warn" : ""}${f.freeLook && flying ? " is-free" : ""}`)
        const v = f.vehicle
        if (v) {
          const seatName = f.seat !== null ? VEHICLES[v.kind].seatNames[f.seat].toUpperCase() : ""
          seatEl.setText(`${VEHICLES[v.kind].name.toUpperCase()} · ${seatName}`)
          const hp = Math.max(0, v.hp / v.maxHp)
          hpBar.setTransform(`scaleX(${hp.toFixed(3)})`)
          hpBar.setClass(hp < 0.3 ? "low" : "")
          hpTxt.setText(`${Math.ceil(Math.max(0, v.hp))} / ${v.maxHp}`)
          flares.setText(f.seat === 0 ? `FLARES ${v.flareCount}` : "")
        }
        for (let i = 0; i < 2; i++) {
          const wr = weaponRows[i]
          const wpn = f.weapons[i]
          if (!wpn || (i === 1 && f.weapons[0] && f.weapons[0].id === wpn.id && WEAPONS[wpn.id].kind === "pulse")) { wr.row.setClass("w off"); continue }
          const spec = WEAPONS[wpn.id]
          wr.row.setClass(`w${wpn.ready < 1 ? " reload" : ""}${wpn.locked ? " locked" : ""}`)
          wr.name.setText(spec.name.toUpperCase())
          wr.ammo.setText(spec.kind === "pulse" ? (wpn.ready >= 1 ? "READY" : "CHARGING") : wpn.ammo < 0 || !Number.isFinite(wpn.ammo) ? "∞" : String(wpn.ammo))
          wr.bar.setTransform(`scaleX(${Math.max(0, Math.min(1, spec.kind.startsWith("missile") && wpn.lock > 0 ? wpn.lock : wpn.ready)).toFixed(2)})`)
        }
        if (f.remaining !== null) {
          const r = Math.max(0, Math.ceil(f.remaining))
          timer.setText(`${f.intermission ? "NEXT MATCH " : ""}${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`)
        } else timer.setText("")
        ping.setText(f.ping > 0 ? `${Math.round(f.ping)} ms` : "")
      }
      if (frame % 15 === 0) {
        let html = ""
        for (let t = 0; t < f.teams; t++) html += `<span style="--c:${TEAM_COLORS[t]}" class="${t === myTeam ? "mine" : ""}">${f.scores[t] ?? 0}</span>`
        if (teamsEl.innerHTML !== html) teamsEl.innerHTML = html
      }
      const now = performance.now()
      if (now - lastMap > 120) { lastMap = now; drawMap(f) }
      const showBoard = root.classList.contains("board")
      if (showBoard && now - lastBoard > 500) { lastBoard = now; drawBoard(f) }
    },

    killfeed(killer, killerTeam, victim, victimTeam, weapon, mine) {
      const row = el("div", mine ? "mine" : "", feed)
      row.innerHTML = killer
        ? `<b style="color:${TEAM_COLORS[killerTeam ?? 0]}">${esc(killer)}</b><span>${esc(weapon)}</span><b style="color:${TEAM_COLORS[victimTeam]}">${esc(victim)}</b>`
        : `<b style="color:${TEAM_COLORS[victimTeam]}">${esc(victim)}</b><span>${esc(weapon)}</span>`
      setTimeout(() => row.classList.add("out"), 6500)
      setTimeout(() => row.remove(), 7200)
      while (feed.childElementCount > 6) feed.firstElementChild!.remove()
    },

    chat(name, team, text) {
      const row = el("div", "", chatLog)
      row.innerHTML = `<b style="color:${team === null ? "#aab" : TEAM_COLORS[team]}">${esc(name)}</b> ${esc(text)}`
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

    damage() {
      dmgEl.classList.remove("on")
      void dmgEl.offsetWidth
      dmgEl.classList.add("on")
    },

    setVisible(flying) {
      root.classList.toggle("flying", flying)
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
