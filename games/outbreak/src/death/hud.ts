import { keyCapHtml, keyPromptHtml } from "@arcade/kit/client/key-cap"
import { causeText, nightsText, RESPAWN_NEVER, type DeathState } from "../../shared/death/rules"
import { supportHeight } from "../../shared/terrain"
import type { OutbreakClientFrameContext } from "../feature-registry"
import "./death.css"
import { lifeIn, localSlot } from "./spectate"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const clock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.ceil(Math.max(0, s)) % 60).padStart(2, "0")}`
/** Revive markers show for downed teammates within this distance (m). */
const MARK_RANGE = 28
const CARD_DELAY_MS = 1400

/** What the run-over card offers; `fresh` asks for a new town (solo only). */
export type DeathHudActions = { restart(fresh: boolean): void; lobby(): void; canFresh: boolean }

/**
 * The death screens (AR-61): the down screen tightening and draining of colour as the bleed-out runs, "Down" markers
 * with a hold-E revive cap over downed teammates, the banner while watching a teammate, and the run-over card. DOM
 * over the canvas, rebuilt only when its text changes.
 */
export class DeathHud {
  private readonly shade: HTMLDivElement
  private readonly down: HTMLDivElement
  private readonly marks: HTMLDivElement
  private readonly watch: HTMLDivElement
  private readonly over: HTMLDivElement
  private readonly markEls = new Map<number, { el: HTMLDivElement; html: string }>()
  private downHtml = ""
  private watchHtml = ""
  private overHtml = ""
  /** When the run ended (ms, page clock): the card waits a beat so the death lands first. */
  private overAt: number | null = null
  actions: DeathHudActions | null = null
  /** Proof readout of what is on screen. */
  readonly shown = { down: false, dead: false, watching: null as string | null, marks: [] as number[], over: false }

  constructor(doc: Document = document) {
    const div = (cls: string) => {
      const el = doc.createElement("div")
      el.className = cls
      doc.body.append(el)
      return el
    }
    this.shade = div("obd-shade")
    this.down = div("obd-down")
    this.marks = div("obd-marks")
    this.watch = div("obd-watch")
    this.over = div("obd-over")
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

  update(ctx: OutbreakClientFrameContext, state: DeathState | undefined, watching: number | null, name: (index: number) => string): void {
    const { session, cam, w, h } = ctx
    const local = localSlot(session)
    const me = state?.records[local.index]
    const life = lifeIn(state, local.index)
    const t = state?.tuning
    const ended = Boolean(state?.runOver)
    if (!ended) this.overAt = null
    else this.overAt ??= performance.now()
    const over = ended && performance.now() - (this.overAt ?? 0) > CARD_DELAY_MS
    const shown = this.shown

    // Down: the screen closes in and greys as the bleed-out runs; the heartbeat quickens.
    const standing = session.sim.slots.some((s) => s.index !== local.index && lifeIn(state, s.index) === "alive")
    const bleedMax = t ? (standing ? t.bleedOut : t.soloBleedOut) : 1
    const left = me && life === "down" ? Math.max(0, Math.min(1, me.bleed / Math.max(0.1, bleedMax))) : 1
    const k = life === "down" ? 0.3 + (1 - left) * 0.7 : life === "dead" && !watching ? 1 : 0
    this.shade.dataset.on = String(life === "down")
    this.shade.dataset.dead = String(life === "dead" && watching === null && !over)
    this.shade.style.setProperty("--obd-k", k.toFixed(3))
    this.shade.style.setProperty("--obd-beat", `${(0.48 + 0.57 * left).toFixed(2)}s`)

    let downHtml = ""
    if (life === "down" && me && !over) {
      const reviving = me.revive > 0
      const sub = reviving
        ? `${esc(name(me.reviver))} is getting you up`
        : standing
          ? "Hold on. A teammate can get you up"
          : "Nobody is coming"
      downHtml = `<b>Down</b><span class="obd-sub">${sub} · ${clock(me.bleed)}</span><span class="obd-bar" style="--obd-left:${(reviving ? me.revive : left).toFixed(3)}"><i></i></span><span class="obd-sub">${keyCapHtml("KeyW")}${keyCapHtml("KeyA")}${keyCapHtml("KeyS")}${keyCapHtml("KeyD")} Crawl</span>`
      this.down.dataset.reviving = String(reviving)
    } else if (life === "dead" && watching === null && !over) {
      downHtml = `<b>Dead</b><span class="obd-sub">${me ? esc(causeText(me)) : ""}</span>`
    }
    if (downHtml !== this.downHtml) {
      this.downHtml = downHtml
      this.down.innerHTML = downHtml
    }
    this.down.dataset.on = String(downHtml !== "")
    shown.down = life === "down"
    shown.dead = life === "dead"

    // Watching a teammate until dawn.
    let watchHtml = ""
    if (life === "dead" && watching !== null && !over) {
      const back = t?.respawnRule === RESPAWN_NEVER ? "until the run ends" : "back at the safehouse at dawn"
      watchHtml = `You died · watching <b>${esc(name(watching))}</b> · ${back}`
    }
    if (watchHtml !== this.watchHtml) {
      this.watchHtml = watchHtml
      this.watch.innerHTML = watchHtml
    }
    this.watch.dataset.on = String(watchHtml !== "")
    shown.watching = watching === null ? null : name(watching)

    // Downed teammates: where they are, how long they have, and the hold-E cap that fills as you revive them.
    const seen = new Set<number>()
    const from = watching !== null ? session.sim.slots.find((s) => s.index === watching)?.survivor : local.survivor
    if (!over && from && t) {
      for (const s of session.sim.slots) {
        const rec = state?.records[s.index]
        if (s.index === local.index || rec?.state !== "down") continue
        const p = s.survivor
        const d = Math.hypot(p.x - from.x, p.y - from.y)
        if (d > MARK_RANGE) continue
        const proj = cam.project(p.x, supportHeight(session.view.town, p.x, p.y) + 0.9, p.y, w, h)
        if (!proj.ok) continue
        seen.add(s.index)
        let entry = this.markEls.get(s.index)
        if (!entry) {
          const el = document.createElement("div")
          el.className = "obd-mark"
          this.marks.append(el)
          this.markEls.set(s.index, (entry = { el, html: "" }))
        }
        const near = life === "alive" && d <= t.reviveRange + 0.2
        const prompt = life === "alive" ? keyPromptHtml("KeyE", "Revive", { hold: true, progress: rec.revive }) : ""
        const html = `<span class="obd-tag">Down<em>${esc(name(s.index))} · ${clock(rec.bleed)}</em></span>${prompt}`
        if (html !== entry.html) {
          entry.html = html
          entry.el.innerHTML = html
        }
        entry.el.dataset.far = String(!near)
        entry.el.style.transform = `translate(${proj.x.toFixed(1)}px, ${proj.y.toFixed(1)}px) translate(-50%, -100%)`
      }
    }
    for (const [index, entry] of this.markEls) {
      if (seen.has(index)) continue
      entry.el.remove()
      this.markEls.delete(index)
    }
    shown.marks = [...seen]

    // The run is over.
    let overHtml = ""
    if (over && state) {
      const mine = state.records[local.index]
      const squad = session.sim.slots.length > 1
      const kills = session.sim.slots.reduce((n, s) => n + (state.records[s.index]?.kills ?? 0), 0)
      const rows = squad
        ? `<div class="obd-squad">${session.sim.slots
            .map((s) => {
              const r = state.records[s.index]
              return `<div><b>${esc(name(s.index))}</b><span>${r ? esc(causeText(r)) : ""} · ${r?.kills ?? 0} kills</span></div>`
            })
            .join("")}</div>`
        : ""
      const canFresh = Boolean(this.actions?.canFresh)
      overHtml = `<div class="obd-card" role="dialog" aria-label="Run over">
<span class="obd-eyebrow">The run is over</span>
<span class="obd-name">${esc(name(local.index))}</span>
<span class="obd-cause">${mine ? esc(causeText(mine)) : ""}</span>
<div class="obd-stats"><div><span>Day</span><b>${state.dawns + 1}</b></div><div><span>Nights</span><b>${state.dawns}</b></div><div><span>Kills</span><b>${squad ? kills : (mine?.kills ?? 0)}</b></div></div>
<span class="obd-note">${nightsText(state.dawns)}${squad ? " as a squad" : ""}</span>
${rows}
<div class="obd-actions"><button class="obd-primary" data-act="same">Restart</button><button data-act="fresh"${canFresh ? "" : " hidden"}>New town</button><button data-act="lobby">Lobby</button></div>
</div>`
    }
    if (overHtml !== this.overHtml) {
      this.overHtml = overHtml
      this.over.innerHTML = overHtml
    }
    this.over.dataset.on = String(overHtml !== "")
    shown.over = overHtml !== ""
  }
}
