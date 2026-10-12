// Client module boundaries. main.ts (integrator) owns playback, input and networking;
// the renderer draws the world; the UI draws DOM overlays. Neither keeps game rules.
import type { Mask } from "../sim/terrain"
import type { Ghost, MatchView, Mode, PowerupId, SimEvent, Unit } from "../sim/protocol"
import type { WeaponId } from "../sim/weapons"

export interface Aim {
  angle: number
  power: number
  weapon: WeaponId
}

export interface LiveProjectile {
  id: number
  owner: number
  kind: WeaponId | "bomblet"
  x: number
  y: number
  vx: number
  vy: number
  // recent world-space points, oldest first: [x0,y0,x1,y1,...]
  trail: number[]
}

export interface FallingChunk {
  id: number
  canvas: HTMLCanvasElement
  x: number
  y: number
}

export interface Frame {
  now: number
  dt: number
  view: MatchView
  you: string | null
  // your unit id, or -1 when spectating
  yourUnit: number
  // units with playback-interpolated positions and hp
  units: Unit[]
  aim: Aim | null
  // world-space preview points for your aim (length limited by preview powerups)
  preview: number[] | null
  // other players' partial ghost arcs, already truncated, world space
  ghostArcs: Array<{ unit: number; pts: number[]; locked: boolean }>
  ghosts: Ghost[]
  projectiles: LiveProjectile[]
  chunks: FallingChunk[]
  fires: Array<{ x0: number; x1: number; y: number; until: number }>
  wells: Array<{ x: number; y: number; r: number; until: number }>
  // 0..1 slow-motion factor applied by playback (1 = normal), for post effects
  timeScale: number
  resolving: boolean
}

export interface Renderer {
  resize(width: number, height: number, dpr: number): void
  // full terrain rebuild from mask
  setTerrain(mask: Mask): void
  // the mask was mutated in place inside this world rect; rebuild just that region
  terrainChanged(x0: number, y0: number, x1: number, y1: number): void
  // spawn VFX/juice for a sim event at the moment playback reaches it
  event(ev: SimEvent, frame: Frame): void
  // trigger camera shake (0..1)
  shake(amount: number): void
  draw(frame: Frame): void
  screenToWorld(x: number, y: number): { x: number; y: number }
  worldToScreen(x: number, y: number): { x: number; y: number }
}

export type Screen = "title" | "lobby" | "game" | "shop" | "results"

export interface FeedEntry {
  id: number
  at: number
  text: string
  killer?: string
  victim?: string
  killerColor?: string
  victimColor?: string
  weapon?: WeaponId
}

export interface Profile {
  name: string
}

export interface UIState {
  screen: Screen
  view: MatchView | null
  you: string | null
  aim: Aim | null
  profile: Profile
  feed: FeedEntry[]
  roomLink: string
  online: boolean
  spectating: boolean
  // server time estimate in ms (use with view.phaseEndsAt)
  serverNow: number
  lastPickup: { kind: PowerupId; detail: string; at: number } | null
}

export interface UIActions {
  setName(name: string): void
  play(opts: { online: boolean; room?: string }): void
  start(opts: { mode: Mode; bots: number; battles: number }): void
  aim(aim: Partial<Aim>): void
  move(dir: -1 | 1): void
  lock(): void
  buy(item: string): void
  ready(): void
  leave(): void
}

export interface UI {
  // called every animation frame; implementations must diff and avoid DOM churn
  update(state: UIState): void
}
