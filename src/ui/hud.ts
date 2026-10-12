import { GADGETS, WEAPONS } from "../../shared/config"
import { floorOf } from "../../shared/maps"
import type { Snapshot } from "../../shared/sim/view"
import type { Camera } from "../render/camera"
import { type Game, TEAM, css } from "../game/game"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const clock = (s: number) => {
  const t = Math.max(0, Math.ceil(s))
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`
}

const NOISE: Record<string, string> = { silent: "SILENT", soft: "FOOTSTEPS", loud: "RUNNING", gun: "GUNFIRE" }

/** The in-round HUD, after concept/look-1-office.png. Thin, widely tracked white type over the scene. */
export class Hud {
  private el: Record<string, HTMLElement> = {}
  private labels = new Map<string, HTMLElement>()
  private mini: CanvasRenderingContext2D
  private miniBase: HTMLCanvasElement | null = null
  private miniSeed = -1

  constructor(private root: HTMLElement) {
    root.innerHTML = `
      <div id="tl"><div class="brand">BLACKOUT</div><canvas id="mini" width="240" height="170"></canvas><div id="floor"></div></div>
      <div id="tc"><span id="score"></span><span id="clock"></span></div>
      <div id="tr"></div>
      <div id="labels"></div>
      <div id="bl">
        <div class="vis"><span>VISIBILITY</span><div id="bars"><i></i><i></i><i></i><i></i><i></i></div></div>
        <div id="vislabel">HIDDEN</div>
        <div class="hp"><i id="pip"></i><span>1 HIT</span><span id="noise"></span></div>
      </div>
      <div id="br"><div class="wpn"><span id="wname"></span><b id="ammo"></b></div><div class="sep"></div><div id="gadgets"></div></div>
      <div id="center"></div>
      <div id="spect"></div>
      <div id="kc"></div>
      <div id="status"></div>
      <div id="help">WASD move · SHIFT run · C sneak · CLICK fire · R reload · Q/E gadgets · F doors · TAB scores</div>`
    for (const e of root.querySelectorAll<HTMLElement>("[id]")) this.el[e.id] = e
    this.mini = (this.el.mini as HTMLCanvasElement).getContext("2d")!
  }

  show(on: boolean): void {
    this.root.classList.toggle("on", on)
  }

  update(g: Game, cam: Camera, w: number, h: number, now: number, status: string | null): void {
    const s = g.snap
    const el = this.el
    el.status!.textContent = status ?? ""
    if (!s) return
    const t = now / 1000
    el.floor!.innerHTML = `OFFICE TOWER<br>FL ${floorOf(s.map)}`
    el.clock!.textContent = s.phase === "live" ? `ROUND ${s.roundNo} · ${clock(s.left)}` : s.phase === "loadout" ? `ROUND ${s.roundNo} · STARTS IN ${Math.ceil(s.left)}` : ""
    el.score!.innerHTML = this.score(s, g)
    el.tr!.innerHTML = g.feed
      .filter((f) => t - f.t < 8)
      .map((f) => `<div><b style="color:${css(f.kc)}">${esc(f.killer || "·")}</b><em>${esc(f.weapon)}</em><b style="color:${css(f.vc)}">${esc(f.victim)}</b></div>`)
      .join("")

    const you = s.you
    const alive = !!you?.alive && s.phase === "live"
    const exp = alive ? you!.exposure : 0
    const lit = Math.ceil(exp * 5)
    ;[...el.bars!.children].forEach((b, i) => b.classList.toggle("on", i < lit))
    el.bars!.classList.toggle("hot", exp >= 0.75)
    el.vislabel!.textContent = !alive ? "" : you!.lit ? "EXPOSED · IN LIGHT" : exp >= 0.75 ? "EXPOSED · NOISE" : exp > 0 ? "HIDDEN · AUDIBLE" : "HIDDEN"
    el.vislabel!.classList.toggle("hot", exp >= 0.75)
    el.noise!.textContent = alive ? NOISE[you!.noise] ?? "" : ""
    el.pip!.classList.toggle("dead", !!you && !you.alive && s.phase === "live")
    if (you) {
      const wpn = WEAPONS[you.weapon]
      el.wname!.textContent = wpn.label.toUpperCase()
      el.ammo!.textContent = you.reloadLeft > 0 ? "RELOADING" : `${you.mag} / ${you.reserve}`
      el.gadgets!.innerHTML = you.gadgets.map((gd, i) => `<div class="${gd.left ? "" : "empty"}"><span>${GADGETS[gd.kind].short}</span><b>×${gd.left}</b><kbd>${i ? "E" : "Q"}</kbd></div>`).join("")
    }

    const toast = g.toasts.filter((x) => t - x.t0 < (x.big ? 4 : 2.2)).at(-1)
    el.center!.textContent = toast?.text ?? ""
    el.center!.className = toast?.big ? "big" : ""
    el.spect!.textContent = s.phase === "live" && you && !you.alive ? (you.inRound ? "YOU ARE OUT · SPECTATING YOUR TEAM" : "SPECTATING · YOU JOIN NEXT ROUND") : ""
    const kc = g.killcam
    if (kc && t - kc.t0 < 5 && s.phase === "live") {
      el.kc!.innerHTML = `<div class="kt">KILLED BY ${esc(kc.killer.toUpperCase())}</div><div class="ks">${esc(kc.weapon)} · ${Math.round(kc.dist)} m · one hit</div>`
      el.kc!.classList.add("on")
    } else el.kc!.classList.remove("on")

    // Name labels over visible players.
    const keep = new Set<string>()
    for (const o of g.shown.values()) {
      const p = cam.project(o.sx, 2.05, o.sy, w, h)
      if (!p.ok) continue
      keep.add(o.id)
      this.label(o.id, g.nameOf(o.id), p.x, p.y, css(g.colorOf(o.id)))
    }
    if (alive && g.body) {
      const p = cam.project(g.body.x, 2.05, g.body.y, w, h)
      keep.add("me")
      this.label("me", g.nameOf(g.myId), p.x, p.y, "#fff")
    }
    for (const [id, e] of this.labels) if (!keep.has(id)) e.style.opacity = "0"
    this.minimap(g, t)
  }

  private score(s: Snapshot, g: Game): string {
    if (s.phase === "lobby") return ""
    if (s.mode === "ffa") {
      const top = Object.entries(s.wins).sort((a, b) => b[1] - a[1])[0]
      return top ? `<span>${esc(g.nameOf(top[0]).toUpperCase())} ${top[1]}</span>` : `<span>FREE FOR ALL</span>`
    }
    return `<span style="color:${css(TEAM[0])}">ORANGE ${s.wins["0"] ?? 0}</span><span class="dash">-</span><span style="color:${css(TEAM[1])}">CYAN ${s.wins["1"] ?? 0}</span>`
  }

  private label(id: string, name: string, x: number, y: number, color: string): void {
    let e = this.labels.get(id)
    if (!e) {
      e = document.createElement("div")
      e.className = "label"
      this.el.labels!.appendChild(e)
      this.labels.set(id, e)
    }
    e.textContent = name
    e.style.color = color
    e.style.opacity = "1"
    e.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`
  }

  private minimap(g: Game, t: number): void {
    const c = this.mini
    const W = 240
    const H = 170
    const m = g.map
    const sc = Math.min((W - 12) / m.size[0], (H - 12) / m.size[1])
    const ox = (W - m.size[0] * sc) / 2
    const oy = (H - m.size[1] * sc) / 2
    if (this.miniSeed !== m.seed || !this.miniBase) {
      const b = document.createElement("canvas")
      b.width = W
      b.height = H
      const bc = b.getContext("2d")!
      bc.fillStyle = "rgba(8,11,20,0.82)"
      bc.fillRect(0, 0, W, H)
      bc.fillStyle = "rgba(255,255,255,0.07)"
      for (const p of m.props) if (p.solid) bc.fillRect(ox + p.rect[0] * sc, oy + p.rect[1] * sc, (p.rect[2] - p.rect[0]) * sc, (p.rect[3] - p.rect[1]) * sc)
      bc.fillStyle = "rgba(220,226,240,0.55)"
      for (const w of m.walls) bc.fillRect(ox + w.rect[0] * sc, oy + w.rect[1] * sc, Math.max(1, (w.rect[2] - w.rect[0]) * sc), Math.max(1, (w.rect[3] - w.rect[1]) * sc))
      bc.fillStyle = "rgba(120,170,255,0.35)"
      for (const w of [...m.windows, ...m.glass.map((x) => x.rect)]) bc.fillRect(ox + w[0] * sc, oy + w[1] * sc, Math.max(1, (w[2] - w[0]) * sc), Math.max(1, (w[3] - w[1]) * sc))
      this.miniBase = b
      this.miniSeed = m.seed
    }
    c.clearRect(0, 0, W, H)
    c.drawImage(this.miniBase, 0, 0)
    const st = g.serverTime(t * 1000)
    for (const l of m.lights) {
      const s = g.level.lamps[l.id]!
      const on = !s.broken && !s.off && st >= s.dimUntil
      c.fillStyle = on ? css([l.color[0], l.color[1], l.color[2]]) : "rgba(120,120,130,0.35)"
      c.globalAlpha = on ? 0.85 : 1
      c.fillRect(ox + l.x * sc - 1.5, oy + l.y * sc - 1.5, 3, 3)
    }
    c.globalAlpha = 1
    for (const r of g.rings) {
      const a = (t - r.t0) / 1.6
      if (a < 0 || a > 1 || r.kind === "step" || r.kind === "crunch" || r.kind === "dry") continue
      c.strokeStyle = `rgba(255,255,255,${(1 - a) * 0.7})`
      c.beginPath()
      c.arc(ox + r.x * sc, oy + r.y * sc, Math.max(1.5, r.r * sc * (0.2 + 0.8 * a)), 0, Math.PI * 2)
      c.stroke()
    }
    for (const o of g.shown.values()) {
      c.fillStyle = css(g.colorOf(o.id))
      c.beginPath()
      c.arc(ox + o.sx * sc, oy + o.sy * sc, 3, 0, Math.PI * 2)
      c.fill()
    }
    if (g.alive && g.body) {
      const x = ox + g.body.x * sc
      const y = oy + g.body.y * sc
      const a = g.aim
      c.fillStyle = "#fff"
      c.beginPath()
      c.moveTo(x + Math.cos(a) * 7, y + Math.sin(a) * 7)
      c.lineTo(x + Math.cos(a + 2.5) * 5, y + Math.sin(a + 2.5) * 5)
      c.lineTo(x + Math.cos(a - 2.5) * 5, y + Math.sin(a - 2.5) * 5)
      c.fill()
    }
    c.strokeStyle = "rgba(255,255,255,0.5)"
    c.strokeRect(0.5, 0.5, W - 1, H - 1)
    c.fillStyle = "rgba(255,255,255,0.7)"
    c.font = "11px 'IBM Plex Mono', monospace"
    c.fillText("N", W - 16, 16)
  }
}
