import { END_SECONDS, FLAT_SECONDS, GADGETS, HEAD_START_SECONDS, INTRO_SECONDS } from "../../shared/config"
import type { City } from "../../shared/sim/city"
import { DRIVE } from "../../shared/sim/vehicle"
import type { CarView, SimEvent, WorldView } from "../../shared/sim/world"
import type { Camera } from "../game/camera"
import { attr, esc, flag, h, show, style, text } from "./dom"
import { Minimap } from "./minimap"

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
  heli?: WorldView["heli"]
  props?: WorldView["props"]
  standings: Row[]
  survived?: number
  best?: number
  bestName?: string
  newBest?: boolean
  busted?: boolean
  escaped?: boolean
}

const RING_R = 38
const RING_C = 2 * Math.PI * RING_R
const FLASH_SECONDS = 1.8

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
  private map!: Minimap
  private flashLeft = 0
  private pips: HTMLElement[] = []

  constructor(
    readonly root: HTMLElement,
    readonly city: City,
  ) {
    root.classList.add("hud")
    this.build()
    this.map = new Minimap(root, city)
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
    e.keys = h("div", "h-keys off", r, "WASD drive · SPACE drift · SHIFT nitro · H engine")

    e.flash = h("div", "h-flash off", r)
    e.gadget = h("div", "h-gadget off", r, `<div class="g-row"><span class="g-key">Q</span><span class="g-name"></span><span class="g-pips">${"<i></i>".repeat(GADGETS.spike.charges)}</span></div><div class="g-bar"><b></b></div>`)
    e.gName = e.gadget.querySelector(".g-name")!
    this.pips = [...e.gadget.querySelectorAll<HTMLElement>(".g-pips i")]
    e.gFill = e.gadget.querySelector(".g-bar b")!
    e.flat = h("div", "h-flat off", r, `<div class="f-line">FLAT TIRE</div><div class="g-bar"><b></b></div>`)
    e.fFill = e.flat.querySelector(".g-bar b")!

    e.end = h("div", "h-end off", r)

    e.wait = h(
      "div",
      "h-wait off",
      r,
      `<div class="w-line">WAITING FOR PLAYERS</div><div class="w-sub">The round starts when a second driver joins</div><div class="w-invite"><span>ROOM</span><b class="w-code"></b><button type="button">COPY INVITE LINK</button></div>`,
    )
    e.wCode = e.wait.querySelector(".w-code")!
    e.wCopy = e.wait.querySelector("button")!
    e.wCopy.addEventListener("click", () => this.copyInvite(e.wCopy!, "COPY INVITE LINK"))

    e.room = h("div", "h-room off", r, `<i class="dot"></i><span class="code"></span><button type="button">COPY INVITE</button>`)
    e.roomCode = e.room.querySelector(".code")!
    e.copy = e.room.querySelector("button")!
    e.copy.addEventListener("click", () => this.copyInvite(e.copy!, "COPY INVITE"))

    e.engine = h("div", "h-keys off", r)
    e.engine.style.cssText = "bottom: 8px; animation: none"
  }

  private copyInvite(btn: HTMLElement, label: string) {
    const room = this.root.dataset.room
    if (!room) return
    const url = new URL(location.href)
    url.search = `?r=${room}`
    void navigator.clipboard?.writeText(url.toString()).then(
      () => {
        text(btn, "LINK COPIED")
        setTimeout(() => text(btn, label), 1500)
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
    // "waiting" (fewer than two players) is newer than the Phase union in some builds of the sim.
    const phase: string = view.phase
    const waiting = phase === "waiting"
    attr(this.root, "class", `hud ${isRobber ? "role-robber" : "role-cop"} phase-${phase}`)
    show(e.wait!, waiting)
    if (waiting) text(e.wCode!, ctx.room ?? "—")

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

    this.updateGadgets(view, ctx, isRobber)
    const mine = view.cars.find((c) => c.ownerId === ctx.myId && !c.ghost)
    show(e.engine!, !!mine?.engineOff && !waiting && view.phase !== "end")
    if (mine?.engineOff) text(e.engine!, isRobber && mine.speed < DRIVE.darkSpeed ? "ENGINE OFF · DARK" : "ENGINE OFF")
    this.updateWorld(view, ctx, isRobber, robber, ghost)
    this.map.update(view, ctx.cam, ctx.myId, ctx.dt)
    this.updateEnd(view, ctx, robberName, survived)

    if (ctx.room) this.root.dataset.room = ctx.room
    show(e.room!, !!ctx.room && !waiting)
    if (ctx.room) {
      text(e.roomCode!, ctx.room)
      const st = ctx.status.toLowerCase()
      attr(e.room!, "data-status", /lost|error|closed|offline/.test(st) ? "bad" : /connecting|reconnect/.test(st) ? "pending" : "ok")
      attr(e.room!, "title", ctx.status)
    }
  }

  /** Cops: the spike strip hint. Driver: the flat tire bar. Both: a short flash when someone hits a strip. */
  private updateGadgets(view: HudView, ctx: HudContext, isRobber: boolean) {
    const e = this.el
    const me = view.cars.find((c) => c.ownerId === ctx.myId && !c.ghost)
    const live = view.phase === "intro" || view.phase === "headstart" || view.phase === "chase"

    const g = !isRobber && live ? me?.gadgets?.[0] : undefined
    show(e.gadget!, !!g)
    if (g) {
      const spec = GADGETS[g.id]
      text(e.gName!, spec.name)
      this.pips.forEach((pip, i) => flag(pip, "used", i >= g.charges))
      const fill = g.charges <= 0 ? 0 : g.cooldown > 0 ? 1 - g.cooldown / spec.cooldown : 1
      style(e.gFill!, "transform", `scaleX(${fill.toFixed(3)})`)
      flag(e.gadget!, "dim", !g.ready)
    }

    const flat = isRobber && live && me ? (me.flat ?? 0) : 0
    show(e.flat!, flat > 0)
    if (flat > 0) style(e.fFill!, "transform", `scaleX(${Math.min(1, flat / FLAT_SECONDS).toFixed(3)})`)

    const hit = ctx.events.find((ev) => ev.kind === "flat")
    if (hit && live) {
      this.flashLeft = FLASH_SECONDS
      text(e.flash!, isRobber ? "FLAT TIRE" : "SPIKED!")
      flag(e.flash!, "bad", isRobber)
    }
    this.flashLeft = live ? Math.max(0, this.flashLeft - ctx.dt) : 0
    show(e.flash!, this.flashLeft > 0)
    if (this.flashLeft > 0) style(e.flash!, "opacity", Math.min(1, this.flashLeft / 0.5, (FLASH_SECONDS - this.flashLeft) / 0.12).toFixed(3))
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
      const newBest = view.newBest ?? (survived > 0 && (this.startBest === undefined || survived > this.startBest) && (view.best === undefined || survived >= view.best - 0.05))
      const title = view.escaped ? "GOT AWAY" : "BUSTED"
      const who = isRobber ? "YOU STAYED FREE FOR" : `${esc(robberName.toUpperCase())} STAYED FREE FOR`
      const rows = [...view.standings]
        .sort((a, b) => (b.best ?? b.score ?? 0) - (a.best ?? a.score ?? 0))
        .map((s) => `<li class="${s.id === ctx.myId ? "me" : ""}"><span>${esc(s.name)}</span><b>${s.best !== undefined ? (s.best > 0 ? survival(s.best) : "—") : Math.round(s.score ?? 0).toLocaleString("en-US")}</b></li>`)
        .join("")
      e.end!.innerHTML = `<div class="e-inner">
        <div class="e-main">
          <div class="e-title">${title}</div>
          <div class="e-who">${who}</div>
          <div class="e-time">${survival(survived)}${newBest ? `<span class="e-best">NEW BEST</span>` : ""}</div>
        </div>
        <div class="e-side">
          <ol class="e-rows">${rows}</ol>
          <div class="e-next">NEXT ROUND IN <b></b></div>
        </div>
      </div>`
      e.endNext = e.end!.querySelector(".e-next b")!
    }
    text(e.endNext!, String(Math.max(0, Math.ceil(END_SECONDS - view.phaseT))))
  }
}
