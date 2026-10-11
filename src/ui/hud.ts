import { END_SECONDS, GADGETS, HEAD_START_SECONDS, INTRO_SECONDS, VEHICLE_BY_ID, type GadgetId } from "../../shared/config"
import type { City } from "../../shared/sim/city"
import type { CarView, SimEvent, WorldView } from "../../shared/sim/world"
import type { Camera } from "../game/camera"
import { awardRound, levelOf, loadProfile, type XpAward } from "../game/profile"
import { STAR, attr, clock, distance, esc, flag, h, money, shortClock, show, style, text } from "./dom"
import { GADGET_ICONS, gadgetSlots } from "./gadgets"
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

const HELI_DELAY = 20
const SPEEDO_MAX = 220
const ARC = 270
const R_OUT = 62
const R_IN = 52
const C_OUT = 2 * Math.PI * R_OUT
const C_IN = 2 * Math.PI * R_IN
const RING_R = 46
const RING_C = 2 * Math.PI * RING_R

type Tone = "threat" | "cop" | "go" | "robber" | "neutral"
type Tag = { el: HTMLElement; name: HTMLElement; seen: number }
type Popup = { el: HTMLElement; carId: number; age: number; x: number; y: number }
type FeedItem = { t: number; kind: string; text: string; carId?: number }

const ICON_CASE = `<svg viewBox="0 0 32 32" fill="currentColor"><path d="M12 6h8a2 2 0 0 1 2 2v2h5a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2h5V8a2 2 0 0 1 2-2zm0 4h8V8h-8z"/><rect x="3" y="16" width="26" height="2" fill="#000" opacity=".35"/></svg>`
const ICON_CHEVRON = `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round"><path d="M7 17l9-9 9 9"/><path d="M7 26l9-9 9 9" opacity=".6"/></svg>`
const ICON_ALERT = `<svg viewBox="0 0 32 32"><path d="M16 3l14 25H2z" fill="currentColor"/><path d="M16 12v8M16 23.5v.5" stroke="#000" stroke-width="3" stroke-linecap="round"/></svg>`
const ICON_HELI = `<svg viewBox="0 0 40 24" fill="currentColor"><rect x="2" y="2" width="36" height="1.6" rx=".8"/><rect x="19" y="3" width="2" height="4"/><path d="M10 9h14c4 0 7 3 7 6s-3 5-7 5H14c-3 0-5-2-5-5z"/><path d="M30 13h8v2h-8z"/><rect x="12" y="21" width="16" height="1.6" rx=".8"/></svg>`

/** In-game DOM overlay. Owned by the HUD module; main.ts only calls update() each frame. */
export class Hud {
  private el: Record<string, HTMLElement> = {}
  private stars: HTMLElement[] = []
  private tags = new Map<number, Tag>()
  private popups: Popup[] = []
  private feed: FeedItem[] = []
  private feedDirty = false
  private bannerT = 0
  private toastT = 0
  private map: Minimap
  private round = -1
  private baseline = { score: 0, busts: 0 }
  private awards: string[] = []
  private awarded = -1
  private xp: XpAward | null = null
  private resultsFor = -1
  private help = false
  private frame = 0
  private firstRound = true
  private names = new Map<string, "robber" | "cop">()
  private speedArc!: SVGCircleElement
  private nitroArc!: SVGCircleElement
  private bustArc!: SVGCircleElement
  private extractArc!: SVGCircleElement
  private gadgetEls: { root: HTMLElement; icon: HTMLElement; name: HTMLElement; state: HTMLElement; pips: HTMLElement; ring: SVGCircleElement; id: string; pipKey: string }[] = []

  constructor(
    readonly root: HTMLElement,
    readonly city: City,
  ) {
    root.classList.add("hud")
    this.build()
    this.map = new Minimap(this.el.map!, city)
    addEventListener("keydown", (e) => {
      if (e.code !== "Escape" || e.target instanceof HTMLInputElement) return
      this.help = !this.help
      show(this.el.help!, this.help)
    })
  }

  private build() {
    const r = this.root
    const e = this.el
    r.innerHTML = ""

    // World-anchored layer: tags, bust ring, popups, edge markers.
    e.world = h("div", "h-world", r)
    e.bust = h("div", "h-ring bust off", e.world, `<svg viewBox="0 0 120 120"><circle class="trk" cx="60" cy="60" r="${RING_R}"/><circle class="val" cx="60" cy="60" r="${RING_R}"/></svg><div class="ring-pct"></div><div class="ring-label">BUSTING</div>`)
    this.bustArc = e.bust.querySelector(".val")!
    e.bustPct = e.bust.querySelector(".ring-pct")!
    e.bustLabel = e.bust.querySelector(".ring-label")!
    e.extract = h("div", "h-ring extract off", e.world, `<svg viewBox="0 0 120 120"><circle class="trk" cx="60" cy="60" r="${RING_R}"/><circle class="val" cx="60" cy="60" r="${RING_R}"/></svg><div class="ring-label">EXTRACTION</div>`)
    this.extractArc = e.extract.querySelector(".val")!
    e.extractLabel = e.extract.querySelector(".ring-label")!
    e.edge = h("div", "h-edge off", e.world, `<div class="edge-arrow">${ICON_CHEVRON}</div><div class="edge-label"></div>`)
    e.edgeArrow = e.edge.querySelector(".edge-arrow")!
    e.edgeLabel = e.edge.querySelector(".edge-label")!
    e.ghost = h("div", "h-ghost off", e.world, `<div class="ghost-ping"></div><div class="tag-name">LAST SEEN</div>`)
    e.ghostName = e.ghost.querySelector(".tag-name")!

    // Top-left: robber heat / cop suspect file.
    e.tl = h("div", "h-tl", r)
    e.heat = h("div", "panel heat for-robber", e.tl)
    const starRow = h("div", "stars", e.heat)
    for (let i = 0; i < 5; i++) this.stars.push(h("span", "star", starRow, STAR))
    const hb = h("div", "heat-bar", e.heat, `<div class="label">HEAT LEVEL</div><div class="bar"><i></i></div>`)
    e.heatFill = hb.querySelector("i")!
    e.chips = h("div", "chips for-robber", e.tl)
    e.chipSeen = h("div", "chip threat pulse off", e.chips, "SPOTTED")
    e.chipHidden = h("div", "chip dim off", e.chips, "OUT OF SIGHT")
    e.chipHeli = h("div", "chip off", e.chips, `${ICON_HELI}<span>HELI UP</span>`)
    e.chipHeliText = e.chipHeli.querySelector("span")!
    e.chipLock = h("div", "chip threat pulse off", e.chips, "LOCKED")
    e.chipFlat = h("div", "chip warn off", e.chips, "FLAT TIRE")
    e.chipSpin = h("div", "chip warn off", e.tl, "SPUN OUT")

    e.suspect = h("div", "panel suspect for-cop", e.tl)
    e.suspect.innerHTML = `<div class="panel-head"><span>SUSPECT</span><span class="sus-stars"></span></div>
      <div class="sus-name"></div><div class="sus-car"></div>
      <div class="kv"><span>LOOT AT STAKE</span><b class="sus-loot"></b></div>
      <div class="kv"><span>JOB</span><b class="sus-site"></b></div>
      <div class="sus-status"></div>`
    e.susName = e.suspect.querySelector(".sus-name")!
    e.susCar = e.suspect.querySelector(".sus-car")!
    e.susLoot = e.suspect.querySelector(".sus-loot")!
    e.susSite = e.suspect.querySelector(".sus-site")!
    e.susStars = e.suspect.querySelector(".sus-stars")!
    e.susStatus = e.suspect.querySelector(".sus-status")!

    // Top-center: clock or alarm.
    e.tc = h("div", "h-tc", r)
    e.clock = h("div", "clock", e.tc, `<div class="side l"><span>COPS</span><b class="c-cops"></b></div><div class="mid"><b class="c-time"></b><span class="c-phase"></span></div><div class="side r"><span>ROUND</span><b class="c-round"></b></div>`)
    e.cCops = e.clock.querySelector(".c-cops")!
    e.cTime = e.clock.querySelector(".c-time")!
    e.cPhase = e.clock.querySelector(".c-phase")!
    e.cRound = e.clock.querySelector(".c-round")!
    e.alarm = h("div", "alarm off", e.tc, `${ICON_ALERT}<span class="a-text">ALARM TRIGGERED — COPS INBOUND</span><b class="a-time"></b>`)
    e.alarmText = e.alarm.querySelector(".a-text")!
    e.alarmTime = e.alarm.querySelector(".a-time")!
    e.toast = h("div", "toast off", e.tc)
    e.dispatch = h("div", "dispatch-count off", r, `<span>DISPATCH IN</span><b></b>`)
    e.dispatchN = e.dispatch.querySelector("b")!
    e.role = h("div", "role-card off", r)

    // Top-right: room strip, loot and exit / air unit.
    e.tr = h("div", "h-tr", r)
    e.room = h("div", "room-strip", e.tr, `<span class="room-code"></span><button class="copy" type="button">COPY INVITE</button><span class="dot"></span><span class="room-status"></span><span class="room-count"></span><button class="help-btn" type="button" title="Help (Esc)">?</button>`)
    e.roomCode = e.room.querySelector(".room-code")!
    e.roomStatus = e.room.querySelector(".room-status")!
    e.roomCount = e.room.querySelector(".room-count")!
    e.copy = e.room.querySelector(".copy")!
    e.copy.addEventListener("click", () => this.copyInvite())
    e.room.querySelector(".help-btn")!.addEventListener("click", () => {
      this.help = !this.help
      show(this.el.help!, this.help)
    })
    e.loot = h("div", "panel loot for-robber", e.tr, `<span class="ic">${ICON_CASE}</span><b class="loot-v"></b>`)
    e.lootV = e.loot.querySelector(".loot-v")!
    e.exit = h("div", "exit for-robber", e.tr, `<div class="exit-arrow">${ICON_CHEVRON}</div><div class="exit-text"><span>EXTRACTION</span><b class="exit-d"></b><em class="exit-n"></em></div>`)
    e.exitArrow = e.exit.querySelector(".exit-arrow")!
    e.exitD = e.exit.querySelector(".exit-d")!
    e.exitN = e.exit.querySelector(".exit-n")!
    e.air = h("div", "panel air for-cop", e.tr, `<div class="panel-head"><span>AIR UNIT</span><span class="ic">${ICON_HELI}</span></div><div class="air-state"></div><div class="bar air-bar"><i></i></div><div class="air-sub"></div>`)
    e.airState = e.air.querySelector(".air-state")!
    e.airFill = e.air.querySelector("i")!
    e.airSub = e.air.querySelector(".air-sub")!
    e.feed = h("div", "feed", e.tr)

    // Banner.
    e.banner = h("div", "banner off", r, `<div class="b-title"></div><div class="b-sub"></div>`)
    e.bTitle = e.banner.querySelector(".b-title")!
    e.bSub = e.banner.querySelector(".b-sub")!

    // Bottom-left minimap.
    e.map = h("div", "h-map", r)
    h("div", "map-legend", e.map, `<span><i class="me"></i>YOU</span><span><i class="cop"></i>COPS</span><span><i class="rob"></i>ROBBER</span><span class="lg-exit"><i class="exit"></i>EXIT</span>`)

    // Bottom-right dash.
    e.dash = h("div", "h-dash", r)
    e.gadgets = h("div", "gadgets", e.dash)
    for (const key of ["Q", "E"]) {
      const g = h("div", "gadget", e.gadgets)
      g.innerHTML = `<div class="g-box"><svg class="g-ring" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28"/></svg><kbd>${key}</kbd><div class="g-icon"></div><div class="g-cd"></div><div class="g-pips"></div></div><div class="g-name"></div>`
      this.gadgetEls.push({ root: g, icon: g.querySelector(".g-icon")!, name: g.querySelector(".g-name")!, state: g.querySelector(".g-cd")!, pips: g.querySelector(".g-pips")!, ring: g.querySelector(".g-ring circle")!, id: "", pipKey: "" })
    }
    const ticks: string[] = []
    for (let i = 0; i <= 11; i++) {
      const a = ((-225 + (i / 11) * ARC) * Math.PI) / 180
      const r0 = i % 2 ? 66 : 64
      ticks.push(`<line x1="${80 + Math.cos(a) * r0}" y1="${80 + Math.sin(a) * r0}" x2="${80 + Math.cos(a) * 71}" y2="${80 + Math.sin(a) * 71}"/>`)
    }
    e.speedo = h(
      "div",
      "speedo",
      e.dash,
      `<svg viewBox="0 0 160 160"><circle class="bg" cx="80" cy="80" r="76"/><g class="ticks">${ticks.join("")}</g>
      <circle class="trk" cx="80" cy="80" r="${R_OUT}" transform="rotate(135 80 80)" stroke-dasharray="${(C_OUT * ARC) / 360} ${C_OUT}"/>
      <circle class="redline" cx="80" cy="80" r="${R_OUT}" transform="rotate(${135 + ARC * 0.8} 80 80)" stroke-dasharray="${(C_OUT * ARC * 0.2) / 360} ${C_OUT}"/>
      <circle class="spd" cx="80" cy="80" r="${R_OUT}" transform="rotate(135 80 80)"/>
      <circle class="trk thin" cx="80" cy="80" r="${R_IN}" transform="rotate(135 80 80)" stroke-dasharray="${(C_IN * ARC) / 360} ${C_IN}"/>
      <circle class="nit" cx="80" cy="80" r="${R_IN}" transform="rotate(135 80 80)"/></svg>
      <div class="sp-v"></div><div class="sp-u">KM/H</div><div class="sp-g"></div>`,
    )
    this.speedArc = e.speedo.querySelector(".spd")!
    this.nitroArc = e.speedo.querySelector(".nit")!
    e.spV = e.speedo.querySelector(".sp-v")!
    e.spG = e.speedo.querySelector(".sp-g")!
    e.bars = h("div", "bars", e.dash, `<div class="b"><span>NITRO <kbd>SHIFT</kbd></span><div class="bar nitro"><i></i></div></div><div class="b hull"><span>HULL</span><div class="bar"><i></i></div></div>`)
    e.nitroFill = e.bars.querySelector(".nitro i")!
    e.hull = e.bars.querySelector(".hull")!
    e.hullFill = e.hull.querySelector("i")!

    // Controls hint, help and results.
    e.hint = h(
      "div",
      "hint off",
      e.tl,
      `<div class="hint-head">CONTROLS</div><span><b><kbd>W</kbd><kbd>S</kbd></b>Throttle / reverse</span><span><b><kbd>A</kbd><kbd>D</kbd></b>Steer</span><span><b><kbd>SPACE</kbd></b>Handbrake</span><span><b><kbd>SHIFT</kbd></b>Nitro</span><span><b><kbd>Q</kbd><kbd>E</kbd></b>Gadgets</span><span><b><kbd>ESC</kbd></b>Help</span>`,
    )
    e.help = h("div", "help off", r)
    e.help.innerHTML = `<div class="help-card">
      <div class="help-head"><b>HOW IT WORKS</b><button type="button" class="help-x">ESC</button></div>
      <div class="help-cols">
        <div><h4 class="t-robber">GETAWAY DRIVER</h4><p>The job is done. Reach the extraction point shown on your map and hold inside the green zone under 60 km/h for three seconds.</p><p>Cops only see you within 70 m. Lose them, stay out of the helicopter's spotlight, and keep moving: get boxed in at low speed and the bust meter fills.</p><p>Drift and near misses add to your score. Heat rises with time and close calls, and every star past two brings a backup unit.</p></div>
        <div><h4 class="t-cop">COPS</h4><p>Box the suspect in and keep them under 25 km/h. Two cars bust in four seconds; one car works if you pin them against a wall.</p><p>When you lose sight, the map shows the last-seen ping. The air unit lifts off twenty seconds into the chase and sweeps its spotlight over the area.</p><p>Hold them until the clock runs out and the district seals.</p></div>
        <div><h4>CONTROLS</h4><ul class="keys"><li><kbd>W</kbd><kbd>S</kbd> Throttle / reverse</li><li><kbd>A</kbd><kbd>D</kbd> Steer</li><li><kbd>SPACE</kbd> Handbrake</li><li><kbd>SHIFT</kbd> Nitro</li><li><kbd>Q</kbd> <kbd>E</kbd> Gadgets</li><li><kbd>ESC</kbd> This panel</li></ul></div>
      </div></div>`
    e.help.querySelector(".help-x")!.addEventListener("click", () => {
      this.help = false
      show(this.el.help!, false)
    })
    e.results = h("div", "results off", r)
  }

  private copyInvite() {
    const room = this.root.dataset.room
    if (!room) return
    const url = new URL(location.href)
    url.search = `?r=${room}`
    void navigator.clipboard?.writeText(url.toString()).then(
      () => {
        text(this.el.copy!, "LINK COPIED")
        setTimeout(() => text(this.el.copy!, "COPY INVITE"), 1600)
      },
      () => {},
    )
  }

  update(view: WorldView, ctx: HudContext) {
    const e = this.el
    const isRobber = ctx.myId === view.robberId
    const mine = view.cars.find((c) => c.ownerId === ctx.myId && !c.ghost)
    const robberCar = view.cars.find((c) => c.ownerId === view.robberId && !c.ghost)
    const ghost = view.cars.find((c) => c.ghost)
    const focus = (view.phase === "intro" ? robberCar : mine) ?? robberCar ?? view.cars[0] ?? null
    const robberVisible = !!robberCar

    if (view.round !== this.round) this.newRound(view, ctx)
    for (const c of view.cars) this.names.set(c.name, c.role)
    for (const ev of ctx.events) this.onEvent(ev, view, isRobber)

    attr(this.root, "class", `hud ${isRobber ? "role-robber" : "role-cop"} phase-${view.phase}${mine ? "" : " spectating"}`)

    this.updateTop(view, ctx, isRobber, robberCar)
    this.updateWorld(view, ctx, isRobber, robberCar, ghost, mine)
    this.updateDash(mine, isRobber)
    this.updateRoom(ctx)
    this.updateTimers(ctx.dt)
    if (this.feedDirty) this.renderFeed(view)
    this.map.draw(view, ctx.cam, focus, ctx.myId, robberVisible)
    this.updateEnd(view, ctx, isRobber, mine)
  }

  private newRound(view: WorldView, ctx: HudContext) {
    if (this.round >= 0) this.firstRound = false
    this.round = view.round
    this.awards = []
    this.xp = null
    const me = view.standings.find((s) => s.id === ctx.myId)
    this.baseline = { score: me?.score ?? 0, busts: me?.busts ?? 0 }
    show(this.el.results!, false)
    this.resultsFor = -1
  }

  private onEvent(ev: SimEvent, view: WorldView, isRobber: boolean) {
    const robberName = view.cars.find((c) => c.ownerId === view.robberId)?.name ?? "Suspect"
    switch (ev.kind) {
      case "round":
        break
      case "go":
        if (isRobber) this.banner("DRIVE", `Cops roll in ${HEAD_START_SECONDS} seconds`, "robber", 1.8)
        break
      case "dispatch":
        if (view.phase === "chase" && view.phaseT < 1) {
          if (isRobber) this.banner("COPS INBOUND", `Lose them. Get to the ${view.exit.name}.`, "threat")
          else this.banner("PURSUE", `${robberName} has a head start. Follow the ping.`, "cop")
        } else this.toast("BACKUP UNIT INBOUND", isRobber ? "threat" : "cop")
        break
      case "heli":
        this.banner("AIR UNIT UP", isRobber ? "Stay out of the spotlight" : "Spotlight sweeping the last-seen area", isRobber ? "threat" : "cop", 2.2)
        break
      case "near": {
        if (ev.carId !== undefined) this.popup(ev.carId, ev.text)
        break
      }
      case "bust":
        this.banner("SUSPECT BUSTED", ev.text, "cop", 3.2)
        break
      case "extract":
        this.banner("CLEAN GETAWAY", ev.text, "go", 3.2)
        break
      case "end":
        if (ev.text === "TIME'S UP") this.banner("TIME'S UP", "Roadblocks sealed the district", isRobber ? "threat" : "cop", 3.2)
        break
      case "award":
        this.awards.push(ev.text)
        break
      case "exit":
        if (isRobber) this.banner("EXTRACTION OPEN", ev.text, "go", 2.4)
        break
      case "flat":
        if (isRobber) this.banner("FLAT TIRE", "Spike strip. Keep it steady.", "threat", 1.8)
        else this.toast(ev.text.toUpperCase(), "cop")
        break
      case "gadget":
      case "spinout": {
        const car = view.cars.find((c) => c.id === ev.carId)
        if (ev.kind === "spinout" && car && ev.carId !== undefined) this.popup(ev.carId, "SPUN OUT", "cop")
        break
      }
      default: {
        const car = view.cars.find((c) => c.id === ev.carId)
        this.toast(ev.text.toUpperCase(), car?.role === "cop" ? "cop" : car?.role === "robber" ? "robber" : "neutral")
      }
    }
    const dupe = ev.kind === "award" || ev.kind === "near" || (ev.kind === "end" && ev.text === ev.text.toUpperCase())
    if (!dupe) {
      this.feed.push(ev)
      if (this.feed.length > 5) this.feed.shift()
      this.feedDirty = true
    }
  }

  private banner(title: string, sub: string, tone: Tone, secs = 2.6) {
    const b = this.el.banner!
    text(this.el.bTitle!, title)
    text(this.el.bSub!, sub)
    b.className = `banner tone-${tone}`
    void b.offsetWidth
    b.classList.add("in")
    this.bannerT = secs
  }

  private toast(msg: string, tone: Tone) {
    const t = this.el.toast!
    text(t, msg)
    t.className = `toast tone-${tone}`
    void t.offsetWidth
    t.classList.add("in")
    this.toastT = 2.4
  }

  private popup(carId: number, msg: string, tone: Tone = "robber") {
    const el = h("div", `popup tone-${tone}`, this.el.world!)
    const m = /^(.*?)(\s*\+\d+)$/.exec(msg)
    el.innerHTML = m ? `${esc(m[1]!)}<b>${esc(m[2]!.trim())}</b>` : esc(msg)
    this.popups.push({ el, carId, age: 0, x: -999, y: -999 })
  }

  private updateTimers(dt: number) {
    if (this.bannerT > 0) {
      this.bannerT -= dt
      if (this.bannerT <= 0) this.el.banner!.classList.remove("in")
    }
    if (this.toastT > 0) {
      this.toastT -= dt
      if (this.toastT <= 0) this.el.toast!.classList.remove("in")
    }
  }

  private updateTop(view: WorldView, ctx: HudContext, isRobber: boolean, robberCar: CarView | undefined) {
    const e = this.el
    // Heat.
    for (let i = 0; i < 5; i++) flag(this.stars[i]!, "lit", i < view.stars)
    const heatFrac = view.stars >= 5 ? 1 : (view.heat % 25) / 25
    style(e.heatFill!, "transform", `scaleX(${heatFrac.toFixed(3)})`)
    const chase = view.phase === "chase"
    show(e.chipSeen!, chase && view.seen && view.heli.lock <= 0)
    show(e.chipHidden!, chase && !view.seen)
    show(e.chipHeli!, view.heli.active && view.heli.lock <= 0)
    show(e.chipLock!, view.heli.lock > 0)
    if (view.heli.lock > 0) text(e.chipLock!, `HELI LOCKED ${view.heli.lock.toFixed(1)}s`)
    const self = view.cars.find((c) => c.ownerId === ctx.myId && !c.ghost)
    show(e.chipFlat!, (self?.flat ?? 0) > 0)
    if ((self?.flat ?? 0) > 0) text(e.chipFlat!, `FLAT TIRE ${Math.ceil(self!.flat!)}s`)
    show(e.chipSpin!, (self?.slip ?? 0) > 0 || (self?.stun ?? 0) > 0.15)
    text(e.chipSpin!, (self?.slip ?? 0) > 0 ? "SPUN OUT" : "STUNNED")

    // Suspect file.
    const robberAny = view.cars.find((c) => c.ownerId === view.robberId)
    text(e.susName!, robberAny?.name ?? "Unknown")
    text(e.susCar!, VEHICLE_BY_ID.get(robberAny?.vehicle ?? "")?.name.toUpperCase() ?? "")
    text(e.susLoot!, money(view.loot))
    text(e.susSite!, view.site.name)
    text(e.susStars!, "★".repeat(view.stars) + "☆".repeat(5 - view.stars))
    if (view.phase === "intro" || view.phase === "headstart") {
      text(e.susStatus!, "FLEEING THE SCENE")
      attr(e.susStatus!, "class", "sus-status warn")
    } else if (robberCar && (view.seen || view.phase === "end")) {
      text(e.susStatus!, view.phase === "end" ? (view.escaped ? "ESCAPED" : "IN CUSTODY") : "SUSPECT IN SIGHT")
      attr(e.susStatus!, "class", `sus-status ${view.phase === "end" ? "" : "threat pulse"}`)
    } else {
      text(e.susStatus!, view.lastSeen ? `LAST SEEN ${shortClock(view.t - view.lastSeen.t)}` : "NO VISUAL")
      attr(e.susStatus!, "class", "sus-status warn")
    }

    // Clock.
    const copsCount = view.cars.filter((c) => c.role === "cop").length
    text(e.cCops!, String(copsCount))
    text(e.cRound!, String(view.round + 1))
    let time = view.timeLeft
    let phase = "PURSUIT"
    if (view.phase === "intro") phase = "THE JOB"
    else if (view.phase === "headstart") phase = "HEAD START"
    else if (view.phase === "end") {
      phase = "ROUND OVER"
      time = Math.max(0, END_SECONDS - view.phaseT)
    } else if (view.timeLeft < 30) phase = "FINAL SECONDS"
    else if (view.timeLeft < 60) phase = "FINAL MINUTE"
    text(e.cTime!, clock(Math.ceil(time)))
    text(e.cPhase!, phase)
    flag(e.clock!, "hot", view.phase === "chase" && view.timeLeft < 30)

    // Alarm (robber, before the cops roll).
    const preChase = view.phase === "intro" || view.phase === "headstart"
    const untilCops = view.phase === "intro" ? INTRO_SECONDS - view.phaseT + HEAD_START_SECONDS : HEAD_START_SECONDS - view.phaseT
    show(e.alarm!, isRobber && preChase)
    show(e.clock!, !(isRobber && preChase))
    if (isRobber && preChase) text(e.alarmTime!, shortClock(Math.ceil(untilCops)))

    // Cop countdown.
    const dispatching = !isRobber && view.phase === "headstart"
    show(e.dispatch!, dispatching)
    if (dispatching) text(e.dispatchN!, String(Math.max(1, Math.ceil(HEAD_START_SECONDS - view.phaseT))))

    // Role card.
    show(e.role!, view.phase === "intro")
    if (view.phase === "intro") {
      const key = `${view.round}:${isRobber}`
      if (e.role!.dataset.key !== key) {
        e.role!.dataset.key = key
        const rName = robberAny?.name ?? "The suspect"
        e.role!.className = `role-card ${isRobber ? "t-robber" : "t-cop"}`
        e.role!.innerHTML = isRobber
          ? `<div class="rc-kicker">ROUND ${view.round + 1} · ${esc(view.site.name.toUpperCase())} · ${money(view.loot)}</div><div class="rc-title">YOU ARE THE GETAWAY DRIVER</div><div class="rc-body">Reach the <b class="t-go">${esc(view.exit.name)}</b>. Hold in the green zone.</div>`
          : `<div class="rc-kicker">ROUND ${view.round + 1} · ALL UNITS</div><div class="rc-title">YOU ARE A COP</div><div class="rc-body"><b class="t-robber">${esc(rName)}</b> hit ${esc(view.site.name)}. Box them in to bust.</div>`
        if (!this.firstRound) e.role!.classList.add("compact")
      }
    }

    // Hint on the first round until the chase is underway.
    show(e.hint!, this.firstRound && (view.phase !== "end" && (view.phase !== "chase" || view.phaseT < 12)))

    // Robber: loot and exit direction.
    text(e.lootV!, money(view.loot))
    const me = view.cars.find((c) => c.ownerId === ctx.myId && !c.ghost)
    if (isRobber && me) {
      const d = Math.hypot(view.exit.x - me.x, view.exit.z - me.z)
      const opensIn = view.exitOpenIn ?? 0
      text(e.exitD!, distance(d))
      text(e.exitN!, opensIn > 0 && view.phase !== "end" ? `${view.exit.name} · OPENS ${shortClock(Math.ceil(opensIn))}` : view.exit.name)
      flag(e.exit!, "closed", opensIn > 0 && view.phase !== "end")
      const a = this.screenAngle(ctx, me.x, me.z, view.exit.x, view.exit.z)
      style(e.exitArrow!, "transform", `rotate(${(a + 90).toFixed(1)}deg)`)
    }

    // Cop: air unit.
    const heli = view.heli
    if (!heli.active) {
      const left = view.phase === "chase" ? Math.max(0, HELI_DELAY - view.phaseT) : HELI_DELAY
      text(e.airState!, "GROUNDED")
      text(e.airSub!, view.phase === "chase" ? `Lift-off in ${shortClock(Math.ceil(left))}` : "On the pad")
      style(e.airFill!, "transform", `scaleX(${(1 - left / HELI_DELAY).toFixed(3)})`)
      attr(e.air!, "class", "panel air for-cop")
    } else if (heli.lock > 0) {
      text(e.airState!, `SUSPECT LOCKED ${Math.floor(heli.lock)}s`)
      text(e.airSub!, "Spotlight on target. Converge.")
      style(e.airFill!, "transform", "scaleX(1)")
      attr(e.air!, "class", "panel air for-cop locked")
    } else {
      text(e.airState!, "SWEEPING")
      text(e.airSub!, view.seen ? "Suspect in sight of ground units" : "Searching the last-seen area")
      style(e.airFill!, "transform", "scaleX(1)")
      attr(e.air!, "class", "panel air for-cop sweeping")
    }
  }

  /** Screen-space angle in degrees (0 = right, 90 = down) from one ground point to another. */
  private screenAngle(ctx: HudContext, x0: number, z0: number, x1: number, z1: number) {
    const a = ctx.cam.project(x0, 0, z0, ctx.width, ctx.height)
    const b = ctx.cam.project(x1, 0, z1, ctx.width, ctx.height)
    if (a[2] && b[2]) return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI
    const { fwd, right } = ctx.cam.axes()
    const dx = x1 - x0
    const dz = z1 - z0
    return (Math.atan2(-(dx * fwd[0] + dz * fwd[1]), dx * right[0] + dz * right[1]) * 180) / Math.PI
  }

  private updateWorld(view: WorldView, ctx: HudContext, isRobber: boolean, robberCar: CarView | undefined, ghost: CarView | undefined, mine: CarView | undefined) {
    const e = this.el
    const W = ctx.width
    const H = ctx.height
    const cam = ctx.cam
    const frame = ++this.frame

    // Name tags.
    for (const c of view.cars) {
      if (c.ghost) continue
      const p = cam.project(c.x, 2.4, c.z, W, H)
      if (!p[2] || p[0] < -60 || p[0] > W + 60 || p[1] < -40 || p[1] > H + 40) continue
      let tag = this.tags.get(c.id)
      if (!tag) {
        const el = h("div", "tag", e.world!)
        const name = h("span", "tag-name", el)
        tag = { el, name, seen: frame }
        this.tags.set(c.id, tag)
      }
      tag.seen = frame
      const isMe = c.ownerId === ctx.myId
      const robber = c.ownerId === view.robberId
      text(tag.name, isMe ? "YOU" : c.name)
      attr(tag.el, "class", `tag ${robber ? "t-robber" : "t-cop"}${isMe ? " me" : ""}${c.stun > 0 ? " stun" : ""}`)
      const lift = robber && view.bust > 0.005 && view.phase !== "intro" ? 52 : 26
      style(tag.el, "transform", `translate3d(${p[0].toFixed(1)}px,${(p[1] - lift).toFixed(1)}px,0)`)
    }
    for (const [id, tag] of this.tags) {
      if (tag.seen === frame) continue
      if (frame - tag.seen > 120) {
        tag.el.remove()
        this.tags.delete(id)
      } else show(tag.el, false)
    }
    for (const tag of this.tags.values()) if (tag.seen === frame) show(tag.el, true)

    // Last-seen ghost.
    const ghostOn = !!ghost && view.phase === "chase"
    show(e.ghost!, ghostOn)
    if (ghost && ghostOn) {
      const p = cam.project(ghost.x, 0.5, ghost.z, W, H)
      show(e.ghost!, p[2])
      style(e.ghost!, "transform", `translate3d(${p[0].toFixed(1)}px,${p[1].toFixed(1)}px,0)`)
      text(e.ghostName!, view.lastSeen ? `LAST SEEN ${shortClock(view.t - view.lastSeen.t)}` : "LAST SEEN")
    }

    // Bust ring over the robber.
    const busting = !!robberCar && view.bust > 0.005 && view.phase !== "intro"
    show(e.bust!, busting)
    if (busting && robberCar) {
      const p = cam.project(robberCar.x, 0.6, robberCar.z, W, H)
      style(e.bust!, "transform", `translate3d(${p[0].toFixed(1)}px,${p[1].toFixed(1)}px,0)`)
      attr(this.bustArc, "stroke-dasharray", `${(RING_C * view.bust).toFixed(1)} ${RING_C}`)
      const pct = Math.round(view.bust * 100)
      text(e.bustPct!, `${pct}%`)
      text(e.bustLabel!, view.busted ? "BUSTED" : `BUSTING ${pct}%`)
      flag(e.bust!, "boxed", view.boxed)
    }

    // Extraction ring and off-screen marker for the robber; last-seen edge marker for cops.
    const exitKnown = isRobber || view.phase === "end"
    const ep = cam.project(view.exit.x, 0.3, view.exit.z, W, H)
    const exitOn = exitKnown && ep[2] && ep[0] > 40 && ep[0] < W - 40 && ep[1] > 60 && ep[1] < H - 40
    show(e.extract!, exitKnown && !!exitOn && view.phase !== "intro" || (view.extract > 0 && !!exitOn && robberCar !== undefined))
    if (exitOn) {
      style(e.extract!, "transform", `translate3d(${ep[0].toFixed(1)}px,${ep[1].toFixed(1)}px,0)`)
      attr(this.extractArc, "stroke-dasharray", `${(RING_C * view.extract).toFixed(1)} ${RING_C}`)
      const opensIn = view.phase === "end" ? 0 : (view.exitOpenIn ?? 0)
      text(e.extractLabel!, view.extract > 0 ? `EXTRACTING ${Math.round(view.extract * 100)}%` : opensIn > 0 ? `${view.exit.name.toUpperCase()} · OPENS ${shortClock(Math.ceil(opensIn))}` : view.exit.name.toUpperCase())
      flag(e.extract!, "active", view.extract > 0)
      flag(e.extract!, "closed", opensIn > 0)
    }
    let edgeTarget: { x: number; z: number; label: string; tone: string } | null = null
    if (isRobber && !exitOn && view.phase !== "end" && view.phase !== "intro" && mine) edgeTarget = { x: view.exit.x, z: view.exit.z, label: distance(Math.hypot(view.exit.x - mine.x, view.exit.z - mine.z)), tone: "go" }
    else if (!isRobber && ghost && view.phase === "chase") {
      const gp = cam.project(ghost.x, 0.3, ghost.z, W, H)
      const on = gp[2] && gp[0] > 40 && gp[0] < W - 40 && gp[1] > 60 && gp[1] < H - 40
      if (!on) edgeTarget = { x: ghost.x, z: ghost.z, label: "LAST SEEN", tone: "threat" }
    }
    show(e.edge!, !!edgeTarget)
    if (edgeTarget) {
      // Ride an ellipse around the screen center so the marker never lands under the corner panels or the clock.
      const ang = (this.screenAngle(ctx, ctx.cam.fx, ctx.cam.fz, edgeTarget.x, edgeTarget.z) * Math.PI) / 180
      const rx = Math.max(160, W / 2 - 330)
      const ry = Math.max(120, H / 2 - 190)
      style(e.edge!, "transform", `translate3d(${(W / 2 + Math.cos(ang) * rx).toFixed(1)}px,${(H / 2 + Math.sin(ang) * ry).toFixed(1)}px,0)`)
      style(e.edgeArrow!, "transform", `rotate(${((ang * 180) / Math.PI + 90).toFixed(1)}deg)`)
      text(e.edgeLabel!, edgeTarget.label)
      attr(e.edge!, "class", `h-edge tone-${edgeTarget.tone}`)
    }

    // Near-miss popups float up from the car that earned them.
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i]!
      p.age += ctx.dt
      const car = view.cars.find((c) => c.id === p.carId && !c.ghost)
      if (car) {
        const s = cam.project(car.x, 2.4, car.z, W, H)
        if (s[2]) {
          p.x = s[0]
          p.y = s[1]
        }
      }
      if (p.age > 1.4 || p.x < -500) {
        p.el.remove()
        this.popups.splice(i, 1)
        continue
      }
      style(p.el, "transform", `translate3d(${p.x.toFixed(1)}px,${(p.y - 72 - p.age * 34).toFixed(1)}px,0)`)
      style(p.el, "opacity", String(Math.min(1, (1.4 - p.age) * 3).toFixed(2)))
    }
  }

  private updateDash(mine: CarView | undefined, isRobber: boolean) {
    const e = this.el
    show(e.dash!, !!mine)
    if (!mine) return
    const kmh = mine.speed * 3.6
    text(e.spV!, String(Math.round(kmh)))
    const fwd = mine.vx * Math.sin(mine.h) + mine.vz * Math.cos(mine.h)
    text(e.spG!, mine.speed < 0.6 ? "N" : fwd < -0.5 ? "R" : "D")
    const sf = Math.min(1, kmh / SPEEDO_MAX)
    attr(this.speedArc, "stroke-dasharray", `${((C_OUT * ARC * sf) / 360).toFixed(1)} ${C_OUT}`)
    attr(this.nitroArc, "stroke-dasharray", `${((C_IN * ARC * mine.boost) / 360).toFixed(1)} ${C_IN}`)
    flag(e.speedo!, "redline", sf > 0.8)
    style(e.nitroFill!, "transform", `scaleX(${mine.boost.toFixed(3)})`)
    flag(e.bars!, "low", mine.boost < 0.2)
    const hp = (mine as unknown as { hp?: number }).hp
    show(e.hull!, typeof hp === "number")
    if (typeof hp === "number") {
      const max = VEHICLE_BY_ID.get(mine.vehicle)?.hp ?? 100
      const frac = Math.max(0, Math.min(1, hp > 1.001 ? hp / max : hp))
      style(e.hullFill!, "transform", `scaleX(${frac.toFixed(3)})`)
      flag(e.hull!, "low", frac < 0.3)
    }

    const slots = gadgetSlots(mine, isRobber ? "robber" : "cop")
    slots.forEach((s, i) => {
      const g = this.gadgetEls[i]
      if (!g) return
      if (g.id !== s.id) {
        g.id = s.id
        g.icon.innerHTML = GADGET_ICONS[s.id] ?? ""
      }
      text(g.name, s.name.toUpperCase())
      const max = GADGETS[s.id as GadgetId]?.charges ?? s.charges
      const pipKey = `${s.charges}/${max}`
      if (g.pipKey !== pipKey) {
        g.pipKey = pipKey
        g.pips.innerHTML = Array.from({ length: max }, (_, k) => `<i class="${k < s.charges ? "on" : ""}"></i>`).join("")
      }
      const cooling = s.live && s.seconds > 0 && s.charges > 0
      text(g.state, cooling ? String(Math.ceil(s.seconds)) : s.live && s.charges <= 0 ? "EMPTY" : "")
      flag(g.root, "ready", s.live && s.ready)
      flag(g.root, "cooling", cooling)
      flag(g.root, "empty", s.live && s.charges <= 0)
      flag(g.root, "pending", !s.live || (!s.ready && !cooling && s.charges > 0))
      const C = 2 * Math.PI * 28
      attr(g.ring, "stroke-dasharray", `${(C * (cooling ? 1 - s.cooldown : 0)).toFixed(1)} ${C}`)
    })
  }

  private updateRoom(ctx: HudContext) {
    const e = this.el
    if (ctx.room) this.root.dataset.room = ctx.room
    text(e.roomCode!, ctx.room ? `ROOM ${ctx.room}` : "SOLO PRACTICE")
    show(e.copy!, !!ctx.room)
    text(e.roomStatus!, ctx.status.toUpperCase())
    show(e.roomStatus!, !!ctx.room)
    const humans = ctx.players.filter((p) => p.human).length
    text(e.roomCount!, ctx.room ? `${humans} PLAYER${humans === 1 ? "" : "S"}` : `${ctx.players.length - humans} BOTS`)
    const st = ctx.status.toLowerCase()
    attr(e.room!, "data-status", st.includes("connect") && !st.includes("connected") ? "pending" : st.includes("off") || st.includes("lost") || st.includes("error") || st.includes("closed") ? "bad" : "ok")
  }

  private renderFeed(view: WorldView) {
    this.feedDirty = false
    const names = [...this.names.keys()].filter((n) => n.length > 1).sort((a, b) => b.length - a.length)
    const re = names.length ? new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "g") : null
    this.el.feed!.innerHTML = this.feed
      .map((f) => {
        let body = esc(f.text)
        if (re) body = body.replace(re, (n) => `<b class="${this.names.get(n) === "robber" || n === view.cars.find((c) => c.ownerId === view.robberId)?.name ? "t-robber" : "t-cop"}">${n}</b>`)
        return `<div class="row k-${esc(f.kind)}"><time>${clock(f.t)}</time><span>${body}</span></div>`
      })
      .join("")
  }

  private updateEnd(view: WorldView, ctx: HudContext, isRobber: boolean, mine: CarView | undefined) {
    const e = this.el
    if (view.phase !== "end") return
    // Award XP once per round, as soon as the round ends.
    if (this.awarded !== view.round && mine) {
      this.awarded = view.round
      const me = view.standings.find((s) => s.id === ctx.myId)
      this.xp = awardRound({
        role: isRobber ? "robber" : "cop",
        escaped: view.escaped,
        madeBust: !isRobber && view.busted && (me?.busts ?? 0) > this.baseline.busts,
        drift: isRobber ? view.roundScore.drift : 0,
        nearMisses: isRobber ? view.roundScore.nearMisses : 0,
        loot: view.loot,
        chaseSeconds: Math.max(0, view.t - INTRO_SECONDS - HEAD_START_SECONDS),
      })
    }
    const showAt = 1.4
    if (view.phaseT < showAt) return
    if (this.resultsFor !== view.round) {
      this.resultsFor = view.round
      this.renderResults(view, ctx, isRobber)
      show(e.results!, true)
      e.results!.classList.remove("in")
      void e.results!.offsetWidth
      e.results!.classList.add("in")
    }
    const n = e.results!.querySelector<HTMLElement>(".next-n")
    if (n) text(n, String(Math.max(0, Math.ceil(END_SECONDS - view.phaseT))))
  }

  private renderResults(view: WorldView, ctx: HudContext, isRobber: boolean) {
    const robberName = view.cars.find((c) => c.ownerId === view.robberId)?.name ?? "The suspect"
    const timeUp = !view.escaped && view.bust < 1 && !this.feed.some((f) => f.kind === "bust" && f.t >= view.t - 0.5)
    const busted = !view.escaped && !timeUp
    let title: string
    let sub: string
    let tone: Tone
    if (isRobber) {
      title = view.escaped ? "CLEAN GETAWAY" : busted ? "BUSTED" : "TIME'S UP"
      sub = view.escaped ? `You made the ${view.exit.name} with ${money(view.loot)}.` : busted ? "They boxed you in. The take goes into evidence." : "Roadblocks sealed the district."
      tone = view.escaped ? "go" : "threat"
    } else {
      title = view.escaped ? "SUSPECT ESCAPED" : busted ? "SUSPECT BUSTED" : "DISTRICT SEALED"
      sub = view.escaped ? `${robberName} got away with ${money(view.loot)}.` : busted ? `${robberName} is in custody.` : `${robberName} ran out of road.`
      tone = view.escaped ? "threat" : "cop"
    }
    const me = view.standings.find((s) => s.id === ctx.myId)
    const myRound = Math.round((me?.score ?? 0) - this.baseline.score)
    const rs = view.roundScore
    const rows: [string, string][] = isRobber
      ? [
          ["Drift", rs.drift.toLocaleString("en-US")],
          [`Near misses ×${rs.nearMisses}`, (rs.nearMisses * 500).toLocaleString("en-US")],
          ["The take", view.escaped ? money(view.loot) : "—"],
        ]
      : [
          ["Bust credit", myRound > 0 ? myRound.toLocaleString("en-US") : "—"],
          ["Suspect drift", rs.drift.toLocaleString("en-US")],
          ["Suspect near misses", String(rs.nearMisses)],
        ]
    const total = isRobber ? rs.score : myRound
    const xp = this.xp
    let xpHtml = ""
    if (xp) {
      const lv = xp.after
      const levelUp = xp.after.level > xp.before.level
      const startPct = levelUp ? 0 : (xp.before.into / xp.before.need) * 100
      const endPct = (lv.into / lv.need) * 100
      xpHtml = `<div class="xp">
        <div class="xp-head"><b class="xp-gain">+${xp.total.toLocaleString("en-US")} XP</b><span>LEVEL ${lv.level}</span></div>
        <div class="xp-bar" style="--from:${startPct.toFixed(1)}%;--to:${endPct.toFixed(1)}%"><i></i></div>
        <div class="xp-lines">${xp.lines.map((l) => `<span>${esc(l.label)} <b>+${l.xp}</b></span>`).join("")}</div>
        ${levelUp ? `<div class="levelup">LEVEL UP — LEVEL ${lv.level}${xp.unlocked.length ? ` · UNLOCKED ${xp.unlocked.map((v) => esc(v.name.toUpperCase())).join(", ")}` : ""}</div>` : ""}
      </div>`
    } else {
      const p = levelOf(loadProfile().xp)
      xpHtml = `<div class="xp"><div class="xp-head"><span>SPECTATING</span><span>LEVEL ${p.level}</span></div></div>`
    }
    const standings = view.standings
      .map(
        (s, i) =>
          `<tr class="${s.id === ctx.myId ? "me" : ""}"><td class="rk">${i + 1}</td><td class="nm">${esc(s.name)}${s.id === ctx.myId ? ` <em>YOU</em>` : ""}${s.human ? "" : ` <i>BOT</i>`}${s.id === view.robberId ? ` <i class="t-robber">DRIVER</i>` : ""}</td><td>${s.escapes}</td><td>${s.busts}</td><td class="sc">${Math.round(s.score).toLocaleString("en-US")}</td></tr>`,
      )
      .join("")
    this.el.results!.innerHTML = `<div class="results-card tone-${tone}">
      <div class="rs-kicker">ROUND ${view.round + 1} · ${esc(view.site.name.toUpperCase())}</div>
      <div class="rs-title">${title}</div>
      <div class="rs-sub">${esc(sub)}</div>
      <div class="rs-grid">
        <div class="rs-col">
          <h4>${isRobber ? "YOUR RUN" : "YOUR SHIFT"}</h4>
          ${rows.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${v}</b></div>`).join("")}
          <div class="kv total"><span>ROUND SCORE</span><b>${Math.max(0, total).toLocaleString("en-US")}</b></div>
          ${this.awards.length ? `<h4>AWARDS</h4><div class="awards">${this.awards.map((a) => `<span>${esc(a)}</span>`).join("")}</div>` : ""}
          ${xpHtml}
        </div>
        <div class="rs-col">
          <h4>STANDINGS</h4>
          <table class="standings"><thead><tr><th></th><th>NAME</th><th>ESC</th><th>BUSTS</th><th class="sc">SCORE</th></tr></thead><tbody>${standings}</tbody></table>
        </div>
      </div>
      <div class="rs-next">NEXT ROUND IN <b class="next-n"></b></div>
    </div>`
  }
}
