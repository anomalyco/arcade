import type { LabControl, LabPanel, LabSettings } from "@arcade/kit/lab-panel"
import { BEHAVIORS, BOT_DEFAULTS, BOT_RANGES, type BotAt, type BotCmd, type BotInfo, type BotKind, type BotSettings, botKind } from "../../shared/bots"
import { playerOf, shipOf } from "../../shared/crew"
import { OPS } from "../../shared/ops"
import type { Net } from "../net"
import type { DevSection } from "./dev-panel"

export type BotsHost = {
  net: () => Net
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

/** The live-bots picker: every bot, a group ("g3") or one bot ("b17"). */
const ALL = "all"
const LIVE = "Live bots"

/**
 * BOTS (dev builds, dev rooms): quick scenarios, a spawner and the bots' behavior as typed settings on the dev panel
 * (labels, units, ranges and Reset), and the live list from the room (state, health, what each is doing). Pick every
 * bot, a group or one bot under Live bots, then LOAD its settings, APPLY the panel's behavior, SHOOT DOWN or REMOVE.
 * Offline it offers the in-page room (`?seed=N&bots`), since bots live in a room.
 */
export class BotsLab {
  private panel: LabPanel | null = null
  private s = defaults()
  private readonly approved = defaults()
  private readonly live: LabSettings = { pick: ALL }
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
  private picks: { value: string; label: string }[] = [{ value: ALL, label: "Every bot" }]
  private shape = ""
  private listKey = ""
  private refreshIn = 0

  constructor(private host: BotsHost) {}

  readonly section: DevSection = {
    id: "bots",
    tab: "Bots",
    bind: (panel) => {
      this.panel = panel
      panel.addControls({}, [{ key: "bots-status", label: "Room", group: "Scenarios", type: "readout", read: () => this.status() }])
      panel.addControls(this.s, this.controls(), this.approved)
      panel.addControls(this.live, this.liveControls(), { pick: ALL })
    },
    shown: (on) => {
      if (on) this.refreshIn = 0
    },
    frame: (dt) => {
      this.refreshIn -= dt
      if (this.refreshIn > 0) return
      this.refreshIn = 0.5
      this.refresh()
    },
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
      return { key: `bots.${key}`, label: r.label, group, unit: r.unit, min: r.min, max: r.max, step: r.step, ...(visible ? { visible } : {}) }
    }
    const scenario = (key: string, label: string, run: () => void) => ({ key: `bots-${key}`, label, run, enabled: () => this.inRoom() })
    return [
      {
        key: "bots-scenarios",
        label: "Fights",
        group: "Scenarios",
        type: "buttons",
        items: [
          scenario("duel", "1v1 dogfight · 2 km", () => this.duel()),
          scenario("bomber", "Bomber run on my carrier", () => this.bomberRun()),
          scenario("swarm", "Swarm of 4", () => this.swarm()),
          scenario("battle", "Carrier battle", () => this.battle()),
        ],
      },
      {
        key: "bots-scenarios-2",
        label: "Practice",
        group: "Scenarios",
        type: "buttons",
        items: [
          scenario("practice", "Target practice ×3", () => this.practice()),
          scenario("boats", "Boat attack ×2", () => this.boats()),
          scenario("clear", "Remove all bots", () => this.send({ c: "clear" })),
        ],
      },
      { key: "bots.role", label: "Role", group: "Spawn", options: roles },
      { key: "bots.carrier", label: "Carrier (side)", group: "Spawn", options: this.carriers },
      { key: "bots.count", label: "Count", group: "Spawn", unit: "", min: 1, max: 8, step: 1 },
      { key: "bots.start", label: "Start", group: "Spawn", options: [{ value: "air", label: "Near me (air / water)" }, { value: "deck", label: "From the deck" }], visible: () => k() === "jet" || k() === "boat" },
      { key: "bots.distance", label: "Distance from me", group: "Spawn", unit: "m", min: 300, max: 8000, step: 100, visible: () => (k() === "jet" || k() === "boat") && this.s.start === "air" },
      { key: "bots.bearing", label: "Bearing off my nose", group: "Spawn", unit: "°", min: -180, max: 180, step: 5, visible: () => (k() === "jet" || k() === "boat") && this.s.start === "air" },
      { key: "bots.facing", label: "Facing", group: "Spawn", options: FACINGS.map((f) => ({ value: f, label: f })), visible: () => (k() === "jet" || k() === "boat") && this.s.start === "air" },
      { key: "bots.rules", label: "Obey slot caps and recharges", group: "Spawn" },
      { key: "bots-spawn", label: "Spawn", group: "Spawn", type: "buttons", items: [{ key: "bots-spawn-now", label: "Spawn", run: () => this.spawnFromPanel(), enabled: () => this.inRoom() }] },
      { key: "bots.jet", label: "Behavior", group: "Behavior", options: behaviors("jet"), visible: jets },
      { key: "bots.boat", label: "Behavior", group: "Behavior", options: behaviors("boat"), visible: () => k() === "boat" },
      { key: "bots.gun", label: "Behavior", group: "Behavior", options: behaviors("gun"), visible: () => k() === "gun" },
      { key: "bots.helm", label: "Behavior", group: "Behavior", options: behaviors("helm"), visible: () => k() === "helm" },
      range("alt", "Behavior", jets),
      range("speed", "Behavior", jets),
      range("radius", "Behavior", () => jets() || k() === "boat"),
      range("throttle", "Behavior", () => k() === "boat" || k() === "helm"),
      { key: "bots.target", label: "Hunt", group: "Behavior", options: this.targets, visible: () => k() !== "helm" },
      { key: "bots.targetShip", label: "Target carrier", group: "Behavior", options: this.ships },
      { key: "bots-apply-kind", label: "Every bot of this kind", group: "Behavior", type: "buttons", items: [{ key: "bots-apply-all", label: "Apply behavior", run: () => this.applyAll(), enabled: () => this.inRoom() }] },
      range("skill", "Skill"),
      range("aggression", "Skill"),
      range("accuracy", "Skill"),
      { key: "bots.weapons", label: "Weapons", group: "Weapons" },
      { key: "bots.flares", label: "Flares", group: "Weapons" },
      { key: "bots.ammo", label: "Infinite ammo", group: "Weapons" },
      { key: "bots.invulnerable", label: "Invulnerable", group: "Weapons" },
      { key: "bots.respawn", label: "Respawn when destroyed", group: "Weapons" },
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

  private inRoom(): boolean {
    const net = this.host.net()
    return net.state !== "offline" && net.dev
  }

  private status(): string {
    const net = this.host.net()
    if (net.state === "offline") return "Offline: bots live in a room"
    if (!net.dev) return "Not a dev room: it refuses bots"
    const refused = net.refused && performance.now() - net.refused.at < 4000 ? ` · refused: ${net.refused.error}` : ""
    return `${net.room === "local" ? "In-page dev room" : `Dev room ${net.room ?? ""}`} · ${net.bots.length} bot${net.bots.length === 1 ? "" : "s"}${refused}`
  }

  private liveControls(): LabControl[] {
    return [
      {
        key: "bots-offline",
        label: "Offline",
        group: LIVE,
        type: "buttons",
        visible: () => this.host.net().state === "offline",
        items: [{ key: "bots-local-room", label: "Reload with an in-page room", run: () => location.assign(`${location.href}${location.search ? "&" : "?"}bots`) }],
      },
      { key: "bots-list", label: "Bots", group: LIVE, type: "readout", display: "table", columns: ["", "What", "State", "Doing"], read: () => this.table() },
      { key: "bots.pick", field: "pick", label: "Act on", group: LIVE, options: this.picks },
      {
        key: "bots-act",
        label: "Selected",
        group: LIVE,
        type: "buttons",
        items: [
          { key: "bots-load", label: "Load", run: () => this.load(), enabled: () => String(this.live.pick).startsWith("b") },
          { key: "bots-apply", label: "Apply", run: () => this.act("apply"), enabled: () => this.selected().length > 0 },
          { key: "bots-kill", label: "Shoot down", run: () => this.act("kill"), enabled: () => this.selected().length > 0 },
          { key: "bots-remove", label: "Remove", run: () => this.act("remove"), enabled: () => this.selected().length > 0 },
        ],
      },
    ]
  }

  /** One row per live bot: name, role · carrier, state and health, what it is doing. */
  private table(): (readonly string[])[] {
    const net = this.host.net()
    const crew = net.crew
    if (!net.bots.length) return [["None", "", "", ""]]
    return net.bots.map((b) => {
      const ship = crew && shipOf(crew, b.ship)
      const hp = botKind(b.role) === "jet" || botKind(b.role) === "boat" ? ` · ${b.hp} HP` : ""
      return [b.name, `${ROLE_LABELS[b.role] ?? b.role} · ${ship?.name ?? "?"}`, `${b.state}${hp}${b.s.invulnerable ? " · invuln" : ""}`, b.note]
    })
  }

  /** The bots the Act on picker names, by id. */
  private selected(): number[] {
    const bots = this.host.net().bots
    const pick = String(this.live.pick)
    if (pick === ALL) return bots.map((b) => b.id)
    const n = Number(pick.slice(1))
    return bots.filter((b) => (pick[0] === "g" ? b.group === n : b.id === n)).map((b) => b.id)
  }

  private act(what: "apply" | "kill" | "remove"): void {
    const ids = this.selected().slice(0, 24)
    if (!ids.length) return
    if (what !== "apply") return this.send({ c: what, ids })
    const bots = this.host.net().bots.filter((b) => ids.includes(b.id))
    const kind = botKind(bots[0]?.role ?? "") ?? this.kind()
    this.send({ c: "set", ids: bots.filter((b) => botKind(b.role) === kind).map((b) => b.id), s: this.settings(kind) })
  }

  /** The picked bot's role, behavior and settings into the panel. */
  private load(): void {
    const ids = this.selected()
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

  /** Pickers follow the crew (carriers, players) and the live bots; the readouts follow the room. */
  private refresh(): void {
    const net = this.host.net()
    const crew = net.crew
    let changed = false
    if (crew) {
      const mine = this.myShip()
      const shape = JSON.stringify([crew.ships.map((s) => [s.id, s.name, s.team]), crew.players.map((p) => [p.id, p.name]), mine])
      if (shape !== this.shape) {
        this.shape = shape
        this.carriers.splice(2, Infinity, ...crew.ships.map((s) => ({ value: s.id, label: `${s.name}${s.id === mine ? " (mine)" : ""}` })))
        this.targets.splice(2, Infinity, ...crew.players.filter((p) => p.id !== net.id).map((p) => ({ value: p.id, label: p.name })))
        this.ships.splice(2, Infinity, ...crew.ships.map((s) => ({ value: s.id, label: `${s.name}${s.id === mine ? " (mine)" : ""}` })))
        changed = true
      }
    }
    const key = JSON.stringify(net.bots.map((b) => [b.id, b.name, b.group]))
    if (key !== this.listKey) {
      this.listKey = key
      const groups = [...new Set(net.bots.map((b) => b.group))]
      this.picks.splice(1, Infinity, ...groups.map((g) => ({ value: `g${g}`, label: `Group ${g}` })), ...net.bots.map((b) => ({ value: `b${b.id}`, label: b.name })))
      if (!this.picks.some((p) => p.value === this.live.pick)) this.live.pick = ALL
      changed = true
    }
    if (changed || this.panel?.visible) this.panel?.refresh()
  }
}
