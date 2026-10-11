import { END_SECONDS, HEAD_START_SECONDS, INTRO_SECONDS } from "../../shared/config"
import type { City } from "../../shared/sim/city"
import type { CarView, SimEvent, WorldView } from "../../shared/sim/world"
import type { Camera } from "../game/camera"
import { attr, esc, flag, h, show, style, text } from "./dom"

export type HudContext = {
  myId: string
  cam: Camera
  width: number
  height: number
  dt: number
  events: SimEvent[]
  players: { id: string; name: string; human: boolean }[]
  room: string | null
  status: string
}

type Row = { id: string; name: string; human: boolean; best?: number; score?: number }

/** The parts of the world view the HUD reads. Survival fields are optional while the sim moves over to them. */
type HudView = Pick<WorldView, "t" | "round" | "phase" | "phaseT" | "robberId" | "bust" | "cars"> & {
  standings: Row[]
  survived?: number
  best?: number
  bestName?: string
  busted?: boolean
  escaped?: boolean
}

const RING_R = 38
const RING_C = 2 * Math.PI * RING_R

/** m:ss.t */
export function survival(sec: number) {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${m}:${r < 10 ? "0" : ""}${(Math.floor(r * 10) / 10).toFixed(1)}`
}

/** In-game DOM overlay. Owned by the HUD module; main.ts only calls update() each frame. */
export class Hud {
  private el: Record<string, HTMLElement> = {}
  private ringArc!: SVGCircleElement
  private round = -1
  private firstRound = true
  private startBest: number | undefined
  private resultsFor = -1

  constructor(
    readonly root: HTMLElement,
    readonly city: City,
  ) {
    root.classList.add("hud")
    this.build()
  }

  private build() {
    const r = this.root
    const e = this.el
    r.innerHTML = ""
    e.world = h("div", "h-world", r)
    e.ring = h(
      "div",
      "h-ring off",
      e.world,
      `<svg viewBox="0 0 100 100"><circle class="trk" cx="50" cy="50" r="${RING_R}"/><circle class="val" cx="50" cy="50" r="${RING_R}"/></svg><div class="ring-pct"></div>`,
    )
    this.ringArc = e.ring.querySelector(".val")!
    e.ringPct = e.ring.querySelector(".ring-pct")!
    e.tag = h("div", "h-tag off", e.world, `<span></span>`)
    e.tagName = e.tag.querySelector("span")!

    e.clock = h("div", "h-clock off", r, `<div class="c-label"></div><div class="c-time"></div><div class="c-best"></div>`)
    e.cLabel = e.clock.querySelector(".c-label")!
    e.cTime = e.clock.querySelector(".c-time")!
    e.cBest = e.clock.querySelector(".c-best")!

    e.intro = h("div", "h-intro off", r, `<div class="i-line"></div><div class="i-sub"></div>`)
    e.iLine = e.intro.querySelector(".i-line")!
    e.iSub = e.intro.querySelector(".i-sub")!
    e.keys = h("div", "h-keys off", r, "WASD drive · SPACE drift · SHIFT nitro")

    e.end = h("div", "h-end off", r)

    e.room = h("div", "h-room off", r, `<i class="dot"></i><span class="code"></span><button type="button">COPY INVITE</button>`)
    e.roomCode = e.room.querySelector(".code")!
    e.copy = e.room.querySelector("button")!
    e.copy.addEventListener("click", () => this.copyInvite())
  }

  private copyInvite() {
    const room = this.root.dataset.room
    if (!room) return
    const url = new URL(location.href)
    url.search = `?r=${room}`
    void navigator.clipboard?.writeText(url.toString()).then(
      () => {
        text(this.el.copy!, "COPIED")
        setTimeout(() => text(this.el.copy!, "COPY INVITE"), 1500)
      },
      () => {},
    )
  }

  update(world: WorldView, ctx: HudContext) {
    const view: HudView = world
    const e = this.el
    const isRobber = ctx.myId === view.robberId
    const robber = view.cars.find((c) => c.ownerId === view.robberId && !c.ghost)
    const ghost = view.cars.find((c) => c.ghost)
    const robberName = view.cars.find((c) => c.ownerId === view.robberId)?.name ?? view.standings.find((s) => s.id === view.robberId)?.name ?? "the suspect"
    const survived = view.survived ?? (view.phase === "chase" || view.phase === "end" ? Math.max(0, view.t - INTRO_SECONDS - HEAD_START_SECONDS) : 0)

    if (view.round !== this.round) {
      if (this.round >= 0) this.firstRound = false
      this.round = view.round
      this.startBest = view.best
      this.resultsFor = -1
    }
    attr(this.root, "class", `hud ${isRobber ? "role-robber" : "role-cop"} phase-${view.phase}`)

    // Survival clock.
    const chase = view.phase === "chase"
    show(e.clock!, chase)
    if (chase) {
      text(e.cLabel!, isRobber ? "FREE" : "SUSPECT AT LARGE")
      text(e.cTime!, survival(survived))
      const best = view.best ?? 0
      show(e.cBest!, best > 0)
      if (best > 0) text(e.cBest!, `BEST ${survival(best)}${view.bestName ? ` · ${view.bestName}` : ""}`)
      flag(e.clock!, "record", best > 0 && survived > best)
    }

    // Intro and head start: one line.
    const pre = view.phase === "intro" || view.phase === "headstart"
    show(e.intro!, pre)
    if (pre) {
      text(e.iLine!, isRobber ? "DON'T GET CAUGHT" : `CATCH ${robberName.toUpperCase()}`)
      const left = view.phase === "intro" ? INTRO_SECONDS - view.phaseT + HEAD_START_SECONDS : HEAD_START_SECONDS - view.phaseT
      text(e.iSub!, view.phase === "headstart" ? `${isRobber ? "COPS IN" : "YOU ROLL IN"} ${Math.max(1, Math.ceil(left))}` : "")
    }
    show(e.keys!, this.firstRound && pre)

    this.updateWorld(view, ctx, isRobber, robber, ghost)
    this.updateEnd(view, ctx, robberName, survived)

    if (ctx.room) this.root.dataset.room = ctx.room
    show(e.room!, !!ctx.room)
    if (ctx.room) {
      text(e.roomCode!, ctx.room)
      const st = ctx.status.toLowerCase()
      attr(e.room!, "data-status", /lost|error|closed|offline/.test(st) ? "bad" : /connecting|reconnect/.test(st) ? "pending" : "ok")
      attr(e.room!, "title", ctx.status)
    }
  }

  private updateWorld(view: HudView, ctx: HudContext, isRobber: boolean, robber: CarView | undefined, ghost: CarView | undefined) {
    const e = this.el
    const { cam, width: W, height: H } = ctx

    const busting = !!robber && view.bust > 0.005 && view.phase === "chase"
    show(e.ring!, busting)
    if (busting && robber) {
      const p = cam.project(robber.x, 0.6, robber.z, W, H)
      style(e.ring!, "transform", `translate3d(${p[0].toFixed(1)}px,${p[1].toFixed(1)}px,0)`)
      attr(this.ringArc, "stroke-dasharray", `${(RING_C * view.bust).toFixed(1)} ${RING_C}`)
      text(e.ringPct!, `${Math.round(view.bust * 100)}%`)
    }

    // Cops get a small tag over the suspect, or over the last sighting when out of view.
    const target = robber ?? ghost
    const tagOn = !isRobber && !!target && (view.phase === "chase" || view.phase === "headstart")
    show(e.tag!, tagOn)
    if (tagOn && target) {
      const p = cam.project(target.x, 2.4, target.z, W, H)
      show(e.tag!, p[2])
      style(e.tag!, "transform", `translate3d(${p[0].toFixed(1)}px,${(p[1] - (busting ? 50 : 22)).toFixed(1)}px,0)`)
      text(e.tagName!, target.ghost ? "LAST SEEN" : target.name)
      flag(e.tag!, "ghost", target.ghost)
    }
  }

  private updateEnd(view: HudView, ctx: HudContext, robberName: string, survived: number) {
    const e = this.el
    const on = view.phase === "end"
    show(e.end!, on)
    if (!on) return
    if (this.resultsFor !== view.round) {
      this.resultsFor = view.round
      const isRobber = ctx.myId === view.robberId
      const newBest = survived > 0 && (this.startBest === undefined || survived > this.startBest) && (view.best === undefined || survived >= view.best - 0.05)
      const title = view.escaped ? "GOT AWAY" : "BUSTED"
      const who = isRobber ? "YOU STAYED FREE FOR" : `${esc(robberName.toUpperCase())} STAYED FREE FOR`
      const rows = [...view.standings]
        .sort((a, b) => (b.best ?? b.score ?? 0) - (a.best ?? a.score ?? 0))
        .map((s) => `<li class="${s.id === ctx.myId ? "me" : ""}"><span>${esc(s.name)}</span><b>${s.best !== undefined ? (s.best > 0 ? survival(s.best) : "—") : Math.round(s.score ?? 0).toLocaleString("en-US")}</b></li>`)
        .join("")
      e.end!.innerHTML = `<div class="e-inner">
        <div class="e-title">${title}</div>
        <div class="e-who">${who}</div>
        <div class="e-time">${survival(survived)}</div>
        ${newBest ? `<div class="e-best">NEW BEST</div>` : ""}
        <ol class="e-rows">${rows}</ol>
        <div class="e-next">NEXT ROUND IN <b></b></div>
      </div>`
      e.endNext = e.end!.querySelector(".e-next b")!
    }
    text(e.endNext!, String(Math.max(0, Math.ceil(END_SECONDS - view.phaseT))))
  }
}
