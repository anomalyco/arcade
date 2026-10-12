import { GADGETS, WEAPONS, type Gadget } from "../../shared/config"
import type { Snapshot, OtherView } from "../../shared/sim/view"
import type { GameState } from "../game/state"
import { TEAM_COLOR } from "../game/draw"

const NOISE_LABEL: Record<string, string> = {
  silent: "SILENT (SNEAKING)",
  soft: "SOFT (WALKING)",
  loud: "LOUD (RUNNING)",
  gun: "GUNFIRE",
}

const fmt = (s: number) => {
  const t = Math.max(0, Math.ceil(s))
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`
}

export type Actor = { id: string; name: string; x: number; y: number; color: [number, number, number] }

/** Everything on screen during play: clock and score, kill feed, the visibility meter, ammo and gadgets, the minimap. */
export class Hud {
  private q: Record<string, HTMLElement> = {}
  private labels = new Map<string, HTMLElement>()
  private minimapCtx: CanvasRenderingContext2D
  private staticMap: HTMLCanvasElement | null = null
  private mapKey = ""

  constructor(private root: HTMLElement) {
    root.innerHTML = `
      <canvas id="minimap" width="236" height="236"></canvas>
      <div id="top">
        <div id="clock">00:00</div>
        <div id="score"></div>
        <div id="phase"></div>
      </div>
      <div id="feed"></div>
      <div id="labels"></div>
      <div id="bl" class="status">
        <div id="hits"><span class="heart" aria-hidden="true"></span><span id="hits-text">1 HIT</span></div>
        <div id="vis">
          <span id="eye" aria-hidden="true"></span>
          <div id="bars"><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <span id="vis-label">HIDDEN</span>
        </div>
        <div id="noise"></div>
      </div>
      <div id="br" class="status">
        <div id="weapon"></div>
        <div id="ammo"><span id="mag">0</span><span id="res">/ 0</span></div>
        <div id="timer-bar"><i></i></div>
        <div id="gadgets">
          <div class="gadget" id="g0"><span class="gn"></span><b></b><kbd>Q</kbd></div>
          <div class="gadget" id="g1"><span class="gn"></span><b></b><kbd>E</kbd></div>
        </div>
      </div>
      <div id="toast"></div>
      <div id="notice"></div>
      <div id="out"></div>
      <div id="killcam"></div>
    `
    for (const el of root.querySelectorAll<HTMLElement>("[id]")) this.q[el.id] = el
    this.minimapCtx = (this.q.minimap as HTMLCanvasElement).getContext("2d")!
  }

  setLabel(id: string, name: string, x: number, y: number, show: boolean, self: boolean, color: [number, number, number]): void {
    let el = this.labels.get(id)
    if (!el) {
      el = document.createElement("div")
      el.className = "label"
      this.q.labels!.appendChild(el)
      this.labels.set(id, el)
    }
    el.textContent = self ? `${name} · you` : name
    el.style.color = `rgb(${color.map((c) => Math.round(c * 255)).join(",")})`
    el.style.opacity = show ? "1" : "0"
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translateX(-50%)`
  }

  clearLabels(keep: Set<string>): void {
    for (const [id, el] of this.labels) {
      if (keep.has(id)) continue
      el.remove()
      this.labels.delete(id)
    }
  }

  update(g: GameState, snap: Snapshot | null, now: number, myId: string, spectating: boolean): void {
    const q = this.q
    if (!snap) return
    q.clock.textContent = fmt(snap.left)
    q.phase.textContent = phaseLabel(snap)
    q.score.innerHTML = scoreLine(snap, g)
    q.timer.toggleAttribute("hidden", snap.phase !== "live")
    const bar = q["timer-bar"]!.firstElementChild as HTMLElement
    bar.style.width = `${Math.max(0, Math.min(100, (snap.left / 180) * 100))}%`

    q.feed.innerHTML = g.feed
      .map((f) => {
        const color = f.me ? "var(--ink)" : "var(--dim)"
        const w = f.weapon === "mine" ? "mine" : f.weapon === "lamp" ? "lamp" : WEAPONS[f.weapon as keyof typeof WEAPONS]?.label.toLowerCase() ?? f.weapon
        return `<div class="feed-line" style="color:${color}"><b>${esc(f.killer || "·")}</b> <span>×</span> <b>${esc(f.victim)}</b> <em>${esc(w)} · ${f.dist.toFixed(0)}m</em></div>`
      })
      .join("")

    const you = snap.you
    const exposure = you ? you.exposure : 0
    const bars = q.bars!.children
    const lit = Math.ceil(exposure * 6)
    for (let i = 0; i < bars.length; i++) (bars[i] as HTMLElement).classList.toggle("on", i < lit)
    const label = !you || !you.alive ? "" : exposure >= 0.95 ? "EXPOSED · IN LIGHT" : exposure >= 0.65 ? "EXPOSED · MOVING" : exposure >= 0.55 ? "EXPOSED · FIRED" : exposure > 0 ? "SOFT · AUDIBLE" : "HIDDEN"
    q["vis-label"]!.textContent = label
    q.eye!.classList.toggle("warn", exposure > 0.5)
    q["hits-text"]!.textContent = "1 HIT"
    q["hits-text"]!.parentElement!.classList.toggle("dead", !!you && !you.alive)
    q.noise!.textContent = you ? `NOISE: ${NOISE_LABEL[you.noise] ?? ""}` : ""
    q["vis"]!.classList.toggle("off", !you?.alive)

    if (you) {
      const w = WEAPONS[you.weapon]
      q.weapon!.textContent = w.label.toUpperCase()
      q.mag!.textContent = String(you.mag)
      q.res!.textContent = you.weapon === "crossbow" ? "BOLT" : `/ ${you.reserve}`
      if (you.reloadLeft > 0) q.res!.textContent = `RELOADING ${you.reloadLeft.toFixed(1)}`
      else if (you.windupLeft > 0) q.res!.textContent = `WINDING ${you.windupLeft.toFixed(2)}`
      ;[0, 1].forEach((i) => {
        const el = q[`g${i}`]!
        const gd = you.gadgets[i]!
        ;(el.querySelector(".gn") as HTMLElement).textContent = GADGETS[gd.kind as Gadget].label.replace("Light-breaker ", "").replace("Motion ", "").replace("Noise ", "")
        ;(el.querySelector("b") as HTMLElement).textContent = `×${gd.left}`
        el.classList.toggle("empty", gd.left <= 0)
      })
    }

    q.toast.innerHTML = ""
    const t = g.toasts.at(-1)
    if (t && now < t.until) {
      q.toast.className = t.tone === "big" ? "big" : ""
      q.toast.textContent = t.text
    } else q.toast.textContent = ""

    if (spectating && snap.phase === "live") {
      q.out.textContent = "YOU ARE OUT · SPECTATING"
      q.out.classList.add("show")
    } else if (snap.phase === "loadout" && you && !you.alive) {
      q.out.textContent = `SPECTATING · NEXT ROUND IN ${Math.ceil(snap.left)}`
      q.out.classList.add("show")
    } else q.out.classList.remove("show")
    void myId
  }

  /** Renders the killcam panel. */
  killcam(g: GameState, snap: Snapshot | null, now: number): void {
    const k = g.killcam
    const el = this.q.killcam!
    if (!k) {
      el.classList.remove("show")
      return
    }
    el.classList.add("show")
    const who = g.names.get(k.killer) ?? "someone"
    const left = Math.max(0, Math.ceil(k.until - now))
    const phase = snap?.phase === "loadout" ? `NEXT ROUND IN ${Math.ceil(snap.left)}` : "SPECTATING"
    el.innerHTML = `<div class="kc-title">KILLED BY ${esc(who.toUpperCase())}</div><div class="kc-sub">one shot · ${esc(k.weapon)} · ${k.dist.toFixed(0)} m</div><div class="kc-next">${phase}${left > 0 ? "" : ""}</div>`
  }

  /** The minimap: lamps, walls, rings in the last second, visible players, and your heading. */
  minimap(g: GameState, snap: Snapshot | null, now: number, me: { x: number; y: number; aim: number } | null, others: OtherView[]): void {
    const c = this.minimapCtx
    const W = 236
    const map = g.map
    const scale = (W - 12) / Math.max(map.size[0], map.size[1])
    const ox = (W - map.size[0] * scale) / 2
    const oy = (W - map.size[1] * scale) / 2
    const key = map.id
    if (!this.staticMap || this.mapKey !== key) {
      const off = document.createElement("canvas")
      off.width = W
      off.height = W
      const oc = off.getContext("2d")!
      oc.fillStyle = "rgba(10,10,12,0.82)"
      oc.fillRect(0, 0, W, W)
      oc.fillStyle = "rgba(210,212,220,0.85)"
      for (const r of map.walls) oc.fillRect(ox + r[0] * scale, oy + r[1] * scale, (r[2] - r[0]) * scale, (r[3] - r[1]) * scale)
      oc.fillStyle = "rgba(160,120,80,0.8)"
      for (const d of map.doors) oc.fillRect(ox + d.rect[0] * scale, oy + d.rect[1] * scale, (d.rect[2] - d.rect[0]) * scale, (d.rect[3] - d.rect[1]) * scale)
      this.staticMap = off
      this.mapKey = key
    }
    c.clearRect(0, 0, W, W)
    c.drawImage(this.staticMap, 0, 0)
    c.strokeStyle = "rgba(255,255,255,0.18)"
    c.strokeRect(0.5, 0.5, W - 1, W - 1)
    if (snap) {
      for (const l of snap.lights) {
        if (l.kind !== "lamp") continue
        c.fillStyle = l.broken || l.power <= 0.02 ? "rgba(120,120,128,0.45)" : "rgba(255,250,235,0.95)"
        c.beginPath()
        c.arc(ox + l.x * scale, oy + l.y * scale, 2.2, 0, Math.PI * 2)
        c.fill()
      }
    }
    for (const r of g.ripples) {
      const age = (now - r.t0) / 1.4
      if (age < 0 || age > 1) continue
      c.strokeStyle = `rgba(255,255,255,${(1 - age) * 0.7})`
      c.lineWidth = 1
      c.beginPath()
      c.arc(ox + r.x * scale, oy + r.y * scale, Math.max(1, r.r * (0.2 + 0.8 * age)) * scale, 0, Math.PI * 2)
      c.stroke()
    }
    for (const o of others) {
      const t = g.teamOf.get(o.id)
      const col = o.key && snap?.mode === "tdm" ? TEAM_COLOR[o.team] ?? TEAM_COLOR[0]! : [0.95, 0.95, 0.95]
      c.fillStyle = `rgb(${col.map((v) => Math.round(v * 255)).join(",")})`
      c.beginPath()
      c.arc(ox + o.x * scale, oy + o.y * scale, 3, 0, Math.PI * 2)
      c.fill()
      void t
    }
    if (me) {
      c.fillStyle = "rgb(235,80,70)"
      c.beginPath()
      c.moveTo(ox + me.x * scale + Math.cos(me.aim) * 6, oy + me.y * scale + Math.sin(me.aim) * 6)
      c.lineTo(ox + me.x * scale + Math.cos(me.aim + 2.5) * 4.5, oy + me.y * scale + Math.sin(me.aim + 2.5) * 4.5)
      c.lineTo(ox + me.x * scale + Math.cos(me.aim - 2.5) * 4.5, oy + me.y * scale + Math.sin(me.aim - 2.5) * 4.5)
      c.closePath()
      c.fill()
    }
  }
}

export function phaseLabel(snap: Snapshot): string {
  switch (snap.phase) {
    case "lobby":
      return "LOBBY"
    case "loadout":
      return `ROUND ${snap.roundNo} · LOADOUT`
    case "live":
      return `ROUND ${snap.roundNo} · ${snap.mode === "ffa" ? "FREE FOR ALL" : "TEAM DEATHMATCH"}`
    case "over":
      return `ROUND ${snap.roundNo} · OVER`
    case "match":
      return "MATCH COMPLETE"
  }
}

function scoreLine(snap: Snapshot, g: GameState): string {
  if (snap.mode === "ffa") {
    const top = Object.entries(snap.wins)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, w]) => `<span>${esc(g.names.get(id) ?? "?")} ${w}</span>`)
    return top.length ? top.join(" · ") : `<span>first to ${Math.floor(snap.rounds / 2) + 1}</span>`
  }
  const red = snap.wins["0"] ?? 0
  const blue = snap.wins["1"] ?? 0
  return `<span class="red">RED ${red}</span> – <span class="blue">BLUE ${blue}</span>`
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
