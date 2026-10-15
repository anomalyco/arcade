import { type Crew, crewCount, teamCss } from "../../shared/crew"
import type { ObjectiveView } from "../../shared/objective"

const CSS = `
#obj { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); display: grid; justify-items: center; gap: 7px; font-size: 12px;
  letter-spacing: 0.28em; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7), 0 0 10px rgba(0, 0, 0, 0.35); }
#obj[hidden], #obj-end[hidden], #obj [hidden] { display: none; }
#obj .bar { display: flex; align-items: center; gap: 14px; padding: 6px 14px; background: rgba(6, 16, 30, 0.55); box-shadow: 0 0 0 1px rgba(244, 247, 251, 0.08) inset; }
#obj .zones { display: flex; gap: 8px; }
#obj .pip { position: relative; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; letter-spacing: 0;
  background: conic-gradient(var(--cap, transparent) calc(var(--p, 0) * 1turn), rgba(244, 247, 251, 0.12) 0); color: #f4f7fb; }
#obj .pip::before { content: ""; position: absolute; inset: 3px; border-radius: 50%; background: var(--hold, rgba(6, 16, 30, 0.85)); }
#obj .pip b { position: relative; font-weight: 400; color: var(--ink-on, #f4f7fb); text-shadow: none; }
#obj .pip.contested { animation: obj-flash 0.4s steps(2) infinite; }
#obj .pip.here::after { content: ""; position: absolute; left: 50%; bottom: -6px; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: #f4f7fb; }
#obj .scores { display: flex; gap: 12px; font-variant-numeric: tabular-nums; }
#obj .sc { display: grid; gap: 3px; min-width: 3.4em; justify-items: center; font-size: 14px; letter-spacing: 0.08em; }
#obj .sc i { display: block; width: 100%; height: 3px; background: rgba(244, 247, 251, 0.16); }
#obj .sc i u { display: block; height: 100%; background: var(--team); }
#obj .sc.me { font-weight: 400; }
#obj .sc.me::before { content: ""; width: 100%; height: 1px; background: var(--team); margin-bottom: 1px; }
#obj .sc span { color: var(--team); }
#obj .time { display: grid; justify-items: end; gap: 2px; font-variant-numeric: tabular-nums; font-size: 11px; }
#obj .time .move.soon { color: #ffd34a; }
#obj .time .round { opacity: 0.65; font-size: 9.5px; }
#obj .me { display: flex; align-items: center; gap: 10px; font-size: 11px; }
#obj .me .m { width: 120px; height: 4px; background: rgba(244, 247, 251, 0.18); }
#obj .me .m u { display: block; height: 100%; background: var(--c, #f4f7fb); }
#obj .me.contested { color: #ffd34a; animation: obj-flash 0.4s steps(2) infinite; }
#obj .event { font-size: 12px; letter-spacing: 0.4em; margin-right: -0.4em; color: var(--c, #f4f7fb); }
#obj-end { position: absolute; left: 50%; top: 27%; transform: translateX(-50%); display: grid; justify-items: center; gap: 10px; text-align: center;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75), 0 0 16px rgba(0, 0, 0, 0.4); }
#obj-end .title { font-size: 26px; letter-spacing: 0.5em; margin-right: -0.5em; color: var(--c, #f4f7fb); }
#obj-end .sub { font-size: 11px; letter-spacing: 0.4em; margin-right: -0.4em; opacity: 0.85; }
@keyframes obj-flash { 50% { opacity: 0.35; } }
`

const clock = (s: number): string => {
  const v = Math.max(0, Math.ceil(s))
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`
}

const bitCount = (m: number): number => {
  let n = 0
  for (let v = m; v; v &= v - 1) n++
  return n
}

const LABELS = ["A", "B", "C", "D"]

/**
 * The objective's HUD, top centre: the zones (letter pips: holder colour, capture ring, flashing when contested), every
 * side's score in its colour with a bar to the target, the time to the next relocation and the points that win; under it
 * your own ship's capture meter while it is in a zone, and one short event line. The round's result shows as a banner.
 */
export class ObjectiveHud {
  private el: HTMLElement
  private end: HTMLElement
  private last = ""
  private lastEnd = ""
  private prev: ObjectiveView | null = null
  private event: { text: string; color: string; until: number } | null = null

  constructor(root: HTMLElement) {
    if (!document.getElementById("obj-css")) {
      const style = document.createElement("style")
      style.id = "obj-css"
      style.textContent = CSS
      document.head.append(style)
    }
    this.el = document.createElement("div")
    this.el.id = "obj"
    this.el.hidden = true
    this.end = document.createElement("div")
    this.end.id = "obj-end"
    this.end.hidden = true
    root.append(this.el, this.end)
  }

  update(t: number, v: ObjectiveView | null, crew: Crew | null, myTeam: number, hidden: boolean): void {
    this.events(t, v, myTeam)
    this.prev = v
    if (!v || hidden) {
      this.el.hidden = true
      this.end.hidden = true
      this.last = ""
      this.lastEnd = ""
      return
    }
    const active = new Set<number>()
    for (const s of crew?.ships ?? []) if (crewCount(s) > 0) active.add(s.team)
    const teams = v.scores.map((_, i) => i).filter((i) => active.has(i) || v.scores[i]! >= 1 || i === myTeam)
    const ended = v.end >= 0
    const pips = ended
      ? ""
      : v.zones
          .map((z) => {
            const contested = bitCount(z.present) >= 2
            const here = myTeam >= 0 && (z.present & (1 << myTeam)) !== 0
            const hold = z.holder >= 0 ? teamCss(z.holder) : ""
            const style = `--p:${z.cap >= 0 ? z.progress.toFixed(2) : 0};--cap:${z.cap >= 0 ? teamCss(z.cap) : "transparent"}${hold ? `;--hold:${hold};--ink-on:#0b1626` : ""}`
            return `<span class="pip${contested ? " contested" : ""}${here ? " here" : ""}" style="${style}"><b>${LABELS[z.id] ?? "?"}</b></span>`
          })
          .join("")
    const scores = teams
      .map((i) => {
        const s = v.scores[i]!
        const pct = Math.min(100, (s / v.rules.target) * 100)
        return `<span class="sc${i === myTeam ? " me" : ""}" style="--team:${teamCss(i)}"><span>${Math.floor(s)}</span><i><u style="width:${pct.toFixed(1)}%"></u></i></span>`
      })
      .join("")
    const soon = v.next.length > 0
    const move = ended ? "" : `<span class="move${soon ? " soon" : ""}">${soon ? "MOVING" : "MOVE"} ${clock(v.moveAt - t)}</span>`
    const meLine = ended ? "" : this.meLine(v, myTeam)
    const ev = this.eventLine(t, v)
    const html = `<div class="bar">${pips ? `<span class="zones">${pips}</span>` : ""}<span class="scores">${scores}</span><span class="time">${move}<span class="round">TO ${v.rules.target}</span></span></div>${meLine}${ev}`
    if (html !== this.last) {
      this.last = html
      this.el.innerHTML = html
    }
    this.el.hidden = false
    // The result.
    let endKey = ""
    if (ended) {
      const ship = crew?.ships.find((s) => s.team === v.winner)
      const title = v.winner >= 0 ? `${ship?.name ?? "CARRIER"} WINS` : "DRAW"
      const color = v.winner >= 0 ? teamCss(v.winner) : "#f4f7fb"
      endKey = `${title}|${color}|${clock(v.end + v.rules.intermission - t)}`
      if (endKey !== this.lastEnd) {
        this.end.style.setProperty("--c", color)
        this.end.innerHTML = `<div class="title"></div><div class="sub">NEXT ROUND ${clock(v.end + v.rules.intermission - t)}</div>`
        this.end.querySelector(".title")!.textContent = title
      }
    }
    this.lastEnd = endKey
    this.end.hidden = !ended
  }

  /** My ship in a zone: capturing, holding (scoring), draining someone else's, or contested. */
  private meLine(v: ObjectiveView, me: number): string {
    if (me < 0) return ""
    const z = v.zones.find((x) => (x.present & (1 << me)) !== 0)
    if (!z) return ""
    const L = LABELS[z.id] ?? "?"
    if (bitCount(z.present) >= 2) return `<div class="me contested">CONTESTED ${L}</div>`
    if (z.holder === me && z.progress >= 1) return `<div class="me" style="--c:${teamCss(me)}">HOLDING ${L}</div>`
    const mine = z.cap === me
    const label = mine ? `CAPTURING ${L}` : `NEUTRALISING ${L}`
    const c = mine ? teamCss(me) : teamCss(z.cap)
    return `<div class="me" style="--c:${c}">${label}<span class="m"><u style="width:${(z.progress * 100).toFixed(0)}%"></u></span></div>`
  }

  private eventLine(t: number, v: ObjectiveView): string {
    const e = this.event && this.event.until > t ? this.event : null
    if (e) return `<div class="event" style="--c:${e.color}">${e.text}</div>`
    if (v.end < 0 && v.next.length) {
      const n = v.next.length > 1 || v.zones.length > 1
      return `<div class="event" style="--c:#ffd34a">${n ? "ZONES" : "ZONE"} MOVING IN ${Math.max(0, Math.ceil(v.moveAt - t))}S</div>`
    }
    return ""
  }

  /** Short-lived lines from what changed since the last frame. */
  private events(t: number, v: ObjectiveView | null, me: number): void {
    const p = this.prev
    if (!v || !p) return
    const say = (text: string, color = "#f4f7fb") => (this.event = { text, color, until: t + 3.5 })
    if (v.round !== p.round) return void say("NEW ROUND")
    if (v.end >= 0) return
    if (v.cycle !== p.cycle) return void say(v.zones.length > 1 ? "ZONES MOVED" : "ZONE MOVED", "#ffd34a")
    for (const z of v.zones) {
      const was = p.zones.find((x) => x.id === z.id)
      if (!was || was.holder === z.holder) continue
      const L = LABELS[z.id] ?? "?"
      if (z.holder >= 0) say(`ZONE ${L} CAPTURED`, teamCss(z.holder))
      else if (was.holder === me) say(`ZONE ${L} LOST`, "#ff8a6a")
      else say(`ZONE ${L} NEUTRAL`)
    }
  }
}
