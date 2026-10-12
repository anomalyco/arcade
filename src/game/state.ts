import type { Rect } from "../../shared/geom"
import { type MapDef, getMap } from "../../shared/maps"
import type { RippleKind, SimEvent } from "../../shared/sim/world"
import type { Snapshot } from "../../shared/sim/view"

export type Ripple = { x: number; y: number; r: number; kind: RippleKind; t0: number; mine: boolean }
export type Tracer = { x0: number; y0: number; x1: number; y1: number; t0: number; life: number }
export type Killcam = { killer: string; victim: string; weapon: string; dist: number; x0: number; y0: number; x1: number; y1: number; t0: number; until: number }
export type FeedLine = { killer: string; victim: string; weapon: string; dist: number; t: number; me: boolean }
export type Toast = { text: string; until: number; tone: "normal" | "big" }

/** How long each ripple kind takes to expand, and how strong it reads. */
export const RIPPLE_STYLE: Record<RippleKind, { strength: number; jag: number }> = {
  step: { strength: 0.5, jag: 0 },
  shot: { strength: 1, jag: 0 },
  reload: { strength: 0.7, jag: 0 },
  glass: { strength: 1, jag: 0.16 },
  slam: { strength: 0.9, jag: 0 },
  creak: { strength: 0.4, jag: 0 },
  flare: { strength: 0.45, jag: 0 },
  decoy: { strength: 0.9, jag: 0 },
  emp: { strength: 1, jag: 0.12 },
  mine: { strength: 1, jag: 0.2 },
  thud: { strength: 0.6, jag: 0 },
}

export const RIPPLE_LIFE = (r: number) => 0.7 + r / 28

/**
 * Client-side view model. Snapshots set the world as the server currently sees it. Events add to what the player has
 * heard and seen: ripples expand, tracers fade, kills go to the feed, and the killcam runs for the victim.
 */
export class GameState {
  map: MapDef = getMap("warehouse")
  snap: Snapshot | null = null
  walls: Rect[] = []
  names = new Map<string, string>()
  teamOf = new Map<string, { team: number; key: string }>()
  ripples: Ripple[] = []
  tracers: Tracer[] = []
  feed: FeedLine[] = []
  toasts: Toast[] = []
  killcam: Killcam | null = null
  freezeUntil = 0
  /** Distance to the nearest enemy ring that landed in the last second, for the heartbeat. */
  nearRing = { d: Infinity, t: -10 }
  /** Set when a ring of any kind reaches you, so the HUD can flash. */
  lastSeen = { kind: "", t: -10 }
  private myId = ""

  setMap(id: string): void {
    if (this.map.id !== id) this.map = getMap(id)
  }

  onSnap(s: Snapshot, myId: string, now: number): void {
    this.snap = s
    this.myId = myId
    this.setMap(s.map)
    this.walls = [...this.map.walls]
    for (const d of s.doors) {
      if (!d.open) {
        const door = this.map.doors.find((x) => x.id === d.id)
        if (door) this.walls.push(door.rect)
      }
    }
    for (const r of s.roster) {
      this.names.set(r.id, r.name)
      this.teamOf.set(r.id, { team: r.team, key: r.key })
    }
    void now
  }

  onEvents(ev: SimEvent[], now: number, myPos: { x: number; y: number } | null): void {
    for (const e of ev) {
      switch (e.k) {
        case "ripple": {
          const mine = myPos !== null && Math.hypot(e.x - myPos.x, e.y - myPos.y) < 0.5
          this.ripples.push({ x: e.x, y: e.y, r: e.r, kind: e.kind, t0: now, mine })
          if (myPos && !mine && e.kind !== "flare" && e.kind !== "creak") {
            const d = Math.hypot(e.x - myPos.x, e.y - myPos.y)
            if (d <= e.r + 1) {
              if (d < this.nearRing.d || now - this.nearRing.t > 1) this.nearRing = { d, t: now }
              this.lastSeen = { kind: e.kind, t: now }
            }
          }
          break
        }
        case "shot":
          this.tracers.push({ x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, t0: now, life: 0.22 })
          break
        case "kill": {
          const me = e.victim === this.myId || e.killer === this.myId
          this.feed.unshift({ killer: this.names.get(e.killer) ?? "", victim: this.names.get(e.victim) ?? "", weapon: e.weapon, dist: e.dist, t: now, me })
          if (this.feed.length > 5) this.feed.length = 5
          if (e.victim === this.myId) this.freezeUntil = now + 0.25
          break
        }
        case "killcam":
          if (e.victim === this.myId) {
            this.killcam = { killer: this.names.get(e.killer) ?? "", victim: e.victim, weapon: e.weapon, dist: e.dist, x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, t0: now, until: now + 4 }
          }
          break
        case "toast":
          if (e.to.includes(this.myId)) this.toasts.push({ text: e.text, until: now + 2.4, tone: "normal" })
          break
        case "round":
          this.toasts.push({ text: e.winner === null ? `ROUND ${e.round} · DRAW` : `ROUND ${e.round} · ${e.label.toUpperCase()} WINS`, until: now + 4, tone: "big" })
          break
        case "match":
          this.toasts.push({ text: e.winner === null ? "MATCH · DRAW" : `${e.label.toUpperCase()} WINS THE MATCH`, until: now + 6, tone: "big" })
          break
        case "lamp":
          break
        case "door":
          break
      }
    }
  }

  prune(now: number): void {
    this.ripples = this.ripples.filter((r) => now - r.t0 < RIPPLE_LIFE(r.r) + 0.4)
    this.tracers = this.tracers.filter((t) => now - t.t0 < t.life)
    this.toasts = this.toasts.filter((t) => t.until > now)
    this.feed = this.feed.filter((f) => now - f.t < 7)
    if (this.killcam && now > this.killcam.until) this.killcam = null
  }
}
