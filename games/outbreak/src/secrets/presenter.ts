import { Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { LIGHT_FLOATS } from "@arcade/kit/limits"
import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { dayCycle } from "../../shared/day-cycle"
import { sightRects, type Town } from "../../shared/map"
import { buildingAt } from "../../shared/progression/loot"
import { secretRoll, type SecretId } from "../../shared/secrets/catalog"
import { CELLAR_STASH, CELLAR_STORE, cellarLock } from "../../shared/secrets/cellar"
import type { SecretHost } from "../../shared/secrets/hosts"
import { secretSitesIn, type SecretSite } from "../../shared/secrets/places"
import { pulseLit, type SecretRun } from "../../shared/secrets/select"
import type { SessionView } from "../../shared/session"
import { playAmbientSound } from "../audio/soundscape/hooks"
import { supportHeight } from "../../shared/terrain"
import { crossedAfter, type GlanceKind } from "./drawings"
import * as M from "./models"

/** Draw pieces within this distance of the viewer (m); the mast further, it stands over the roofs. */
const RANGE = 42
const MAST_RANGE = 90

/** What the presenter needs from the frame. */
export type SecretFrame = {
  view: SessionView
  run: SecretRun
  hosts: ReadonlyMap<SecretId, SecretHost>
  /** The viewpoint (the local survivor, or who the dead watch). */
  me: { x: number; y: number; aim: number; flashlightOn: boolean }
  /** Teammates standing, for the phone (it only rings for someone alone). */
  mates: readonly { x: number; y: number }[]
  /** Nights begun so far this run (1 from the first dusk). */
  night: number
  dt: number
  vanish: number
  /** Plan-space bounds of the ground the screen shows. */
  screen: readonly [number, number, number, number]
  /** Lab stages: force the late chalk and an apparition now. */
  force: { lateChalk: boolean; apparition: "tallMan" | "procession" | "visitor" | null; ring: boolean }
}

/** What happened this frame that a client notices. */
export type SecretEvents = { noticed: SecretId[]; glance: { kind: GlanceKind; variant: number; key: string } | null }

type Apparition = { x: number; y: number; yaw: number; since: number; seen: number }

const FLASH_RANGE = 19
const FLASH_HALF = (28 * Math.PI) / 180
const VIEW_HALF = (55 * Math.PI) / 180

const angleTo = (from: { x: number; y: number }, x: number, y: number) => Math.atan2(y - from.y, x - from.x)
const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))
/** Model +z faces the point (x, y) from (fx, fy) with this yaw. */
const faceYaw = (fx: number, fy: number, x: number, y: number) => Math.atan2(-(x - fx), y - fy)

/**
 * Draws the secrets (`docs/outbreak-secrets.md`) from the shared placement, runs the presentation-only ones (the tall
 * man, the procession, the visitor, the rocking chair, the lit window, the phone) and says what the viewer noticed.
 * Everything is a function of the run, the clock and where the viewer stands; the cellar's lock reads the ledger.
 */
export class SecretsPresenter {
  private readonly models = new Map<string, number>()
  private readonly buffers = new Map<number, { data: Float32Array<ArrayBuffer>; count: number }>()
  private readonly out: Batch[] = []
  private readonly perBuilding = new Map<string, { key: string; sites: SecretSite[] }>()
  private sites: SecretSite[] = []
  private planKey = ""
  // Presentation-only state.
  private tall: Apparition | null = null
  private tallNext = 0
  private tallTried = -1
  private procession: { start: number; done: boolean; seen: number } | null = null
  private visitor: { used: boolean; showing: Apparition | null } = { used: false, showing: null }
  private rockerStill = false
  private rockSwing = true
  private windowOut = -Infinity
  private phone = { inside: 0, ringing: false, answered: -Infinity }
  private dwell = new Map<string, number>()
  private glanced = new Map<string, number>()
  private stashWas = -1
  private time = 0
  /** Proof readout. */
  readonly shown = { sites: 0, drawn: 0, tallMan: false, procession: 0, visitor: false, rocking: false, windowLit: false, ringing: false, setLit: false }

  constructor(private readonly renderer: Pick<Renderer, "addModel">) {}

  private model(key: string, build: () => Mesh): number {
    let id = this.models.get(key)
    if (id === undefined) {
      id = this.renderer.addModel(build())
      this.models.set(key, id)
    }
    return id
  }

  /** Forgets the run: a new session (Restart, New town, a new room). */
  reset(): void {
    this.perBuilding.clear()
    this.sites = []
    this.planKey = ""
    this.tall = null
    this.tallNext = 0
    this.tallTried = -1
    this.procession = null
    this.processionHead = null
    this.visitor = { used: false, showing: null }
    this.rockerStill = false
    this.windowOut = -Infinity
    this.phone = { inside: 0, ringing: false, answered: -Infinity }
    this.dwell.clear()
    this.glanced.clear()
    this.stashWas = -1
  }

  /** Every piece in the buildings in the world now. */
  plan(town: Town, run: SecretRun, hosts: ReadonlyMap<SecretId, SecretHost>): readonly SecretSite[] {
    const runKey = `${run.seed}:${run.houseSeed}:${[...run.picked].join(",")}:${[...hosts.values()].map((h) => h.buildingId).join(",")}`
    const key = `${runKey}:${town.buildings.length}:${town.props.length}:${town.buildings[0]?.id ?? ""}:${town.buildings.at(-1)?.id ?? ""}:${(town.vehicles ?? []).length}`
    if (key === this.planKey) return this.sites
    this.planKey = key
    const all: SecretSite[] = []
    for (const b of town.buildings) {
      const bk = `${runKey}:${b.rect.join(",")}`
      let hit = this.perBuilding.get(b.id)
      if (!hit || hit.key !== bk) {
        hit = { key: bk, sites: secretSitesIn(town, b, run, hosts) }
        this.perBuilding.set(b.id, hit)
      }
      for (const s of hit.sites) all.push(s)
    }
    if (this.perBuilding.size > 96) for (const id of this.perBuilding.keys()) if (!town.buildings.some((b) => b.id === id) && this.perBuilding.size > 64) this.perBuilding.delete(id)
    this.sites = all
    this.shown.sites = all.length
    return all
  }

  /** One frame: steps the presentation-only secrets and returns what the viewer noticed. */
  step(f: SecretFrame): SecretEvents {
    const ev: SecretEvents = { noticed: [], glance: null }
    const { view, run, me } = f
    const town = view.town
    this.time = view.time
    const sites = this.plan(town, run, f.hosts)
    const night = dayCycle(view.hour).lamps
    const dark = night > 0.35
    const here = buildingAt(town, me.x, me.y)?.id ?? null
    const lit = (x: number, y: number) => me.flashlightOn && Math.hypot(x - me.x, y - me.y) < FLASH_RANGE && angleDiff(me.aim, angleTo(me, x, y)) < FLASH_HALF
    const sees = (x: number, y: number, far = 46) => {
      const d = Math.hypot(x - me.x, y - me.y)
      if (d > far) return false
      if (d > 2.5 && angleDiff(me.aim, angleTo(me, x, y)) > VIEW_HALF) return false
      return clearLine(town, me.x, me.y, x, y)
    }

    // Glances: stand at a wall piece and look at it.
    let looking: SecretSite | null = null
    for (const s of sites) {
      if (s.piece !== "calendar" && s.piece !== "clock" && s.piece !== "photo" && s.piece !== "page" && s.piece !== "phone") continue
      if (s.buildingId !== here || distToRect(me.x, me.y, s.rect) > 0.15) continue
      if (angleDiff(me.aim, angleTo(me, s.x, s.y)) > 0.7) continue
      looking = s
      break
    }
    for (const k of this.dwell.keys()) if (k !== looking?.key) this.dwell.delete(k)
    if (looking && !(looking.piece === "phone" && !this.phone.ringing && this.phone.answered < view.time - 8)) {
      const t = (this.dwell.get(looking.key) ?? 0) + f.dt
      this.dwell.set(looking.key, t)
      if (t > 0.55 && (this.glanced.get(looking.key) ?? -Infinity) < view.time - 6) {
        this.glanced.set(looking.key, view.time)
        const kind: GlanceKind = looking.piece === "page" ? "page" : (looking.piece as GlanceKind)
        ev.glance = { kind, variant: looking.variant, key: looking.key }
        if (looking.piece !== "page" && looking.piece !== "phone") ev.noticed.push(looking.secret)
      }
    }

    // Close by: the chalk, the box, the footprints, the audience.
    for (const s of sites) {
      const d = Math.hypot(s.x - me.x, s.y - me.y)
      if (s.piece === "chalk" && d < 2.6) ev.noticed.push("chalk")
      else if (s.piece === "nod" && d < 2.2 && sees(s.x, s.y)) ev.noticed.push("nod")
      else if (s.piece === "footprint" && d < 1.2) ev.noticed.push("footprints")
      else if (s.piece === "chair" && s.secret === "audience" && here === s.buildingId && d < 4 && sees(s.x, s.y)) ev.noticed.push("audience")
    }

    // The cellar: there when it opens; his map held up once you have taken what he left.
    const ledger = view.progression.ledger
    const hatch = sites.find((s) => s.piece === "hatch")
    if (hatch) {
      const lock = cellarLock(ledger.store(CELLAR_STORE))
      const near = Math.hypot(hatch.x - me.x, hatch.y - me.y)
      if (lock.open && near < 6) ev.noticed.push("cellar")
      const left = ledger.store(CELLAR_STASH) ? view.progression.contents(CELLAR_STASH).length : -1
      if (this.stashWas > 0 && left === 0 && near < 3.5) ev.glance = { kind: "map", variant: 0, key: "map" }
      this.stashWas = left
    }

    // The lit window goes out when you come close; on again once you are well away.
    const pane = sites.find((s) => s.piece === "window")
    const wasLit = this.shown.windowLit
    this.shown.windowLit = false
    if (pane) {
      const d = Math.hypot(pane.x - me.x, pane.y - me.y)
      if (d < 9 && this.windowOut < view.time - 90) {
        if (wasLit) ev.noticed.push("litWindow")
        this.windowOut = view.time
      } else if (d < 30 && this.windowOut > -Infinity) this.windowOut = Math.max(this.windowOut, view.time - 89)
      this.shown.windowLit = dark && this.windowOut < view.time - 90
      if (wasLit && !this.shown.windowLit) playAmbientSound("scape.secret.click", pane.x, pane.y)
    }

    // The rocking chair rocks on its own until you come near or your torch finds it.
    const rocker = sites.find((s) => s.piece === "rocker")
    this.shown.rocking = false
    if (rocker) {
      const d = Math.hypot(rocker.x - me.x, rocker.y - me.y)
      if (d > 14) this.rockerStill = false
      else if (!this.rockerStill && dark && (d < 6 || lit(rocker.x, rocker.y))) {
        if (sees(rocker.x, rocker.y)) ev.noticed.push("rockingChair")
        this.rockerStill = true
      }
      this.shown.rocking = dark && !this.rockerStill
      const swing = Math.cos(view.time * 1.9) >= 0
      if (this.shown.rocking && swing !== this.rockSwing) playAmbientSound("scape.secret.rocking", rocker.x, rocker.y, swing ? undefined : { gain: 0.6, rate: 0.88 })
      this.rockSwing = swing
    }

    // The phone rings, silently, for someone alone in that house at night; it stops as they reach it.
    const phone = sites.find((s) => s.piece === "phone")
    this.shown.ringing = false
    if (phone) {
      const alone = !f.mates.some((m) => Math.hypot(m.x - me.x, m.y - me.y) < 12)
      const inside = here === phone.buildingId && dark && alone
      this.phone.inside = inside ? this.phone.inside + f.dt + (f.force.ring ? 5 : 0) : 0
      if (this.phone.ringing && Math.hypot(phone.x - me.x, phone.y - me.y) < 1.3) {
        this.phone.ringing = false
        this.phone.answered = view.time
        ev.noticed.push("phone")
        ev.glance = { kind: "phone", variant: 0, key: phone.key }
      } else if (!inside) this.phone.ringing = false
      else if (this.phone.inside > 4 && this.phone.answered < view.time - 60) this.phone.ringing = true
      this.shown.ringing = this.phone.ringing
    }

    this.stepTallMan(f, dark, sees, lit, ev)
    this.stepProcession(f, sees, lit, ev)
    this.stepVisitor(f, dark, ev)
    return ev
  }

  private stepTallMan(f: SecretFrame, dark: boolean, sees: (x: number, y: number) => boolean, lit: (x: number, y: number) => boolean, ev: SecretEvents): void {
    const { view, run, me } = f
    const forced = f.force.apparition === "tallMan"
    const on = run.picked.has("tallMan") || forced
    const outdoors = !buildingAt(view.town, me.x, me.y)
    if (!on || (!dark && !forced) || (!outdoors && !forced)) {
      this.tall = null
      this.shown.tallMan = false
      return
    }
    const t = view.time
    if (this.tall) {
      const a = this.tall
      const d = Math.hypot(a.x - me.x, a.y - me.y)
      const inSight = sees(a.x, a.y)
      if (inSight) a.seen += f.dt
      if (a.seen > 0.4) ev.noticed.push("tallMan")
      // Gone the moment he leaves your sight, when you come close, or when the torch lands on him.
      const gone = (a.seen > 0 && !inSight) || d < f.vanish || lit(a.x, a.y) || (a.seen === 0 && t - a.since > 25)
      if (gone && !forced) {
        this.tall = null
        this.tallNext = t + 120 + secretRoll(run, `tall-wait:${Math.floor(t)}`) * 120
      }
    } else if (forced || t >= this.tallNext) {
      const w = Math.floor(t / 75)
      if (forced || (w !== this.tallTried && secretRoll(run, `tall:${w}`) < 0.55)) {
        this.tallTried = w
        this.tall = this.tallSpot(view.town, me, f.screen, f.vanish, run, w, forced)
      }
    }
    this.shown.tallMan = Boolean(this.tall)
  }

  /**
   * At the edge of a lamp's pool ahead, between you and the lamp, so he stands dark against its light: on screen, past
   * where he vanishes.
   */
  private tallSpot(town: Town, me: { x: number; y: number; aim: number }, screen: SecretFrame["screen"], vanish: number, run: SecretRun, w: number, forced: boolean): Apparition | null {
    const [sx0, sy0, sx1, sy1] = screen
    const onScreen = (x: number, y: number) => x > sx0 + 2 && x < sx1 - 2 && y > sy0 + 2 && y < sy1 - 2
    const spots = town.lamps
      .filter((l) => (l.kind === "street" || l.kind === "porch") && l.power > 0)
      .map((l) => {
        const d = Math.hypot(l.x - me.x, l.y - me.y)
        const k = 2.2 / Math.max(1, d)
        return { l, d, x: l.x + (me.x - l.x) * k, y: l.y + (me.y - l.y) * k }
      })
      .filter((c) => Math.hypot(c.x - me.x, c.y - me.y) > vanish + 1 && c.d < 40 && angleDiff(me.aim, angleTo(me, c.l.x, c.l.y)) < 0.9 && onScreen(c.x, c.y))
      .sort((a, b) => a.l.x - b.l.x || a.l.y - b.l.y)
    const pick = spots[Math.floor(secretRoll(run, `tall-lamp:${w}`) * spots.length)]
    let x: number
    let y: number
    if (pick) {
      x = pick.x
      y = pick.y
    } else if (forced) {
      const reach = Math.max(vanish + 1, Math.min(Math.abs(Math.cos(me.aim)) > 0.5 ? (sx1 - sx0) / 2 : (sy1 - sy0) / 2, 26) - 3)
      x = me.x + Math.cos(me.aim) * reach
      y = me.y + Math.sin(me.aim) * reach
    } else return null
    if (buildingAt(town, x, y) || town.barriers.some((b) => distToRect(x, y, b.rect) < 0.4)) return null
    return { x, y, yaw: faceYaw(x, y, me.x, me.y), since: this.time, seen: 0 }
  }

  private stepProcession(f: SecretFrame, sees: (x: number, y: number) => boolean, lit: (x: number, y: number) => boolean, ev: SecretEvents): void {
    const { view, run, me } = f
    const forced = f.force.apparition === "procession"
    const h = ((view.hour % 24) + 24) % 24
    const due = run.picked.has("procession") && f.night === 3 && h >= 3 && h < 3.5 && !buildingAt(view.town, me.x, me.y)
    if (!this.procession && (due || forced)) {
      this.procession = { start: view.time, done: false, seen: 0 }
      this.processionHead = null
    }
    this.shown.procession = 0
    const p = this.procession
    if (!p || p.done) return
    const figures = this.processionFigures(me, f.screen, view.time - p.start, forced)
    let near = false
    let seenAny = false
    for (const fig of figures) {
      if (Math.hypot(fig.x - me.x, fig.y - me.y) < 6 || lit(fig.x, fig.y)) near = true
      if (!seenAny && sees(fig.x, fig.y)) seenAny = true
    }
    if (seenAny) p.seen += f.dt
    if (p.seen > 0.5) ev.noticed.push("procession")
    if ((near && !forced) || view.time - p.start > 150) p.done = true
    else this.shown.procession = figures.length
  }

  /** Nine of them in a column up the nearest north–south road, walking north, coming in from below the screen. */
  private processionFigures(me: { x: number; y: number }, screen: SecretFrame["screen"], t: number, forced = false): { x: number; y: number }[] {
    const roadX = Math.round((me.x - 44) / 96) * 96 + 44
    const x = Math.abs(roadX - me.x) < 12 ? roadX + (me.x < roadX ? 3.5 : -3.5) : roadX
    const head = this.processionHead ??= forced ? me.y - 4 : Math.min(me.y + 22, screen[3] + 2)
    const out: { x: number; y: number }[] = []
    for (let i = 0; i < 9; i++) out.push({ x: x + (i % 2 ? 0.5 : -0.5), y: head - t * 0.85 + i * 2.3 })
    return out
  }
  private processionHead: number | null = null

  private stepVisitor(f: SecretFrame, dark: boolean, ev: SecretEvents): void {
    const { view, run, me } = f
    const forced = f.force.apparition === "visitor"
    const peek = view.peek
    const v = this.visitor
    if (peek?.peephole && (forced || (run.picked.has("visitor") && !v.used && dark && f.night >= 2))) {
      if (!v.showing) {
        const dx = peek.eyeX - me.x
        const dy = peek.eyeY - me.y
        const d = Math.max(0.01, Math.hypot(dx, dy))
        const x = peek.eyeX + (dx / d) * 0.55
        const y = peek.eyeY + (dy / d) * 0.55
        v.showing = { x, y, yaw: faceYaw(x, y, me.x, me.y), since: view.time, seen: 0 }
      }
      v.showing.seen += f.dt
      if (v.showing.seen > 0.3) ev.noticed.push("visitor")
    } else if (v.showing) {
      v.showing = null
      if (!forced) v.used = true
    }
    this.shown.visitor = Boolean(v.showing)
  }

  /** This frame's instanced batches for what is near the viewer. */
  collect(f: SecretFrame): readonly Batch[] {
    this.out.length = 0
    for (const b of this.buffers.values()) b.count = 0
    const { view, run, me } = f
    const town = view.town
    const t = view.time
    const g = (x: number, y: number) => supportHeight(town, x, y)
    const night = dayCycle(view.hour).lamps
    const late = f.force.lateChalk || f.night >= 3 || (f.night >= 2 && night < 0.35)
    const ledger = view.progression.ledger
    let drawn = 0
    const put = (key: string, build: () => Mesh, x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0, tint: readonly [number, number, number] = [1, 1, 1], scale = 1) => {
      const id = this.model(key, build)
      let b = this.buffers.get(id)
      if (!b) this.buffers.set(id, (b = { data: new Float32Array(64 * INST_FLOATS), count: 0 }))
      if ((b.count + 1) * INST_FLOATS > b.data.length) {
        if (b.data.length >= 512 * INST_FLOATS) return
        const grown = new Float32Array(b.data.length * 2)
        grown.set(b.data)
        b.data = grown
      }
      b.data.set([x, y, z, yaw, tint[0], tint[1], tint[2], scale, pitch, roll, 1, 0], b.count++ * INST_FLOATS)
      drawn++
    }
    for (const s of this.sites) {
      const d = Math.max(Math.abs(s.x - me.x), Math.abs(s.y - me.y))
      if (d > (s.piece === "mast" ? MAST_RANGE : RANGE)) continue
      const y0 = g(s.x, s.y)
      switch (s.piece) {
        case "calendar": {
          put("calendar", M.calendarMesh, s.x, y0 + s.z, s.y, 0)
          const ring = M.calendarCell(run.day, run.firstWeekday)
          put("cal-ring", M.calendarRingMesh, s.x + ring.x, y0 + s.z + ring.y, s.y, 0)
          const last = run.day + crossedAfter(run)
          for (let day = 1; day <= last; day++) {
            if (day === run.day) continue
            const c = M.calendarCell(day, run.firstWeekday)
            put("cal-cross", M.calendarCrossMesh, s.x + c.x, y0 + s.z + c.y, s.y, 0)
          }
          break
        }
        case "clock": {
          put("clock", M.clockMesh, s.x, y0 + s.z, s.y)
          const ha = ((run.hour % 12) + run.minute / 60) / 12 * Math.PI * 2
          const ma = (run.minute / 60) * Math.PI * 2
          const stuck = ((run.minute * 7 + 13) % 60) / 60 * Math.PI * 2
          // The second hand tries for the next mark every second and falls back.
          const twitch = (t % 1) < 0.12 ? 0.08 : 0
          put("hand-h", () => M.handMesh(0.085, 0.014, 0.032), s.x, y0 + s.z, s.y, 0, -ha)
          put("hand-m", () => M.handMesh(0.125, 0.009, 0.035), s.x, y0 + s.z, s.y, 0, -ma)
          put("hand-s", () => M.handMesh(0.135, 0.003, 0.038), s.x, y0 + s.z, s.y, 0, -(stuck + twitch))
          break
        }
        case "photo": {
          const faces = s.variant & 15
          const scratched = s.variant >> 4
          put(`photo:${faces}:${scratched}`, () => M.photoMesh(faces, scratched), s.x, y0 + s.z, s.y)
          break
        }
        case "chalk":
          put(`chalk:${s.variant}:${late}`, () => M.chalkMesh(s.variant, late), s.x, y0, s.y, s.yaw)
          break
        case "nod":
          put("nod", M.nodBoxMesh, s.x, y0 + 0.016, s.y, s.yaw)
          break
        case "chair": {
          const lean = s.variant ? 0.05 : 0
          put("chair", M.chairMesh, s.x, y0 + 0.016, s.y, s.yaw, 0, lean)
          break
        }
        case "window": {
          if (!this.shown.windowLit) break
          const w = s.variant / 100
          const kw = w < 1.75 ? 1.5 : w < 2.25 ? 2 : 2.5
          const flick = 0.92 + 0.08 * Math.sin(t * 2.3) * Math.sin(t * 0.7)
          put(`pane:${kw}`, () => M.paneMesh(kw), s.x, y0, s.y + 0.012, 0, 0, 0, [2.2 * flick, 1.25 * flick, 0.5 * flick])
          break
        }
        case "footprint":
          put(`print:${s.variant}`, () => M.footprintMesh(s.variant === 1), s.x, y0 + 0.012, s.y, s.yaw)
          break
        case "phone": {
          put("phone", M.phoneMesh, s.x, y0 + s.z, s.y)
          const r = this.shown.ringing ? 1 : 0
          const jx = r * Math.sin(t * 61) * 0.004
          const jy = r * Math.abs(Math.sin(t * 37)) * 0.006
          put("handset", M.handsetMesh, s.x - 0.105 + jx, y0 + s.z + jy, s.y + 0.002, 0, r * Math.sin(t * 47) * 0.05)
          break
        }
        case "rocker": {
          const rock = this.shown.rocking ? Math.sin(t * 1.9) * 0.17 : 0
          put("rocker", M.rockerMesh, s.x, y0, s.y, s.yaw, 0, rock)
          break
        }
        case "hatch": {
          const lock = cellarLock(ledger.store(CELLAR_STORE))
          put("hatch-frame", M.hatchFrameMesh, s.x, y0 + 0.012, s.y)
          if (lock.open) {
            put("hatch-hole", M.hatchHoleMesh, s.x, y0 + 0.012, s.y)
            put("hatch-lid", M.hatchLidMesh, s.x, y0 + 0.04, s.y - 0.47, 0, 0, -1.95)
            put("padlock", M.padlockMesh, s.x + 0.72, y0 + 0.04, s.y + 0.3, 0.9, Math.PI / 2)
          } else {
            put("hatch-lid", M.hatchLidMesh, s.x, y0 + 0.014, s.y - 0.47)
            put("padlock", M.padlockMesh, s.x, y0 + 0.06, s.y + 0.47)
          }
          break
        }
        case "set": {
          const on = pulseLit(run.pulses, t)
          this.shown.setLit = on
          const k = on ? 2.6 : 0.1
          put("set", M.setMesh, s.x, y0 + s.z, s.y, s.yaw, 0, 0, [0.35 * k, 1 * k, 0.5 * k])
          break
        }
        case "page":
          put("page", M.pageMesh, s.x, y0 + s.z, s.y, s.yaw)
          break
        case "mast":
          put("mast", M.mastMesh, s.x, y0, s.y)
          break
      }
    }
    if (this.tall) put("tall", M.tallManMesh, this.tall.x, g(this.tall.x, this.tall.y), this.tall.y, this.tall.yaw)
    if (this.visitor.showing) {
      const v = this.visitor.showing
      put("tall", M.tallManMesh, v.x, g(v.x, v.y), v.y, v.yaw)
    }
    if (this.procession && !this.procession.done) {
      const figs = this.processionFigures(me, f.screen, t - this.procession.start)
      figs.forEach((p, i) => put("tall", M.tallManMesh, p.x, g(p.x, p.y) + Math.abs(Math.sin(t * 1.7 + i)) * 0.03, p.y, Math.PI + Math.sin(t * 0.8 + i) * 0.03))
    }
    for (const [model, b] of this.buffers) if (b.count) this.out.push({ model, data: b.data, count: b.count })
    this.shown.drawn = drawn
    return this.out
  }

  /** The lit window's glow on the ground outside it, and the radio man's set's green dial on its table. */
  writeLights(f: SecretFrame, lights: Float32Array, count: number, max: number): number {
    const town = f.view.town
    const add = (x: number, h: number, z: number, r: number, c: readonly [number, number, number], power: number) => {
      if (count >= max || power <= 0.01) return
      const o = count * LIGHT_FLOATS
      lights.fill(0, o, o + LIGHT_FLOATS)
      lights[o] = x
      lights[o + 1] = h
      lights[o + 2] = z
      lights[o + 3] = r
      lights[o + 4] = c[0]
      lights[o + 5] = c[1]
      lights[o + 6] = c[2]
      lights[o + 7] = power
      lights[o + 11] = -1
      lights[o + 14] = 0.12
      lights[o + 15] = -1
      count++
    }
    for (const s of this.sites) {
      if (Math.max(Math.abs(s.x - f.me.x), Math.abs(s.y - f.me.y)) > RANGE) continue
      if (s.piece === "window" && this.shown.windowLit) add(s.x, supportHeight(town, s.x, s.y) + 1.4, s.y + 0.9, 5.5, [1, 0.62, 0.3], 0.75)
      if (s.piece === "set" && this.shown.setLit) add(s.x, supportHeight(town, s.x, s.y) + s.z + 0.45, s.y + 0.3, 1.8, [0.35, 1, 0.5], 0.5)
    }
    return count
  }

  /** The pieces of a kind near a point, for stages and the dial overlay. */
  sitesOf(piece: SecretSite["piece"]): SecretSite[] {
    return this.sites.filter((s) => s.piece === piece)
  }
}

/** Is the line from (ax, ay) to (bx, by) clear of walls and shut doors? */
function clearLine(town: Town, ax: number, ay: number, bx: number, by: number): boolean {
  const rects = sightRects(town)
  const len = Math.hypot(bx - ax, by - ay)
  const n = Math.ceil(len / 0.4)
  const minX = Math.min(ax, bx) - 0.5
  const maxX = Math.max(ax, bx) + 0.5
  const minY = Math.min(ay, by) - 0.5
  const maxY = Math.max(ay, by) + 0.5
  const near: Rect[] = []
  for (const r of rects) if (r[2] > minX && r[0] < maxX && r[3] > minY && r[1] < maxY) near.push(r)
  for (let i = 1; i < n; i++) {
    const t = i / n
    const x = ax + (bx - ax) * t
    const y = ay + (by - ay) * t
    for (const r of near) if (x > r[0] && x < r[2] && y > r[1] && y < r[3]) return false
  }
  return true
}
