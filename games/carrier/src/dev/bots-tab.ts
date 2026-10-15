import { LabPanel, type LabControl, type LabSettings } from "@arcade/kit/lab-panel"
import { BEHAVIORS, BOT_DEFAULTS, BOT_RANGES, type BotAt, type BotCmd, type BotInfo, type BotKind, type BotSettings, botKind } from "../../shared/bots"
import { playerOf, shipOf, teamCss } from "../../shared/crew"
import { OPS } from "../../shared/ops"
import type { Net } from "../net"
import type { DebugTab } from "./debug-menu"

/** Stylesheets the shared panel (and knobs, which draws it) put in the document head; the debug menu is a shadow root. */
const PANEL_STYLES = "style[data-knobs-style], style[data-knobs-preset], style[data-lab-knobs], style[data-lab-panel-css]"

export type BotsHost = {
  net: () => Net
  release: () => void
  close: () => void
  /** Where I am (my jet in the air, else my ship, else the camera): plan position, height, heading (rad, 0 north). */
  me: () => { x: number; y: number; z: number; heading: number; flying: boolean }
}

/** Panel ids for "whose": the nearest enemy carrier, my own. */
const ENEMY = -2
const MINE = -1
/** Target pickers: me, anyone. */
const ME = -2
const ANY = -1

const ROLE_LABELS: Record<string, string> = { hornet: "Hornet pilot", f35: "F-35C pilot", boat: "Boat driver", helm: "Helmsman" }
const FACINGS = ["toward me", "away", "across", "my heading"] as const

/** The panel's settings: what to spawn and how it behaves (typed, with approved defaults; Reset restores them). */
function defaults(): LabSettings {
  return {
    role: "hornet",
    carrier: ENEMY,
    count: 1,
    start: "air",
    distance: 2000,
    bearing: 0,
    facing: "toward me",
    rules: false,
    jet: "dogfight",
    boat: "attack",
    gun: "engage",
    helm: "chase",
    alt: BOT_DEFAULTS.alt,
    speed: BOT_DEFAULTS.speed,
    radius: BOT_DEFAULTS.radius,
    throttle: BOT_DEFAULTS.throttle,
    target: ME,
    targetShip: MINE,
    skill: BOT_DEFAULTS.skill,
    aggression: BOT_DEFAULTS.aggression,
    accuracy: BOT_DEFAULTS.accuracy,
    weapons: BOT_DEFAULTS.weapons,
    flares: BOT_DEFAULTS.flares,
    ammo: BOT_DEFAULTS.ammo,
    invulnerable: BOT_DEFAULTS.invulnerable,
    respawn: BOT_DEFAULTS.respawn,
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

/**
 * BOTS tab (dev builds, dev rooms): quick scenarios, a spawner and the bots' behavior on the shared Lab panel (typed
 * settings with labels, units, ranges and Reset), and the live list from the room (state, health, what each is doing;
 * LOAD its settings, APPLY the panel's behavior, SHOOT DOWN, REMOVE). Offline it offers the in-page room
 * (`?seed=N&bots`), since bots live in a room.
 */
export class BotsTab {
  private panel: LabPanel | null = null
  private status: HTMLElement | null = null
  private listEl: HTMLElement | null = null
  private s = defaults()
  private readonly approved = defaults()
  private carriers: { value: number; label: string }[] = [
    { value: ENEMY, label: "Nearest enemy" },
    { value: MINE, label: "My carrier" },
  ]
  private targets: { value: number; label: string }[] = [
    { value: ME, label: "Me" },
    { value: ANY, label: "Any enemy" },
  ]
  private ships: { value: number; label: string }[] = [
    { value: MINE, label: "My carrier" },
    { value: ANY, label: "Nearest enemy" },
  ]
  private shape = ""
  private listKey = ""
  private refreshIn = 0

  constructor(private host: BotsHost) {}

  readonly tab: DebugTab = {
    id: "bots",
    label: "Bots",
    css: CSS,
    mount: (el) => {
      el.replaceChildren()
      this.status = document.createElement("div")
      this.status.className = "bots-status"
      el.append(this.status)
      const panel = new LabPanel({}, [], new URLSearchParams(), this.host.release, {
        layout: "inspector",
        capture: "focus",
        open: true,
        presets: false,
        groupActions: false,
        pill: false,
        variants: "carrier-bots",
        onToggle: (visible) => {
          if (!visible) this.host.close()
        },
      })
      panel.addControls(this.s, this.controls(), this.approved)
      for (const s of document.head.querySelectorAll(PANEL_STYLES)) el.append(s.cloneNode(true))
      el.append(panel.host)
      this.listEl = document.createElement("div")
      this.listEl.className = "bots-list"
      this.listEl.addEventListener("click", (e) => this.clickList(e))
      el.append(this.listEl)
      this.panel = panel
      this.listKey = ""
      this.shape = ""
      this.refresh()
    },
    unmount: () => {
      this.panel?.dispose()
      this.panel = null
      this.status = null
      this.listEl = null
    },
  }

  /** Every frame (the menu calls it while any tab is shown): the status, pickers and list twice a second. */
  frame(dt: number): void {
    if (!this.panel) return
    this.refreshIn -= dt
    if (this.refreshIn > 0) return
    this.refreshIn = 0.5
    this.refresh()
  }

  private kind(): BotKind {
    return botKind(String(this.s.role)) ?? "jet"
  }

  private controls(): LabControl[] {
    const k = () => this.kind()
    const jets = () => k() === "jet"
    const roles = OPS.map((o) => ({ value: o.id, label: ROLE_LABELS[o.id] ?? `Gunner · ${o.label}` }))
    const behaviors = (kind: BotKind) => BEHAVIORS[kind].map((b) => ({ value: b, label: b === "eight" ? "figure-eight" : b }))
    const range = (key: keyof typeof BOT_RANGES, group: string, visible?: () => boolean): LabControl => {
      const r = BOT_RANGES[key]
      return { key, label: r.label, group, unit: r.unit, min: r.min, max: r.max, step: r.step, ...(visible ? { visible } : {}) }
    }
    const action = (key: string, label: string, run: () => void): LabControl => ({ key, label, group: "Scenarios", type: "action", run })
    return [
      action("s-duel", "1v1 dogfight · 2 km", () => this.duel()),
      action("s-bomber", "Bomber run on my carrier", () => this.bomberRun()),
      action("s-swarm", "Swarm of 4", () => this.swarm()),
      action("s-battle", "Carrier battle", () => this.battle()),
      action("s-practice", "Target practice ×3", () => this.practice()),
      action("s-boats", "Boat attack ×2", () => this.boats()),
      action("s-clear", "Remove all bots", () => this.send({ c: "clear" })),
      { key: "role", label: "Role", group: "Spawn", options: roles },
      { key: "carrier", label: "Carrier (side)", group: "Spawn", options: this.carriers },
      { key: "count", label: "Count", group: "Spawn", unit: "", min: 1, max: 8, step: 1 },
      { key: "start", label: "Start", group: "Spawn", options: [{ value: "air", label: "Near me (air / water)" }, { value: "deck", label: "From the deck" }], visible: () => k() === "jet" || k() === "boat" },
      { key: "distance", label: "Distance from me", group: "Spawn", unit: "m", min: 300, max: 8000, step: 100, visible: () => (k() === "jet" || k() === "boat") && this.s.start === "air" },
      { key: "bearing", label: "Bearing off my nose", group: "Spawn", unit: "°", min: -180, max: 180, step: 5, visible: () => (k() === "jet" || k() === "boat") && this.s.start === "air" },
      { key: "facing", label: "Facing", group: "Spawn", options: FACINGS.map((f) => ({ value: f, label: f })), visible: () => (k() === "jet" || k() === "boat") && this.s.start === "air" },
      { key: "rules", label: "Obey slot caps and recharges", group: "Spawn" },
      { key: "spawn", label: "Spawn", group: "Spawn", type: "action", run: () => this.spawnFromPanel() },
      { key: "jet", label: "Behavior", group: "Behavior", options: behaviors("jet"), visible: jets },
      { key: "boat", label: "Behavior", group: "Behavior", options: behaviors("boat"), visible: () => k() === "boat" },
      { key: "gun", label: "Behavior", group: "Behavior", options: behaviors("gun"), visible: () => k() === "gun" },
      { key: "helm", label: "Behavior", group: "Behavior", options: behaviors("helm"), visible: () => k() === "helm" },
      range("alt", "Behavior", jets),
      range("speed", "Behavior", jets),
      range("radius", "Behavior", () => jets() || k() === "boat"),
      range("throttle", "Behavior", () => k() === "boat" || k() === "helm"),
      { key: "target", label: "Hunt", group: "Behavior", options: this.targets, visible: () => k() !== "helm" },
      { key: "targetShip", label: "Target carrier", group: "Behavior", options: this.ships },
      { key: "apply", label: "Apply behavior to every bot of this kind", group: "Behavior", type: "action", run: () => this.applyAll() },
      range("skill", "Skill"),
      range("aggression", "Skill"),
      range("accuracy", "Skill"),
      { key: "weapons", label: "Weapons", group: "Weapons" },
      { key: "flares", label: "Flares", group: "Weapons" },
      { key: "ammo", label: "Infinite ammo", group: "Weapons" },
      { key: "invulnerable", label: "Invulnerable", group: "Weapons" },
      { key: "respawn", label: "Respawn when destroyed", group: "Weapons" },
    ]
  }

  // ---- what the panel sends -------------------------------------------------------------------------------------

  private send(cmd: BotCmd): void {
    this.host.net().sendBot(cmd)
  }

  /** The bot settings the panel describes for a bot of `kind` (target pickers resolved to ids). */
  private settings(kind: BotKind, over: Partial<BotSettings> = {}): BotSettings {
    const s = this.s
    const net = this.host.net()
    const behavior = (kind === "jet" ? s.jet : kind === "boat" ? s.boat : kind === "gun" ? s.gun : s.helm) as BotSettings["behavior"]
    const target = Number(s.target) === ME ? net.id : Number(s.target)
    const ts = Number(s.targetShip)
    const targetShip = ts === MINE ? this.myShip() : ts
    return {
      behavior,
      alt: Number(s.alt),
      speed: Number(s.speed),
      radius: Number(s.radius),
      throttle: Number(s.throttle),
      skill: Number(s.skill),
      aggression: Number(s.aggression),
      accuracy: Number(s.accuracy),
      weapons: !!s.weapons,
      flares: !!s.flares,
      ammo: !!s.ammo,
      invulnerable: !!s.invulnerable,
      respawn: !!s.respawn,
      target,
      targetShip,
      ...over,
    }
  }

  private myShip(): number {
    const net = this.host.net()
    return (net.crew && playerOf(net.crew, net.id)?.ship) ?? -1
  }

  private myTeam(): number {
    const net = this.host.net()
    return (net.crew && playerOf(net.crew, net.id)?.team) ?? -1
  }

  /** Enemy carriers, nearest first (every other side's). */
  private enemies(): number[] {
    const net = this.host.net()
    const me = this.host.me()
    const team = this.myTeam()
    return (net.crew?.ships ?? [])
      .filter((s) => s.team !== team)
      .map((s) => ({ id: s.id, d: this.shipDist(s.id, me.x, me.z) }))
      .sort((a, b) => a.d - b.d)
      .map((s) => s.id)
  }

  private shipAt(id: number): [number, number, number] | null {
    const t = this.host.net().ships.get(id)
    return t ? [t[2], t[3], t[4]] : null
  }

  private shipDist(id: number, x: number, z: number): number {
    const p = this.shipAt(id)
    return p ? Math.hypot(p[0] - x, p[1] - z) : Infinity
  }

  private carrierOf(v: number): number {
    if (v === MINE) return this.myShip()
    if (v === ENEMY) return this.enemies()[0] ?? -1
    return v
  }

  /** A start point `distance` m from me, `bearing` off my nose, at `y`, facing as asked. */
  private at(distance: number, bearing: number, y: number, facing: (typeof FACINGS)[number], from?: { x: number; z: number; heading: number }): BotAt {
    const me = from ?? this.host.me()
    const a = me.heading + (bearing * Math.PI) / 180
    const x = me.x + Math.sin(a) * distance
    const z = me.z - Math.cos(a) * distance
    const toward = Math.atan2(me.x - x, -(me.z - z))
    const h = facing === "toward me" ? toward : facing === "away" ? toward + Math.PI : facing === "across" ? toward + Math.PI / 2 : me.heading
    const r = (v: number) => Math.round(v * 10) / 10
    return [r(Math.max(-8900, Math.min(8900, x))), r(Math.max(0, Math.min(3000, y))), r(Math.max(-8900, Math.min(8900, z))), Math.round(Math.atan2(Math.sin(h), Math.cos(h)) * 1e4) / 1e4]
  }

  private spawn(role: string, ship: number, n: number, start: "air" | "deck", at: BotAt, s: BotSettings, rules = !!this.s.rules): void {
    if (ship < 0) return
    this.send({ c: "spawn", role, ship, n, start, rules, at, s })
  }

  private spawnFromPanel(): void {
    const role = String(this.s.role)
    const kind = this.kind()
    const s = this.settings(kind)
    const air = (kind === "jet" || kind === "boat") && this.s.start === "air"
    const at = this.at(Number(this.s.distance), Number(this.s.bearing), kind === "jet" ? s.alt : 0, this.s.facing as (typeof FACINGS)[number])
    this.spawn(role, this.carrierOf(Number(this.s.carrier)), Number(this.s.count), air ? "air" : "deck", at, s)
  }

  /** The panel's behavior settings (not the spawn ones) onto every live bot of the selected kind. */
  private applyAll(): void {
    const kind = this.kind()
    const ids = this.host.net().bots.filter((b) => botKind(b.role) === kind).map((b) => b.id)
    if (ids.length) this.send({ c: "set", ids: ids.slice(0, 24), s: this.settings(kind) })
  }

  // ---- scenarios ------------------------------------------------------------------------------------------------

  private myAlt(): number {
    const me = this.host.me()
    return me.flying ? Math.max(300, Math.min(2500, me.y)) : 800
  }

  private duel(): void {
    const alt = this.myAlt()
    this.spawn("hornet", this.carrierOf(ENEMY), 1, "air", this.at(2000, 0, alt, "toward me"), this.settings("jet", { behavior: "dogfight", alt, target: this.host.net().id, respawn: true }), false)
  }

  private bomberRun(): void {
    const mine = this.myShip()
    const p = this.shipAt(mine)
    if (!p) return
    const me = this.host.me()
    const from = { x: p[0], z: p[1], heading: Math.atan2(me.x - p[0], -(me.z - p[1])) || p[2] }
    this.spawn("f35", this.carrierOf(ENEMY), 1, "air", this.at(6000, 180, 600, "toward me", from), this.settings("jet", { behavior: "bomber", alt: 600, speed: 150, targetShip: mine, respawn: true }), false)
  }

  private swarm(): void {
    const alt = this.myAlt()
    this.spawn("hornet", this.carrierOf(ENEMY), 4, "air", this.at(3000, 0, alt, "toward me"), this.settings("jet", { behavior: "dogfight", alt, target: ANY, respawn: true }), false)
  }

  /** The nearest enemy carrier fights with everything (helm, all five guns, two Hornets off its deck); the next one
   *  sends its F-35C and its boat at my carrier. */
  private battle(): void {
    const [a, b] = this.enemies()
    const mine = this.myShip()
    if (a === undefined) return
    const at = this.at(0, 0, 0, "my heading")
    const base = this.settings("gun", { target: ANY, targetShip: mine, respawn: true })
    this.spawn("helm", a, 1, "deck", at, { ...base, behavior: "chase", throttle: 0.7 }, true)
    for (const role of ["ciws-port", "ciws-stbd", "sam-port", "sam-stbd", "gun-5in"]) this.spawn(role, a, 1, "deck", at, { ...base, behavior: "engage" }, true)
    this.spawn("hornet", a, 2, "deck", at, { ...base, behavior: "dogfight", alt: 900 }, true)
    const second = b ?? a
    this.spawn("f35", second, 1, "deck", at, { ...base, behavior: "bomber", alt: 700, speed: 150 }, true)
    this.spawn("boat", second, 1, "deck", at, { ...base, behavior: "attack", throttle: 0.9 }, true)
  }

  private practice(): void {
    const alt = this.myAlt()
    const off = { weapons: false, flares: false, invulnerable: false, respawn: true, target: ANY }
    const enemy = this.carrierOf(ENEMY)
    this.spawn("hornet", enemy, 1, "air", this.at(2500, -25, alt, "across"), this.settings("jet", { ...off, behavior: "orbit", alt, radius: 1200, speed: 150 }), false)
    this.spawn("hornet", enemy, 1, "air", this.at(2500, 0, alt + 150, "across"), this.settings("jet", { ...off, behavior: "eight", alt: alt + 150, radius: 1300, speed: 160 }), false)
    this.spawn("hornet", enemy, 1, "air", this.at(2500, 25, alt - 150, "across"), this.settings("jet", { ...off, behavior: "evasive", alt: alt - 150, radius: 1500, speed: 170 }), false)
  }

  private boats(): void {
    const mine = this.myShip()
    const p = this.shipAt(mine)
    const from = p ? { x: p[0], z: p[1], heading: p[2] } : undefined
    this.spawn("boat", this.carrierOf(ENEMY), 2, "air", this.at(1400, 60, 0, "toward me", from), this.settings("boat", { behavior: "attack", throttle: 0.9, targetShip: mine, target: ANY }), false)
  }

  // ---- the live view --------------------------------------------------------------------------------------------

  /** Pickers follow the crew (carriers, players), the status line and the bot list follow the room. */
  private refresh(): void {
    const net = this.host.net()
    const crew = net.crew
    if (crew) {
      const mine = this.myShip()
      const shape = JSON.stringify([crew.ships.map((s) => [s.id, s.name, s.team]), crew.players.map((p) => [p.id, p.name]), mine])
      if (shape !== this.shape) {
        this.shape = shape
        this.carriers.splice(2, Infinity, ...crew.ships.map((s) => ({ value: s.id, label: `${s.name}${s.id === mine ? " (mine)" : ""}` })))
        this.targets.splice(2, Infinity, ...crew.players.filter((p) => p.id !== net.id).map((p) => ({ value: p.id, label: p.name })))
        this.ships.splice(2, Infinity, ...crew.ships.map((s) => ({ value: s.id, label: `${s.name}${s.id === mine ? " (mine)" : ""}` })))
        this.panel?.refresh()
      }
    }
    if (this.status) {
      const refused = net.refused && performance.now() - net.refused.at < 4000 ? ` · REFUSED: ${net.refused.error}` : ""
      const offline = net.state === "offline"
      const here = `${location.href}${location.search ? "&" : "?"}bots`
      this.status.innerHTML = offline
        ? `OFFLINE: BOTS LIVE IN A ROOM. <a href="${esc(here)}">RELOAD WITH AN IN-PAGE ROOM</a>`
        : !net.dev
          ? "THIS ROOM IS NOT IN DEV MODE: IT REFUSES BOTS."
          : `${net.room === "local" ? "IN-PAGE DEV ROOM" : `DEV ROOM ${esc(net.room ?? "")}`} · ${net.bots.length} BOT${net.bots.length === 1 ? "" : "S"}${esc(refused)}`
    }
    this.renderList(net)
  }

  private renderList(net: Net): void {
    const el = this.listEl
    if (!el) return
    const key = JSON.stringify(net.bots.map((b) => [b.id, b.state, b.note, b.hp, b.ship]))
    if (key === this.listKey) return
    this.listKey = key
    if (!net.bots.length) {
      el.innerHTML = `<h2>LIVE BOTS</h2><div class="none">NONE</div>`
      return
    }
    const groups = new Map<number, BotInfo[]>()
    for (const b of net.bots) groups.set(b.group, [...(groups.get(b.group) ?? []), b])
    const crew = net.crew
    let html = `<h2>LIVE BOTS</h2>`
    for (const [g, list] of groups) {
      html += `<div class="group"><span>GROUP ${g}</span><button data-act="apply" data-ids="${list.map((b) => b.id).join(",")}">APPLY</button><button data-act="remove" data-ids="${list.map((b) => b.id).join(",")}">REMOVE</button></div>`
      for (const b of list) {
        const ship = crew && shipOf(crew, b.ship)
        const team = crew && playerOf(crew, b.id)?.team
        const role = ROLE_LABELS[b.role] ?? b.role.toUpperCase()
        const hp = botKind(b.role) === "jet" || botKind(b.role) === "boat" ? ` · ${b.hp} HP` : ""
        html += `<div class="bot"><div class="name" style="color:${teamCss(team ?? undefined)}">${esc(b.name)}</div>`
        html += `<div class="what">${esc(role)} · ${esc(ship?.name ?? "?")} · ${esc(b.state.toUpperCase())}${hp}${b.s.invulnerable ? " · INVULN" : ""}</div>`
        html += `<div class="note">${esc(b.note)}</div>`
        html += `<div class="row"><button data-act="load" data-ids="${b.id}">LOAD</button><button data-act="apply" data-ids="${b.id}">APPLY</button><button data-act="kill" data-ids="${b.id}">SHOOT DOWN</button><button data-act="remove" data-ids="${b.id}">REMOVE</button></div></div>`
      }
    }
    el.innerHTML = html
  }

  private clickList(e: Event): void {
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]")
    if (!t) return
    const ids = (t.dataset.ids ?? "").split(",").map(Number).filter((n) => Number.isInteger(n))
    const act = t.dataset.act
    if (!ids.length) return
    if (act === "remove" || act === "kill") this.send({ c: act, ids })
    else if (act === "apply") {
      const bots = this.host.net().bots.filter((b) => ids.includes(b.id))
      const kind = botKind(bots[0]?.role ?? "") ?? this.kind()
      this.send({ c: "set", ids, s: this.settings(kind) })
    } else if (act === "load") {
      const b = this.host.net().bots.find((x) => x.id === ids[0])
      if (!b) return
      const kind = botKind(b.role) ?? "jet"
      const s = this.s
      s.role = b.role
      s[kind] = b.s.behavior
      for (const k of ["alt", "speed", "radius", "throttle", "skill", "aggression", "accuracy", "weapons", "flares", "ammo", "invulnerable", "respawn"] as const) s[k] = b.s[k]
      s.target = b.s.target === this.host.net().id ? ME : b.s.target
      s.targetShip = b.s.targetShip === this.myShip() ? MINE : b.s.targetShip
      this.panel?.refresh()
    }
  }
}

const CSS = `
.bots-status { padding: 2px 0 8px; opacity: 0.85; line-height: 1.6 }
.bots-status a { color: #ffd27a }
.bots-list { margin-top: 10px }
.bots-list .none { opacity: 0.5 }
.bots-list .group { display: flex; gap: 6px; align-items: center; margin: 10px 0 4px; opacity: 0.75 }
.bots-list .group span { flex: 1 }
.bots-list .bot { padding: 6px 0; border-top: 1px solid rgba(255, 255, 255, 0.08) }
.bots-list .name { font-size: 11px; letter-spacing: 0.2em }
.bots-list .what, .bots-list .note { opacity: 0.7; letter-spacing: 0.08em }
.bots-list .note { text-transform: none; opacity: 0.55 }
.bots-list .row { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap }
.bots-list button { font-size: 9px; padding: 2px 6px }
`
