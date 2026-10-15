import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { WINS_TO_MATCH } from "../../shared/config"
import type { Game } from "../game/game"
import { KEYSETS } from "../game/controls"
import { IDENTITIES } from "../render/models"

const css = (c: readonly number[]) => `rgb(${c.map((v) => Math.round(Math.min(1, v) * 255)).join(",")})`

/**
 * The HUD stays out of the picture: a thin score strip at the top (each archer's mark and round wins), a round card in
 * the middle between rounds, short-lived name tags over people, and the controls under the first rounds.
 */
export class Hud {
  private strip: HTMLDivElement
  private card: HTMLDivElement
  private tags: HTMLDivElement
  private help: HTMLDivElement
  private netEl: HTMLDivElement
  private netHtml = ""
  private lastCard = ""
  private tagEls = new Map<string, HTMLDivElement>()

  constructor(readonly root: HTMLElement) {
    root.innerHTML = `<div class="strip"></div><div class="card"></div><div class="tags"></div><div class="help"></div><div class="net"></div>`
    this.strip = root.querySelector(".strip")!
    this.card = root.querySelector(".card")!
    this.tags = root.querySelector(".tags")!
    this.help = root.querySelector(".help")!
    this.netEl = root.querySelector(".net")!
  }

  /** The room line in the corner: code, round trip, an invite button and any connection problem. */
  net(room: string | null, rttMs: number, problem: string | null, invite?: () => void): void {
    const html = room
      ? `<div>ROOM <b>${room.toUpperCase()}</b>${rttMs ? ` · ${Math.round(rttMs)} MS` : ""}<button>COPY INVITE</button></div>${problem ? `<div class="problem">${problem}</div>` : ""}`
      : ""
    if (html === this.netHtml) return
    this.netHtml = html
    this.netEl.innerHTML = html
    const b = this.netEl.querySelector("button")
    if (b && invite) b.onclick = invite
  }

  update(g: Game, w: number, h: number, showHelp: boolean): void {
    const s = g.world.s
    // Score strip.
    const html = s.archers.map((a) => {
      const id = IDENTITIES[a.slot % 4]!
      const pips = Array.from({ length: WINS_TO_MATCH }, (_, i) => `<i class="${i < a.wins ? "on" : ""}"></i>`).join("")
      return `<div class="slot ${a.alive ? "" : "out"}" style="--c:${css(id.ember)}"><b>${a.name}</b><span class="pips">${pips}</span></div>`
    }).join("")
    if (this.strip.innerHTML !== html) this.strip.innerHTML = html

    // Round card.
    let text = ""
    let sub = ""
    let color = "#e8e4dc"
    const since = s.time - s.phaseAt
    if (s.phase === "count") {
      text = `ROUND ${s.round}`
      sub = g.arena.name.toUpperCase()
    } else if (s.phase === "over" && since > 0.5) {
      const w = s.archers.find((a) => a.id === s.winner)
      text = w ? `${w.name} TAKES IT` : "NO ONE SURVIVES"
      if (w) color = css(IDENTITIES[w.slot % 4]!.ember)
    } else if (s.phase === "match") {
      const w = s.archers.find((a) => a.id === s.winner)
      text = w ? `${w.name} WINS THE MATCH` : "MATCH"
      sub = "NEW MATCH SOON"
      if (w) color = css(IDENTITIES[w.slot % 4]!.ember)
    }
    const key = `${text}|${sub}|${color}`
    if (key !== this.lastCard) {
      this.lastCard = key
      this.card.innerHTML = text ? `<div class="title" style="color:${color}">${text}</div>${sub ? `<div class="sub">${sub}</div>` : ""}` : ""
      this.card.classList.toggle("on", !!text)
    }

    // Name tags over people while a round starts.
    const tagOn = s.phase === "count" || since < 2.5
    const seen = new Set<string>()
    for (const p of tagOn ? g.heads(w, h) : []) {
      if (p.bot) continue
      seen.add(p.id)
      let el = this.tagEls.get(p.id)
      if (!el) {
        el = document.createElement("div")
        el.className = "tag"
        this.tags.appendChild(el)
        this.tagEls.set(p.id, el)
      }
      el.textContent = p.name
      el.style.setProperty("--c", css(IDENTITIES[p.slot % 4]!.ember))
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`
    }
    for (const [id, el] of this.tagEls) {
      if (seen.has(id)) continue
      el.remove()
      this.tagEls.delete(id)
    }

    // Controls for whoever is on a keyboard.
    const devices = g.seats.map((x) => x.device).filter(Boolean)
    const helpHtml = showHelp ? devices.map((d) => {
      if (!d || d.startsWith("pad")) return `<div class="row"><b>PAD</b> stick move · A jump · X shoot · B dodge</div>`
      const k = KEYSETS[d as keyof typeof KEYSETS]
      const caps = (codes: string[]) => codes.slice(0, 1).map((c) => keyCapHtml(c)).join("")
      return `<div class="row">${caps(k.left)}${caps(k.up)}${caps(k.down)}${caps(k.right)} move/aim · ${caps(k.jump)} jump · ${caps(k.shoot)} hold to draw · ${caps(k.dodge)} dodge</div>`
    }).join("") + (g.online ? "" : `<div class="row dim">Gamepad A or ${keyCapHtml("Enter")} to join · ${keyCapHtml("KeyP")} play online</div>`) : ""
    if (this.help.innerHTML !== helpHtml) this.help.innerHTML = helpHtml
  }
}
