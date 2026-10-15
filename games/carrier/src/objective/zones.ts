import { type Crew, playerOf, shipOf } from "../../shared/crew"
import type { Archipelago } from "../../shared/islands"
import { OBJECTIVE_DEFAULTS, Objective, type ObjectiveRules, type ObjectiveView, packRules, zoneCentre } from "../../shared/objective"
import type { Sea } from "../../shared/sea"
import type { Ship } from "../../shared/ship"
import type { Renderer } from "../render/renderer"
import { teamColor } from "../render/team"
import { ObjectiveHud } from "./hud"
import { ZONE_LOOK, type ZoneDraw, ZonePass } from "./zone-pass"

/** A zone as other HUD pieces (the pilot radar, the map) see it this frame. */
export type ZoneMark = {
  /** 0 = A, 1 = B. */
  id: number
  label: string
  /** Centre now (m) and radius. */
  x: number
  z: number
  r: number
  /** Holding side (-1 neutral), capturing side (-1 none) and its progress 0..1. */
  holder: number
  cap: number
  progress: number
  /** Two or more carriers inside. */
  contested: boolean
  /** An upcoming spot (revealed before a relocation), not yet live. */
  next: boolean
}

let marks: ZoneMark[] = []
/** The game's Zones (one per page), for the debug menu's APPLY. */
let current: Zones | null = null

/** The live zones and any revealed upcoming spots, as of the last frame (empty before the objective exists). */
export const objectiveZones = (): readonly ZoneMark[] => marks

/** Rules the debug menu's ZONES tab edits; APPLY sends them to the room (or restarts the offline objective). */
export const ZONE_RULES: ObjectiveRules = { ...OBJECTIVE_DEFAULTS }

/** Sends ZONE_RULES to the room (dev rooms restart their round with them), or restarts the offline objective. */
export function applyZoneRules(net: NetLike & { seaTime(): number }): void {
  current?.apply(net, net.seaTime())
}

const NEUTRAL: readonly [number, number, number] = [0.82, 0.86, 0.92]
export const ZONE_LABELS = ["A", "B", "C", "D"]

const bitCount = (m: number): number => {
  let n = 0
  for (let v = m; v; v &= v - 1) n++
  return n
}

type NetLike = {
  readonly state: "connecting" | "online" | "offline"
  readonly seed: number
  readonly id: number
  readonly crew: Crew | null
  readonly objective: ObjectiveView | null
  sendObjective(rules: number[]): void
}

/**
 * The objective on this client: the room's (`net.objective`), or offline a local `Objective` run on this ship. Draws
 * the zones (ZonePass), runs the scoreboard HUD, and publishes `objectiveZones()` for the radar.
 */
export class Zones {
  /** ZONE_RULES, for scripts (`carrier.zones.rules`). */
  readonly rules = ZONE_RULES
  readonly pass: ZonePass
  readonly hud: ObjectiveHud
  private arch: Archipelago | null = null
  private local: Objective | null = null
  private localSeed = -1
  private draws: ZoneDraw[] = []
  private c: [number, number] = [0, 0]

  constructor(renderer: Renderer, hudRoot: HTMLElement) {
    this.pass = new ZonePass(renderer)
    renderer.addPass("alpha", this.pass)
    this.hud = new ObjectiveHud(hudRoot)
    current = this
  }

  /** objectiveZones(), for scripts (`carrier.zones.marks`). */
  get marks(): readonly ZoneMark[] {
    return marks
  }

  setWorld(sea: Sea, arch: Archipelago): void {
    this.pass.setSea(sea)
    this.arch = arch
    this.local = null
  }

  /** New rules: online the room restarts its round with them (dev rooms); offline the local objective does. */
  apply(net: NetLike, t: number): void {
    if (net.state === "offline") {
      this.local?.setRules({ ...ZONE_RULES }, t)
      return
    }
    net.sendObjective(packRules(ZONE_RULES))
  }

  /** The objective now (sea time t): drawn on the sea, shown on the HUD, published for the radar. */
  update(t: number, eye: ArrayLike<number>, net: NetLike, ship: Ship | null, hidden = false): void {
    const view = this.view(t, net, ship)
    const crew = net.crew
    const me = crew ? playerOf(crew, net.id) : undefined
    const out: ZoneMark[] = []
    const draws = this.draws
    draws.length = 0
    if (view && view.end < 0) {
      const spin = (t * ZONE_LOOK.spin * Math.PI) / 180
      for (const [list, next] of [
        [view.zones, false],
        [view.next, true],
      ] as const) {
        for (const z of list) {
          const c = zoneCentre(z, t, this.c)
          const contested = bitCount(z.present) >= 2
          out.push({ id: z.id, label: ZONE_LABELS[z.id] ?? "?", x: c[0], z: c[1], r: z.r, holder: next ? -1 : z.holder, cap: next ? -1 : z.cap, progress: next ? 0 : z.progress, contested: !next && contested, next })
          const held = !next && z.holder >= 0
          // The boundary's arc is the progress of whoever it belongs to (a capturer's fill, or what is left of the
          // holder's while someone drains it); the rest of the boundary turns neutral.
          const arc = !next && z.cap >= 0
          draws.push({
            x: c[0],
            z: c[1],
            r: z.r,
            color: held ? teamColor(z.holder) : NEUTRAL,
            capColor: arc ? teamColor(z.cap) : NEUTRAL,
            progress: arc ? z.progress : 0,
            contested: !next && contested,
            next,
            spin: spin + z.id * 0.37,
          })
        }
      }
    }
    marks = out
    this.pass.update(t, eye, hidden ? [] : draws)
    this.hud.update(t, view, crew, me?.team ?? -1, hidden)
  }

  private view(t: number, net: NetLike, ship: Ship | null): ObjectiveView | null {
    if (net.state !== "offline") return net.objective
    if (!this.arch) return null
    if (!this.local || this.localSeed !== net.seed) {
      this.local = new Objective(this.arch, t, { ...ZONE_RULES })
      this.localSeed = net.seed
    }
    const crew = net.crew
    const me = crew ? playerOf(crew, net.id) : undefined
    const team = (me && crew && shipOf(crew, me.ship)?.team) ?? 0
    this.local.step(t, ship ? [{ team, x: ship.x, z: ship.z, active: true }] : [])
    return this.local.state
  }
}
