import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { CHARACTERS } from "../../shared/characters"
import { F } from "../../shared/view"
import { type Game, SLOT_COLORS } from "../game/game"
import { FIGURE_SCALE } from "../game/fighters"
import { LOOKS } from "../looks/roster"

/** Ability slots and their physical keys: left mouse, Q, E, Space. */
export const SLOT_KEYS = ["Mouse0", "KeyQ", "KeyE", "Space"] as const

const css = (c: readonly number[]) => `rgb(${Math.round(c[0]! * 255)},${Math.round(c[1]! * 255)},${Math.round(c[2]! * 255)})`
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Damage colour: white, through yellow and orange, to deep red as knockback grows. */
function damageColor(d: number): string {
  const k = Math.min(1, d / 150)
  const r = 255
  const g = Math.round(255 * (1 - k * 0.85))
  const b = Math.round(255 * Math.max(0, 1 - k * 2.2))
  return `rgb(${r},${g},${b})`
}

/**
 * The in-round HUD: Smash-style player cards along the bottom (damage %, stocks), your four abilities with key caps
 * and cooldown rings, the round clock and countdown, name tags and damage popups over the arena.
 */
export class Hud {
  private cards: HTMLElement
  private abilities: HTMLElement
  private clock: HTMLElement
  private big: HTMLElement
  private tags: HTMLElement
  private status: HTMLElement
  private lastCards = ""
  private lastAbilities = ""
  private shake = new Map<string, { d: number; at: number }>()
  private goAt = -9

  constructor(private root: HTMLElement) {
    root.innerHTML = `<div class="tags"></div><div class="clock"></div><div class="big"></div><div class="abilities"></div><div class="cards"></div><div class="status"></div>`
    this.tags = root.querySelector(".tags")!
    this.clock = root.querySelector(".clock")!
    this.big = root.querySelector(".big")!
    this.abilities = root.querySelector(".abilities")!
    this.cards = root.querySelector(".cards")!
    this.status = root.querySelector(".status")!
  }

  show(on: boolean): void {
    this.root.style.display = on ? "" : "none"
  }

  update(g: Game, w: number, h: number, status: string | null): void {
    const s = g.snap
    const play = s?.phase === "play"
    this.root.classList.toggle("playing", !!play)
    this.status.textContent = status ?? ""
    if (!s || !play) {
      this.cards.innerHTML = this.lastCards = ""
      this.abilities.innerHTML = this.lastAbilities = ""
      this.clock.textContent = ""
      this.big.textContent = ""
      this.tags.innerHTML = ""
      return
    }
    // Countdown, then GO.
    const go = s.go
    const left = Math.max(0, s.left - go)
    this.clock.textContent = go > 0 ? "" : `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}`
    if (go > 0) this.goAt = g.now
    const goFlash = go <= 0 && g.now - this.goAt < 0.8
    this.big.textContent = go > 0 ? String(Math.ceil(go)) : goFlash ? "GO!" : ""
    this.big.className = `big${go > 0 || goFlash ? " on" : ""}`

    // Player cards.
    const now = g.now
    let html = ""
    for (const r of g.roster) {
      const f = s.f.find((q) => q.i === r.id)
      const c = CHARACTERS[r.char]
      if (!c) continue
      const d = f?.d ?? 0
      const prev = this.shake.get(r.id)
      if (!prev || prev.d !== d) this.shake.set(r.id, { d, at: d > (prev?.d ?? 0) ? now : (prev?.at ?? -9) })
      const jolt = now - (this.shake.get(r.id)?.at ?? -9) < 0.25
      const out = (f?.s ?? 0) <= 0
      const slot = css(SLOT_COLORS[r.slot % SLOT_COLORS.length]!)
      const stocks = Array.from({ length: Math.max(0, f?.s ?? 0) }, () => `<i style="background:${css(c.color)}"></i>`).join("")
      html += `<div class="card${r.id === g.myId ? " mine" : ""}${out ? " out" : ""}" style="--slot:${slot};--char:${css(c.color)}">
        <div class="face" style="background-image:url(portraits/${c.id}.jpg)"></div>
        <div class="who"><b>${esc(r.name)}</b><span>${esc(c.name)}</span></div>
        <div class="dmg${jolt ? " jolt" : ""}" style="color:${damageColor(d)}">${out ? "OUT" : `${Math.round(d)}<small>%</small>`}</div>
        <div class="stocks">${stocks}</div>
      </div>`
    }
    if (html !== this.lastCards) this.cards.innerHTML = this.lastCards = html

    // Your abilities.
    const me = g.me
    const you = s.you
    if (me && you) {
      const def = CHARACTERS[me.c]!
      let ab = ""
      def.abilities.forEach((a, i) => {
        const cd = you.cd[i] ?? 0
        const full = a.cooldown || 1
        const p = Math.max(0, Math.min(1, cd / full))
        ab += `<div class="ab${cd > 0.05 ? " cooling" : ""}" style="--p:${p.toFixed(3)}">
          <div class="ring">${keyCapHtml(SLOT_KEYS[i]!)}</div>
          <div class="name">${esc(a.name)}</div>
          ${cd > 0.05 ? `<div class="cd">${cd < 1 ? cd.toFixed(1) : Math.ceil(cd)}</div>` : ""}
        </div>`
      })
      if (ab !== this.lastAbilities) this.abilities.innerHTML = this.lastAbilities = ab
    } else if (this.lastAbilities) this.abilities.innerHTML = this.lastAbilities = ""

    // Name tags over heads, damage popups.
    const cam = g.cam
    let tags = ""
    for (const f of s.f) {
      if (!(f.f & F.alive) || f.f & F.falling) continue
      const r = g.roster.find((q) => q.id === f.i)
      const at = g.drawnOf(f.i) ?? f
      const p = cam.project(at.x, 2.2 * FIGURE_SCALE * (LOOKS[f.c]?.scale ?? 1), at.y, w, h)
      if (!p.ok) continue
      const slot = css(SLOT_COLORS[(r?.slot ?? 0) % SLOT_COLORS.length]!)
      tags += `<div class="tag${f.i === g.myId ? " mine" : ""}" style="left:${p.x}px;top:${p.y}px;--slot:${slot}">${f.i === g.myId ? "YOU" : esc(r?.name ?? "")}</div>`
    }
    g.popups = g.popups.filter((p) => now - p.t0 < (p.big ? 1.2 : 0.8))
    for (const p of g.popups) {
      const u = (now - p.t0) / (p.big ? 1.2 : 0.8)
      const q = cam.project(p.x, 2.2 + u * 1.5, p.y, w, h)
      if (!q.ok) continue
      tags += `<div class="pop${p.big ? " big" : ""}" style="left:${q.x}px;top:${q.y}px;opacity:${(1 - u * u).toFixed(2)};color:${css(p.color)}">${esc(p.text)}</div>`
    }
    this.tags.innerHTML = tags
  }
}
