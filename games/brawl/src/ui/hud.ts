import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { CHARACTERS } from "../../shared/characters"
import { FEEL, ROUND_SECONDS, STOCKS } from "../../shared/config"
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
  const k = Math.min(1, d / 120)
  const r = 255
  const g = Math.round(255 * (1 - k * 0.85))
  const b = Math.round(255 * Math.max(0, 1 - k * 2.2))
  return `rgb(${r},${g},${b})`
}

function launchDangerLabel(d: number, out: boolean): string {
  if (out) return "RINGED OUT"
  if (d >= 90) return "DANGER · FLY FAR!"
  if (d >= 50) return "HIGH LAUNCH"
  return "LAUNCH %"
}

/**
 * The in-round HUD: Smash-style player cards along the bottom (damage %, 3-stock lives with shatter animation),
 * your four abilities with key caps and cooldown rings, the round clock, first-round rule hint, KO callout banner,
 * name tags and damage popups over the arena.
 */
export class Hud {
  private cards: HTMLElement
  private abilities: HTMLElement
  private clock: HTMLElement
  private ruleHint: HTMLElement
  private koBanner: HTMLElement
  private big: HTMLElement
  private tags: HTMLElement
  private status: HTMLElement
  private lastCards = ""
  private lastAbilities = ""
  private lastKoHtml = ""
  private shake = new Map<string, { d: number; at: number }>()
  private stockLoss = new Map<string, { s: number; at: number }>()
  private goAt = -9
  /** Optional fighter id to show a card/cooldowns for when `myId` is empty (the Lab's gallery). */
  focus: string | null = null

  constructor(private root: HTMLElement) {
    root.innerHTML = `<div class="tags"></div><div class="top-hud"><div class="clock"></div><div class="rule-hint"></div></div><div class="ko-banner"></div><div class="big"></div><div class="abilities"></div><div class="cards"></div><div class="status"></div>`
    this.tags = root.querySelector(".tags")!
    this.clock = root.querySelector(".clock")!
    this.ruleHint = root.querySelector(".rule-hint")!
    this.koBanner = root.querySelector(".ko-banner")!
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
      this.ruleHint.textContent = ""
      this.ruleHint.className = "rule-hint"
      this.koBanner.innerHTML = this.lastKoHtml = ""
      this.koBanner.className = "ko-banner"
      this.big.textContent = ""
      this.tags.innerHTML = ""
      return
    }
    const now = g.now
    // Countdown, then GO, plus Overcharge indicator.
    const go = s.go
    const left = Math.max(0, s.left - go)
    const elapsed = Math.max(0, ROUND_SECONDS - left)
    const overcharged = go <= 0 && elapsed >= FEEL.overchargeAt
    this.clock.innerHTML = go > 0 ? "" : `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}${overcharged ? ` <em>OVERCHARGE ×${(1 + Math.min(1.25, (elapsed - FEEL.overchargeAt) / 35)).toFixed(1)}</em>` : ""}`
    this.clock.className = `clock${overcharged ? " overcharge" : ""}`
    if (go > 0) this.goAt = now
    const sinceGo = now - this.goAt
    const goFlash = go <= 0 && sinceGo < 0.75
    this.big.textContent = go > 0 ? String(Math.ceil(go)) : goFlash ? "BRAWL!" : ""
    this.big.className = `big${go > 0 || goFlash ? " on" : ""}`

    // Persistent rule strip at top, highlighted on countdown and first 8 seconds of round.
    const highlightRule = go > 0 || sinceGo < 8
    this.ruleHint.innerHTML = `<b>3-STOCK RING-OUT</b> · HIT TO BUILD <em>LAUNCH %</em> · KNOCK FOES OVER THE ROPES · LAST STANDING WINS`
    this.ruleHint.className = `rule-hint on${highlightRule ? " pulse" : ""}`

    // Big KO callout banner ("SLAB LAUNCHED BEA · 2 LIVES LEFT" / "ELIMINATED!").
    const ko = g.lastKo
    if (ko && now - ko.at < 2.4) {
      const victimRow = g.roster.find((r) => r.id === ko.victim)
      const killerRow = g.roster.find((r) => r.id === ko.by)
      const vName = (victimRow?.name ?? CHARACTERS[victimRow?.char ?? ""]?.name ?? "FIGHTER").toUpperCase()
      const kName = killerRow ? (killerRow.name || CHARACTERS[killerRow.char]?.name || "").toUpperCase() : ""
      const kCol = css(ko.by ? g.colorOf(ko.by) : [1, 0.72, 0.2])
      const vCol = css(g.colorOf(ko.victim))
      const headline = kName && ko.by !== ko.victim
        ? `<span style="color:${kCol}">${esc(kName)}</span> LAUNCHED <span style="color:${vCol}">${esc(vName)}</span>!`
        : `<span style="color:${vCol}">${esc(vName)}</span> RINGED OUT!`
      const sub = ko.stocks > 0 ? `${ko.stocks} ${ko.stocks === 1 ? "LIFE" : "LIVES"} LEFT` : `ELIMINATED!`
      const koHtml = `<div class="ko-main">${headline}</div><div class="ko-sub${ko.stocks <= 0 ? " elim" : ""}">${sub}</div>`
      if (koHtml !== this.lastKoHtml) this.koBanner.innerHTML = this.lastKoHtml = koHtml
      this.koBanner.className = `ko-banner on${ko.stocks <= 0 ? " elim" : ""}`
    } else {
      this.koBanner.className = "ko-banner"
    }

    // Player cards (3 stocks + launch % meter).
    const focusId = g.myId || this.focus
    const roster = this.focus ? g.roster.filter((r) => r.id === this.focus) : g.roster
    let html = ""
    for (const r of roster) {
      const f = s.f.find((q) => q.i === r.id)
      const c = CHARACTERS[r.char]
      if (!c) continue
      const d = f?.d ?? 0
      const prev = this.shake.get(r.id)
      if (!prev || prev.d !== d) this.shake.set(r.id, { d, at: d > (prev?.d ?? 0) ? now : (prev?.at ?? -9) })
      const jolt = now - (this.shake.get(r.id)?.at ?? -9) < 0.25

      const curStocks = Math.max(0, f?.s ?? 0)
      const prevS = this.stockLoss.get(r.id)
      if (!prevS) this.stockLoss.set(r.id, { s: curStocks, at: -9 })
      else if (curStocks < prevS.s) this.stockLoss.set(r.id, { s: curStocks, at: now })
      else if (curStocks > prevS.s) this.stockLoss.set(r.id, { s: curStocks, at: -9 })
      const lostRecently = now - (this.stockLoss.get(r.id)?.at ?? -9) < 0.85

      const out = curStocks <= 0
      const slot = css(SLOT_COLORS[r.slot % SLOT_COLORS.length]!)
      let stocks = ""
      for (let idx = 0; idx < STOCKS; idx++) {
        const aliveStock = idx < curStocks
        const justShattered = idx === curStocks && lostRecently
        stocks += `<i class="${aliveStock ? "full" : "lost"}${justShattered ? " shatter" : ""}" style="--stock:${css(c.color)}"></i>`
      }
      const scale = 1 + Math.min(0.28, d / 420)
      const danger = d >= 90 && !out
      html += `<div class="card${r.id === focusId ? " mine" : ""}${out ? " out" : ""}${lostRecently ? " stock-hit" : ""}${danger ? " danger" : ""}" style="--slot:${slot};--char:${css(c.color)}">
        <div class="face" style="background-image:url(portraits/${c.id}.jpg)"></div>
        <div class="who"><b>${esc(r.name)}${r.id === g.myId ? ` <em>YOU</em>` : ""}</b><span>${esc(c.name)}</span></div>
        <div class="dmg-wrap">
          <div class="dmg-lbl">${launchDangerLabel(d, out)}</div>
          <div class="dmg${jolt ? " jolt" : ""}" style="color:${damageColor(d)};--dmg-scale:${scale.toFixed(2)}">${out ? "OUT" : `${Math.round(d)}<small>%</small>`}</div>
        </div>
        <div class="stocks" title="${curStocks} of ${STOCKS} lives left">${stocks}<span class="stocks-lbl">${curStocks}/${STOCKS}</span></div>
      </div>`
    }
    if (html !== this.lastCards) this.cards.innerHTML = this.lastCards = html

    // Your abilities.
    const me = focusId ? s.f.find((q) => q.i === focusId) : null
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

    // Name tags over heads (with mini stock dots), damage popups.
    const cam = g.cam
    let tags = ""
    for (const f of s.f) {
      if (!(f.f & F.alive) || f.f & F.falling) continue
      const r = g.roster.find((q) => q.id === f.i)
      const at = g.drawnOf(f.i) ?? f
      const p = cam.project(at.x, 2.2 * FIGURE_SCALE * (LOOKS[f.c]?.scale ?? 1), at.y, w, h)
      if (!p.ok) continue
      const slot = css(SLOT_COLORS[(r?.slot ?? 0) % SLOT_COLORS.length]!)
      const dots = Array.from({ length: STOCKS }, (_, idx) => `<i class="${idx < f.s ? "on" : ""}"></i>`).join("")
      tags += `<div class="tag${f.i === g.myId ? " mine" : ""}" style="left:${p.x}px;top:${p.y}px;--slot:${slot}"><span>${f.i === g.myId ? "YOU" : esc(r?.name ?? "")}</span><b style="color:${damageColor(f.d)}">${Math.round(f.d)}%</b><em class="tag-stocks">${dots}</em></div>`
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
