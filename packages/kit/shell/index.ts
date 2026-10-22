import type { VolumeChannel } from "../audio/volume"
import { GameQuality, type GameQualityOptions } from "../client/quality"
import type { QualityScaling } from "../quality"
import { ShellFlow, type ShellFlowOptions } from "./flow"
import { ShellLobby, type ShellLobbyOptions } from "./lobby"
import { LEAVE_GUARD_AFTER_MS, LeaveGuard, ShellLoading } from "./page"
import { ShellSettings, type ShellQuality, type ShellSection } from "./settings"
import { ShellView, type ShellViewOptions } from "./view"

export { ShellFlow, type ShellFlowOptions, type ShellScreen } from "./flow"
export { ShellLobby, type LobbyConnection, type LobbyPlayer, type ShellLobbyOptions } from "./lobby"
export { LEAVE_GUARD_AFTER_MS, LeaveGuard, ShellLoading, type LoadingStage } from "./page"
export { CHANNEL_LABEL, REDUCE_MOTION_STORAGE_KEY, ShellSettings, muteStorageKey, type ShellQuality, type ShellRow, type ShellSection, type ShellSettingsOptions } from "./settings"
export { audioRuntimeSync, type ShellAudioRuntime } from "./audio"
export { SHELL_CSS, ShellView, installShellStyles, shellKeysHtml, type ShellViewOptions } from "./view"

/**
 * A game's quality on the shell's policy: Auto starts at High and steps down only on measured slow frames, the pick
 * is saved per game, and `?quality=` pins a mode for automation. Same API as `GameQuality`.
 */
export function createShellQuality<P extends QualityScaling>(options: Omit<GameQualityOptions<P>, "stepDown">): GameQuality<P> {
  return new GameQuality({ ...options, stepDown: "slow-frames" })
}

export type GameShellOptions = Omit<ShellViewOptions, "muteKey"> & {
  /** The game's id (storage keys, `<game>.name`). */
  game: string
  /** Volume channels, master first; `[]` for a silent game (no Sound section, mute button or M key). */
  channels?: readonly VolumeChannel[]
  labels?: Partial<Record<VolumeChannel, string>>
  quality?: ShellQuality | null
  sections?: readonly ShellSection[]
  legacyMuteKey?: string
  legacyReduceMotionKey?: string
  /**
   * M toggles mute (default true). Outbreak keeps M for its map and mutes from the speaker button; Archers turns it
   * off while the keyboard is split (M is the right-hand player's jump).
   */
  muteKey?: boolean | (() => boolean)
  /** Keys belong to something else right now (typing in the Lab panel or chat): the shell ignores M and Escape. */
  keysBlocked?: () => boolean
  /** Rooms: Play with friends, invite, players, ready and start. Omit for single-player games. */
  lobby?: Omit<ShellLobbyOptions, "game">
  /** The loading plan (stage weights); omit when the game has its own loading screen or loads instantly. */
  loading?: Record<string, number> | false
  /**
   * When closing the tab asks first. Default: in a room, or after 30 s of solo play. `false` never asks.
   */
  leaveGuard?: false | (() => boolean)
  /** Leave from the pause menu (the shell returns to the title afterwards). */
  onLeave?: () => void
  /** Headless: no DOM view (the game draws the models itself). */
  view?: boolean
  /**
   * Hide every overlay (title, pause, loading) so captures and smoke runs see the game. Default: under automation
   * (navigator.webdriver) unless the URL has `?shell`, which proofs of the shell itself add.
   */
  hidden?: boolean
  root?: HTMLElement
} & Pick<ShellFlowOptions, "pointerLock" | "blocked" | "escapeOwned" | "pauseOnHidden" | "start">

/** Everything the shell owns for one game; see docs/game-shell.md. */
export class GameShell {
  readonly settings: ShellSettings
  readonly flow: ShellFlow
  readonly lobby: ShellLobby | null
  readonly loading: ShellLoading | null
  readonly view: ShellView | null
  readonly guard: LeaveGuard | null
  /** Overlays are hidden for automation (see `GameShellOptions.hidden`). */
  readonly hidden: boolean
  private playedMs = 0
  private lastTick = 0
  private wasStarted = false
  private readonly offs: (() => void)[] = []

  constructor(o: GameShellOptions) {
    this.settings = new ShellSettings({ game: o.game, channels: o.channels, labels: o.labels, quality: o.quality, sections: o.sections, legacyMuteKey: o.legacyMuteKey, legacyReduceMotionKey: o.legacyReduceMotionKey })
    const automated = typeof navigator !== "undefined" && Boolean(navigator.webdriver)
    const hidden = o.hidden ?? (automated && !(typeof location !== "undefined" && new URLSearchParams(location.search).has("shell")))
    this.hidden = hidden
    this.flow = new ShellFlow({
      pointerLock: o.pointerLock,
      blocked: () => hidden || Boolean(o.blocked?.()),
      escapeOwned: () => Boolean(o.escapeOwned?.() || o.keysBlocked?.()),
      pauseOnHidden: o.pauseOnHidden,
      // Hidden, a game without pointer lock starts in play (nobody will click Play); a pointer-lock game starts when it takes the lock.
      start: o.start ?? (hidden && !o.pointerLock ? "playing" : "title"),
    })
    this.lobby = o.lobby ? new ShellLobby({ game: o.game, ...o.lobby }) : null
    this.loading = o.loading ? new ShellLoading(o.loading) : null
    this.view = o.view === false || typeof document === "undefined" ? null : new ShellView(o.root ?? document.body, { ...o, muteKey: o.muteKey !== false && this.settings.channels.length > 0 }, this.settings, this.flow, this.lobby, hidden ? null : this.loading)
    const guard = o.leaveGuard
    this.guard = guard === false ? null : new LeaveGuard(guard ?? (() => Boolean(this.lobby?.room) || (this.flow.started && this.playedMs >= LEAVE_GUARD_AFTER_MS)))
    const onLeave = o.onLeave
    this.offs.push(
      this.flow.subscribe(() => {
        if (!this.flow.started) {
          this.playedMs = 0
          if (this.wasStarted) onLeave?.()
        }
        this.wasStarted = this.flow.started
      }),
    )
    this.wasStarted = this.flow.started
    const muteKeyOn = o.muteKey !== false && this.settings.channels.length > 0
    if (muteKeyOn && typeof window !== "undefined") {
      const muteKey = typeof o.muteKey === "function" ? o.muteKey : () => true
      const key = (e: KeyboardEvent) => {
        if (e.code !== "KeyM" || !muteKey() || e.repeat || e.metaKey || e.ctrlKey || e.altKey || o.keysBlocked?.() || isEditable(e.target)) return
        this.settings.toggleMute()
      }
      window.addEventListener("keydown", key)
      this.offs.push(() => window.removeEventListener("keydown", key))
    }
  }

  /** Is the game being played right now (not on the title or paused)? */
  get playing(): boolean {
    return this.flow.screen === "playing"
  }

  /** Call once a frame with rAF time: counts play time for the leave guard. */
  tick(now: number): void {
    if (this.lastTick > 0 && this.playing) this.playedMs += Math.min(250, now - this.lastTick)
    this.lastTick = now
  }

  dispose(): void {
    for (const off of this.offs) off()
    this.view?.dispose()
    this.flow.dispose()
    this.guard?.dispose()
  }
}

export const createGameShell = (o: GameShellOptions) => new GameShell(o)

function isEditable(t: EventTarget | null): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null
  const tag = el?.tagName?.toUpperCase() ?? ""
  return Boolean(el?.isContentEditable) || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}
