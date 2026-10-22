import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { dayCycle } from "../../shared/day-cycle"
import { causeText, type DeathState } from "../../shared/death/rules"
import {
  clueKindOfCode,
  clueWords,
  deadlineText,
  EVENT_BLOWN,
  EVENT_CUT,
  EVENT_ESCAPED,
  EVENT_HOTWIRED,
  EVENT_LATE_BOAT,
  EVENT_LEFT_BEHIND,
  EVENT_MISSED,
  EVENT_SIGNAL,
} from "../../shared/way-out/clues"
import { DESTINATION_WORDS, roughDistance, type WayOutPlan } from "../../shared/way-out/plan"
import type { Roadblock } from "../../shared/way-out/roadblocks"
import type { WayOutView } from "../../shared/way-out/state"
import type { WayOutTuning } from "../../shared/way-out/tuning"
import { clueArt, placeArt } from "./drawings"
import "./way-out.css"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s)) % 60).padStart(2, "0")}`
const TOAST_MS = 6500
const CARD_DELAY_MS = 1600

/** What the escape card offers (as the run-over card does); `fresh` asks for a new town (solo only). */
export type WayOutHudActions = { restart(fresh: boolean): void; lobby(): void; canFresh: boolean }

export type WayOutHudInput = {
  view: WayOutView | null
  plan: WayOutPlan
  tuning: WayOutTuning
  death: DeathState | undefined
  slots: readonly { index: number }[]
  localIndex: number
  me: { x: number; y: number }
  hour: number
  time: number
  /** Game seconds per real second, for the stand's countdown. */
  timeScale: number
  name: (index: number) => string
  /** The route's roadblocks still standing (for the soldier's orders). */
  blocks: readonly Roadblock[]
  /** The car the local survivor is driving: fuel (%) and how far that goes at full throttle (m). */
  car: { fuel: number; range: number } | null
  /** A hold in progress by the local survivor: hotwiring a car, cutting a chain. */
  hold: { label: string; progress: number } | null
  /** The map's key, for "pinned" (Backquote › Controls › Map key). */
  mapKey: string
}

/** `lines` are HTML (escaped where they are words). */
type Toast = { art: string; title: string; lines: string[]; tone: "clue" | "warm" | "danger" }

/** Real seconds until it next gets light, at `timeScale` (0 while it is light). */
export function secondsToLight(hour: number, timeScale: number): number {
  if (dayCycle(hour).darkness < 0.5) return 0
  for (let m = 1; m <= 24 * 60; m++) if (dayCycle(hour + m / 60).darkness < 0.5) return (m * 60) / Math.max(1, timeScale)
  return 0
}

/**
 * The Way Out on screen (AR-64): the goal line (nothing until the first rumour: at first you do not know there is a
 * way out), a toast with a drawing for every clue and event, and the escape card. DOM over the canvas, rebuilt only
 * when its text changes.
 */
export class WayOutHud {
  private readonly goal: HTMLDivElement
  private readonly toast: HTMLDivElement
  private readonly over: HTMLDivElement
  private goalHtml = ""
  private overHtml = ""
  private seenAt = -1
  private seenTier = -1
  private readonly queue: Toast[] = []
  private toastUntil = 0
  private wonAt: number | null = null
  actions: WayOutHudActions | null = null
  /** Proof readout of what is on screen. */
  readonly shown = { goal: "", toast: null as string | null, over: false }

  constructor(doc: Document = document) {
    const div = (cls: string) => {
      const el = doc.createElement("div")
      el.className = cls
      doc.body.append(el)
      return el
    }
    this.goal = div("owo-goal")
    this.toast = div("owo-toast")
    this.over = div("owo-over")
    this.over.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]")
      if (!b || !this.actions) return
      const act = b.dataset.act
      if (act === "lobby") this.actions.lobby()
      else this.actions.restart(act === "fresh")
    })
    doc.addEventListener("keydown", (e) => {
      if (e.code === "Enter" && this.shown.over && this.actions) this.actions.restart(false)
    })
  }

  /** Forget what was seen (a new session): the next update shows no stale toasts. */
  reset(): void {
    this.seenAt = -1
    this.seenTier = -1
    this.queue.length = 0
    this.toastUntil = 0
    this.wonAt = null
    this.toast.dataset.on = "false"
    this.shown.toast = null
  }

  update(i: WayOutHudInput): void {
    const on = Boolean(i.tuning.wayOut) && i.view !== null
    this.events(i)
    this.drawGoal(on ? i : null)
    this.drawToast()
    this.drawCard(on ? i : null)
  }

  private events(i: WayOutHudInput): void {
    const v = i.view
    if (!v) return
    // The first look at a session takes what has happened as read.
    if (this.seenAt < 0) {
      this.seenAt = v.lastAt
      this.seenTier = v.tier
      return
    }
    if (v.lastAt === this.seenAt) return
    this.seenAt = v.lastAt
    const plan = i.plan
    const w = DESTINATION_WORDS[plan.kind]
    const deadline = v.deadline || i.tuning.deadlineNight
    const kind = clueKindOfCode(v.last)
    const by = v.lastBy >= 0 && i.slots.length > 1 ? i.name(v.lastBy) : null
    if (kind) {
      const words = clueWords(kind, plan, deadline, i.blocks)
      const bearing = Math.atan2(plan.y - 44, plan.x - 44)
      this.queue.push({ art: clueArt(kind, plan.kind, bearing), title: words.title, lines: (by ? [...words.lines, `Found by ${by}`] : words.lines).map(esc), tone: "clue" })
      if (v.tier >= 3 && this.seenTier < 3 && kind !== "arrive") {
        this.queue.push({ art: placeArt(plan.kind), title: w.short, lines: [`Pinned on your map. ${keyCapHtml(i.mapKey)}`], tone: "warm" })
      }
    } else if (v.last === EVENT_SIGNAL) {
      this.queue.push({ art: clueArt("signal", plan.kind), title: "Signal sent", lines: [i.tuning.standRule ? "Hold until they come." : "Hold until dawn."].map(esc), tone: "warm" })
    } else if (v.last === EVENT_LEFT_BEHIND) {
      this.queue.push({ art: clueArt("left", plan.kind), title: `The ${w.craft} came and went`, lines: ["Nobody was there to meet it."], tone: "danger" })
    } else if (v.last === EVENT_LATE_BOAT) {
      this.queue.push({ art: placeArt(plan.kind), title: `One more ${w.craft}`, lines: [esc(`Leaves ${deadlineText(deadline)}.`)], tone: "warm" })
    } else if (v.last === EVENT_MISSED) {
      this.queue.push({ art: clueArt("missed", plan.kind), title: `The last ${w.craft} has gone`, lines: ["There is no way out now. Survive."], tone: "danger" })
    } else if (v.last === EVENT_BLOWN || v.last === EVENT_CUT) {
      const lines = [v.last === EVENT_BLOWN ? "Blown apart." : "The chain is cut.", "The road is open."]
      this.queue.push({ art: clueArt(v.last === EVENT_BLOWN ? "blown" : "cut", plan.kind), title: "Road open", lines: (by ? [...lines, `By ${by}`] : lines).map(esc), tone: "warm" })
    } else if (v.last === EVENT_HOTWIRED) {
      const lines = ["It'll start.", i.tuning.carProject ? "The pumps are dry. Gas cans only." : ""].filter(Boolean)
      this.queue.push({ art: clueArt("hotwired", plan.kind), title: "Hotwired", lines: (by ? [...lines, `By ${by}`] : lines).map(esc), tone: "warm" })
    } else if (v.last !== EVENT_ESCAPED) {
      // Unknown codes stay quiet.
    }
    this.seenTier = v.tier
  }

  private drawToast(): void {
    const now = performance.now()
    if (now < this.toastUntil) return
    const next = this.queue.shift()
    if (!next) {
      if (this.toast.dataset.on === "true") this.toast.dataset.on = "false"
      this.shown.toast = null
      return
    }
    this.toast.dataset.tone = next.tone
    this.toast.innerHTML = `${next.art}<b>${esc(next.title)}</b>${next.lines.map((l) => `<span>${l}</span>`).join("")}`
    // Restart the entrance animation.
    this.toast.dataset.on = "false"
    void this.toast.offsetWidth
    this.toast.dataset.on = "true"
    this.toastUntil = now + TOAST_MS
    this.shown.toast = next.title
  }

  private drawGoal(i: WayOutHudInput | null): void {
    let html = ""
    const v = i?.view
    if (i?.hold) {
      html = `<b>${esc(i.hold.label)}</b> ${keyCapHtml("KeyE", { hold: true, progress: i.hold.progress })}`
    } else if (i && v && !v.won && v.tier > 0) {
      const plan = i.plan
      const w = DESTINATION_WORDS[plan.kind]
      const deadline = v.deadline || i.tuning.deadlineNight
      const lastNight = v.night >= deadline
      const when = `<em${lastNight ? ' class="owo-urgent"' : ""}>${lastNight ? "Last night · leaves" : "Last one leaves"} ${deadlineText(deadline)}</em>`
      const d = Math.hypot(plan.x - i.me.x, plan.y - i.me.y)
      if (v.missed) html = `<span class="owo-dim">The last ${esc(w.craft)} has gone</span>`
      else if (v.signalled) {
        const left = i.tuning.standRule ? v.standEnd - i.time : secondsToLight(i.hour, i.timeScale)
        html = `<b>Hold ${esc(w.short.toLowerCase())}</b> <span>${i.tuning.standRule ? "until they come" : "until dawn"} · ${mmss(left)}</span>`
      } else if (v.clues.has("arrive") && d <= i.tuning.evacRadius * 3) {
        html = `<b>${esc(w.short)}</b> <span>Signal them: ${keyCapHtml("KeyE")} at the post, a flare, or the horn</span> ${when}`
      } else if (v.tier >= 3) html = `<b>${esc(w.short)}</b> <span>${roughDistance(d)} · pinned ${keyCapHtml(i.mapKey)}</span> ${when}`
      else if (v.tier >= 2) html = `<b>${esc(w.short)}?</b> <span>${esc(plan.bearing)} of town, ${roughDistance(plan.distance)} by road</span> ${when}`
      else html = `<b>A way out?</b> <span>${esc(w.short)}. Find where.</span> ${when}`
      // Driving there: how far the tank goes, so you know whether to find gas cans first.
      if (i.car && v.tier >= 2 && !v.signalled && !v.missed) html += ` <em${i.car.range < d ? ' class="owo-urgent"' : ""}>Tank ${Math.round(i.car.fuel)}% · ${roughDistance(i.car.range)}</em>`
    }
    if (html !== this.goalHtml) {
      this.goalHtml = html
      this.goal.innerHTML = html
      this.shown.goal = this.goal.textContent ?? ""
    }
    this.goal.dataset.on = String(html !== "")
  }

  private drawCard(i: WayOutHudInput | null): void {
    const v = i?.view
    const won = Boolean(v?.won)
    if (!won) this.wonAt = null
    else this.wonAt ??= performance.now()
    const showing = won && performance.now() - (this.wonAt ?? 0) > CARD_DELAY_MS
    let html = ""
    if (showing && i && v) {
      const plan = i.plan
      const w = DESTINATION_WORDS[plan.kind]
      const squad = i.slots.length > 1
      const made = v.escaped.length
      const kills = Object.values(v.kills).reduce((a, b) => a + b, 0)
      const whoMade = squad ? `${made} of ${i.slots.length} survivors` : `${esc(i.name(i.localIndex))} made it out`
      const rows = squad
        ? `<div class="owo-squad">${i.slots
            .map((s) => {
              const out = v.escaped.includes(s.index)
              const rec = i.death?.records[s.index]
              const fate = out ? "Made it out" : rec?.state === "dead" ? causeText(rec) : "Left behind"
              return `<div data-out="${out}"><b>${esc(i.name(s.index))}</b><span>${esc(fate)} · ${v.kills[s.index] ?? 0} kills</span></div>`
            })
            .join("")}</div>`
        : ""
      const canFresh = Boolean(this.actions?.canFresh)
      html = `<div class="owo-card" role="dialog" aria-label="Escaped">
${placeArt(plan.kind)}
<span class="owo-eyebrow">Escaped</span>
<span class="owo-name">Escaped ${esc(w.by)} on Night ${v.wonNight}</span>
<span class="owo-sub">${whoMade}</span>
<div class="owo-stats"><div><span>Day</span><b>${v.wonNight + 1}</b></div><div><span>Nights</span><b>${v.wonNight}</b></div><div><span>Kills</span><b>${kills}</b></div><div><span>Time</span><b>${mmss(v.played)}</b></div></div>
${rows}
<div class="owo-actions"><button class="owo-primary" data-act="same">Restart</button><button data-act="fresh"${canFresh ? "" : " hidden"}>New town</button><button data-act="lobby">Lobby</button></div>
</div>`
    }
    if (html !== this.overHtml) {
      this.overHtml = html
      this.over.innerHTML = html
    }
    this.over.dataset.on = String(html !== "")
    this.shown.over = html !== ""
  }
}
