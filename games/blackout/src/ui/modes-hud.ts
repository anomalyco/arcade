import "./modes.css"
import { keyLabel } from "@arcade/kit/client/controls"
import { MODES, type ModeView, SND, TEAM_NAMES } from "../../shared/sim/modes"
import type { Snapshot } from "../../shared/sim/view"
import type { Camera } from "../render/camera"
import { type Game, css } from "../game/game"
import { TEAM_COLORS, canUse, teamOf } from "../game/mode-fx"
import { HP, carries } from "../../shared/sim/modes-objective"
import { rulesObjective, rulesOut, rulesTop } from "./rules-hud"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const tc = (t: number) => (t >= 0 ? css(TEAM_COLORS[t]!) : "var(--dim)")
const clock = (s: number) => {
  const t = Math.max(0, Math.ceil(s))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`
}
const WHY: Record<string, string> = { eliminated: "TEAM ELIMINATED", detonated: "BOMB DETONATED", defused: "BOMB DEFUSED", time: "TIME RAN OUT" }

/** What the mode asks of you, for the intro banner. */
function objective(m: ModeView, team: number): string {
  if (m.id === "ffa") return "most kills wins"
  if (m.id === "tdm") return `first team to ${m.target} kills`
  if (m.id === "dom") return "hold A, B and C"
  if (m.id === "kc") return `grab enemy tags · first to ${m.target} confirms`
  if (m.id === "hp") return `hold the hardpoint · first to ${m.target}`
  if (m.id === "ctf") return `bring their flag home · first to ${m.target} captures`
  if (!m.round) return MODES[m.id].blurb
  return m.round && team === m.round.attack ? "attack · plant the bomb at A or B" : "defend · guard A and B"
}

/**
 * The mode's HUD: team scores under the clock, domination points, the search-and-destroy round, alive counts and bomb,
 * a progress bar for capturing, planting and defusing, floor labels for objectives, the mode intro and round banners,
 * and who you're watching while dead.
 */
export class ModeHud {
  private el: Record<string, HTMLElement> = {}
  private labels = new Map<string, HTMLElement>()
  private intro: { key: string; t: number; title: string; text: string } = { key: "", t: -10, title: "", text: "" }
  private roundKey = ""
  private round: { t: number; title: string; text: string; color: string } | null = null
  private watching = ""

  constructor(parent: HTMLElement) {
    const root = document.createElement("div")
    root.id = "modehud"
    root.innerHTML = `<div id="mtop"></div><div id="mbar"><div id="mbt"></div><div class="track"><i></i></div></div><div id="mhint"></div><div id="mintro"><b></b><span></span></div><div id="mspec"></div><div id="mlabels"></div>`
    parent.appendChild(root)
    for (const e of root.querySelectorAll<HTMLElement>("[id]")) this.el[e.id] = e
  }

  /** Dead in search and destroy: the living teammate the camera follows (sticking with one until they die). */
  spectate(g: Game): { x: number; y: number } | null {
    const s = g.snap
    if (!s || s.phase !== "play" || (s.mode.id !== "snd" && s.mode.id !== "oitc") || g.alive || s.you?.respawnIn !== -1) return null
    const team = teamOf(s, g.roster, g.myId)
    const alive = [...g.avatars.values()].filter((a) => a.alive)
    const mates = alive.filter((a) => teamOf(s, g.roster, a.id) === team)
    const pick = mates.find((a) => a.id === this.watching) ?? mates[0] ?? alive.find((a) => a.id === this.watching) ?? alive[0]
    this.watching = pick?.id ?? ""
    return pick ? { x: pick.x, y: pick.y } : null
  }

  update(g: Game, cam: Camera, w: number, h: number): void {
    const s = g.snap
    const el = this.el
    const t = performance.now() / 1000
    if (!s) return
    const m = s.mode
    const info = MODES[m.id]
    const team = teamOf(s, g.roster, g.myId)
    el.mtop!.innerHTML = s.phase === "play" ? (rulesTop(g) ?? this.top(s, g, team)) : ""

    // Intro on every new match, and banners at the start and end of each round.
    const key = `${m.id}|${s.map}|${s.match ?? 0}`
    if (s.phase === "play" && key !== this.intro.key) this.intro = { key, t, title: info.label.toUpperCase(), text: rulesObjective(s, team) ?? objective(m, team) }
    if (m.round && s.phase === "play") {
      const rk = `${s.map}|${m.round.n}|${m.round.post}`
      if (rk !== this.roundKey) {
        this.roundKey = rk
        if (m.round.post && m.round.won >= 0) this.round = { t, title: `${TEAM_NAMES[m.round.won]} WINS THE ROUND`, text: WHY[m.round.why] ?? "", color: tc(m.round.won) }
        else if (!m.round.post && m.round.n > 1) this.round = { t, title: `ROUND ${m.round.n}${m.round.n === SND.wins ? " · SIDES SWITCHED" : ""}`, text: objective(m, team), color: "var(--ink)" }
      }
    }
    const introAge = t - this.intro.t
    const banner =
      introAge < 4.5 ? { ...this.intro, age: introAge, life: 4.5, color: "var(--ink)" } : this.round && t - this.round.t < 3.5 ? { ...this.round, age: t - this.round.t, life: 3.5 } : null
    el.mintro!.style.opacity = banner ? String(Math.max(0, Math.min(1, banner.age * 4, (banner.life - banner.age) * 2))) : "0"
    if (banner) {
      const b = el.mintro!.firstElementChild as HTMLElement
      b.textContent = banner.title
      b.style.color = banner.color
      ;(el.mintro!.lastElementChild as HTMLElement).textContent = banner.text
    }

    // Progress: your capture, or your plant or defuse.
    const me = g.body ? g.drawn : null
    let bar: { text: string; p: number; color: string } | null = null
    const b = m.bomb
    if (b && b.actor === g.myId && b.progress > 0) bar = { text: b.state === "planted" ? "DEFUSING" : "PLANTING", p: b.progress, color: tc(team) }
    if (!bar && me && g.alive)
      for (const p of m.points)
        if (Math.hypot(p.x - me.x, p.y - me.y) <= p.r) {
          if (p.contested) bar = { text: `${p.name} CONTESTED`, p: p.progress, color: "#ff5040" }
          else if (p.capper >= 0 && p.progress > 0) bar = { text: p.capper === team ? `CAPTURING ${p.name}` : `LOSING ${p.name}`, p: p.progress, color: tc(p.capper) }
        }
    const z = m.zone
    if (!bar && me && g.alive && z && Math.hypot(z.x - me.x, z.y - me.y) <= z.r)
      bar = z.contested ? { text: "ZONE CONTESTED", p: z.left / HP.move, color: "#ff5040" } : { text: "HOLDING THE ZONE", p: z.left / HP.move, color: tc(team) }
    el.mbar!.style.opacity = bar ? "1" : "0"
    if (bar) {
      el.mbt!.textContent = bar.text
      const i = el.mbar!.querySelector("i")!
      i.style.width = `${Math.min(100, bar.p * 100)}%`
      i.style.background = bar.color
    }
    const usable = g.alive && me && canUse(s, team, g.myId, me.x, me.y)
    el.mhint!.innerHTML = usable && !bar ? `HOLD <kbd>${esc(keyLabel("KeyE"))}</kbd> TO ${b?.state === "planted" ? "DEFUSE" : "PLANT"}` : g.alive && b?.carrier === g.myId && !bar ? `YOU HAVE THE BOMB · PLANT AT A OR B` : ""
    if (g.alive && carries(m, g.myId)) el.mhint!.innerHTML = m.flags?.[team]?.state === "home" ? "YOU HAVE THE FLAG · TAKE IT TO YOUR BASE" : "YOU HAVE THE FLAG · YOUR FLAG MUST BE HOME TO SCORE"

    const spec = s.phase === "play" && s.you?.respawnIn === -1 && !g.alive
    const watched = spec ? g.nameOf(this.watching) : ""
    el.mspec!.innerHTML = spec ? `YOU ARE DEAD — SPECTATING${watched ? ` <b style="color:${css(g.colorOf(this.watching))}">${esc(watched.toUpperCase())}</b>` : ""}<span>${rulesOut(s) ?? "back next round"}</span>` : ""

    this.floorLabels(g, s, cam, w, h)
  }

  /** Scores and objective status under the clock. */
  private top(s: Snapshot, g: Game, team: number): string {
    const m = s.mode
    if (!MODES[m.id].teams) return ""
    const side = (t: number) => `<b style="color:${tc(t)}" class="${t === team ? "mine" : ""}">${m.score[t]}</b>`
    let mid = `<span class="tgt">${m.target}</span>`
    let extra = ""
    if (m.id === "dom")
      extra = `<div class="pts">${m.points
        .map((p) => {
          const fill = p.capper >= 0 && p.progress > 0 ? `<i style="width:${p.progress * 100}%;background:${tc(p.capper)}"></i>` : ""
          return `<span class="${p.contested ? "hot" : ""}" style="border-color:${tc(p.owner)};color:${tc(p.owner)}">${fill}<em>${p.name}</em></span>`
        })
        .join("")}</div>`
    if (m.zone) {
      const z = m.zone
      const who = z.contested ? `<b class="hot">CONTESTED</b>` : z.holder >= 0 ? `<b style="color:${tc(z.holder)}">${TEAM_NAMES[z.holder]}</b>` : `<b>NEUTRAL</b>`
      extra = `<div class="obj">ZONE ${z.n + 1} · ${who} · <span class="${z.next ? "hot" : ""}">MOVES ${clock(z.left)}</span></div>`
    }
    if (m.flags)
      extra = `<div class="obj">${m.flags
        .map((f) => {
          const state = f.state === "home" ? "HOME" : f.state === "dropped" ? `DROPPED ${clock(f.returnIn)}` : `TAKEN · ${esc(g.nameOf(f.carrier).toUpperCase())}`
          return `<span class="${f.state === "home" ? "" : "hot"}" style="color:${tc(f.team)}">⚑ ${f.team === team ? "YOURS" : TEAM_NAMES[f.team]} <em>${state}</em></span>`
        })
        .join("")}</div>`
    if (m.round) {
      const r = m.round
      mid = `<span class="tgt">R${r.n}</span>`
      const dots = (t: number) => {
        const total = g.roster.filter((x) => x.team === t).length
        return `<span class="dots" style="color:${tc(t)}">${"●".repeat(r.alive[t]!)}${"○".repeat(Math.max(0, total - r.alive[t]!))}</span>`
      }
      const bomb = m.bomb
      let status = ""
      if (bomb?.state === "planted") status = `<span class="bomb hot">BOMB PLANTED · ${esc(bomb.site)} · ${clock(bomb.fuse)}</span>`
      else if (bomb?.state === "carried") status = `<span class="bomb">BOMB · <b style="color:${tc(r.attack)}">${esc(g.nameOf(bomb.carrier))}</b></span>`
      else if (bomb?.state === "dropped") status = `<span class="bomb">BOMB DROPPED</span>`
      const role = team >= 0 ? `<span class="role">${team === r.attack ? "ATTACK" : "DEFEND"}</span>` : ""
      extra = `<div class="snd">${dots(0)}${role}${dots(1)}</div>${status ? `<div class="snd">${status}</div>` : ""}`
    }
    return `<div class="scores">${side(0)}${mid}${side(1)}</div>${extra}`
  }

  /** Letters over the points and sites, and a tag over the bomb or whoever carries it. */
  private floorLabels(g: Game, s: Snapshot, cam: Camera, w: number, h: number): void {
    const keep = new Set<string>()
    const put = (id: string, html: string, x: number, y: number, z: number, color: string) => {
      const p = cam.project(x, z, y, w, h)
      if (!p.ok) return
      keep.add(id)
      let e = this.labels.get(id)
      if (!e) {
        e = document.createElement("div")
        e.className = "olabel"
        this.el.mlabels!.appendChild(e)
        this.labels.set(id, e)
      }
      if (e.innerHTML !== html) e.innerHTML = html
      e.style.color = color
      e.style.opacity = "1"
      e.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`
    }
    if (s.phase === "play") {
      const m = s.mode
      for (const p of m.points) put(`p${p.name}`, p.name, p.x, p.y, 1.8, tc(p.owner))
      for (const site of m.sites) put(`s${site.name}`, site.name, site.x, site.y, 1.8, "#ff6a50")
      const b = m.bomb
      if (b && (b.state === "dropped" || b.state === "planted")) put("bomb", b.state === "planted" ? `BOMB ${clock(b.fuse)}` : "BOMB", b.x, b.y, 0.9, "#ff5040")
      if (b?.state === "carried") {
        const a = b.carrier === g.myId ? (g.body ? g.drawn : null) : g.avatars.get(b.carrier)
        if (a) put("carrier", "BOMB", a.x, a.y, 2.7, "#ff5040")
      }
      this.objectiveMarks(g, s, cam, w, h, put, keep)
    }
    for (const [id, e] of this.labels) if (!keep.has(id)) e.style.opacity = "0"
  }

  /**
   * Hardpoint and flag labels on the floor, and an arrow at the screen edge toward each that's off screen: the zone,
   * your flag while it's away, the enemy flag (or your base while you carry it).
   */
  private objectiveMarks(g: Game, s: Snapshot, cam: Camera, w: number, h: number, put: (id: string, html: string, x: number, y: number, z: number, color: string) => void, keep: Set<string>): void {
    const m = s.mode
    const team = teamOf(s, g.roster, g.myId)
    const me = g.body && g.alive ? g.drawn : null
    const posOf = (id: string) => (id === g.myId ? me : (g.avatars.get(id) ?? null))
    const arrow = (id: string, x: number, y: number, color: string, text: string) => {
      const p = cam.project(x, 0.5, y, w, h)
      // Clear of the scores and kill feed at the top and the health and ammo at the bottom.
      const [l, r, t, b] = [70, w - 70, 130, h - 110]
      if (p.ok && p.x > l && p.x < r && p.y > t && p.y < b) return
      const dx = p.ok ? p.x - w / 2 : x - (me?.x ?? x)
      const dy = p.ok ? p.y - h / 2 : y - (me?.y ?? y)
      const k = Math.min((dx > 0 ? r - w / 2 : w / 2 - l) / Math.max(1e-3, Math.abs(dx)), (dy > 0 ? b - h / 2 : h / 2 - t) / Math.max(1e-3, Math.abs(dy)))
      keep.add(id)
      let e = this.labels.get(id)
      if (!e) {
        e = document.createElement("div")
        e.className = "oarrow"
        this.el.mlabels!.appendChild(e)
        this.labels.set(id, e)
      }
      const d = me ? `${Math.round(Math.hypot(x - me.x, y - me.y))}m` : ""
      const html = `<i style="transform:rotate(${Math.atan2(dy, dx).toFixed(2)}rad)"></i><span>${text} ${d}</span>`
      if (e.innerHTML !== html) e.innerHTML = html
      e.style.color = color
      e.style.opacity = "1"
      e.style.transform = `translate(${(w / 2 + dx * k).toFixed(1)}px, ${(h / 2 + dy * k).toFixed(1)}px) translate(-50%, -50%)`
    }
    const z = m.zone
    if (z) {
      const c = z.contested ? "#ff5040" : tc(z.holder)
      put("hp", "HARDPOINT", z.x, z.y, 1.6, z.holder < 0 && !z.contested ? "var(--ink)" : c)
      if (z.next) put("hpnext", `NEXT ${clock(z.left)}`, z.next.x, z.next.y, 1.2, "var(--dim)")
      arrow("^hp", z.x, z.y, z.holder < 0 && !z.contested ? "var(--ink)" : c, "ZONE")
    }
    for (const f of m.flags ?? []) {
      const c = tc(f.team)
      const mine = f.team === team
      const label = mine ? "YOUR FLAG" : "FLAG"
      if (f.state === "carried") {
        const a = posOf(f.carrier)
        if (a && f.carrier !== g.myId) put(`flag${f.team}`, label, a.x, a.y, 2.9, c)
        if (a && f.carrier !== g.myId) arrow(`^flag${f.team}`, a.x, a.y, c, mine ? "YOUR FLAG" : "CARRIER")
      } else {
        put(`flag${f.team}`, f.state === "dropped" ? `${label} ${clock(f.returnIn)}` : label, f.x, f.y, 2, c)
        if (!mine || f.state === "dropped") arrow(`^flag${f.team}`, f.x, f.y, c, label)
      }
      if (mine && carries(m, g.myId)) arrow("^base", f.base.x, f.base.y, c, "BASE")
    }
  }
}
