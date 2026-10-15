/**
 * Outbreak's pure types seam: shapes several features share, with no runtime code and no imports from simulation
 * modules, so any feature can depend on it without reaching into `coop-sim`, `progression` or another feature.
 */

export type NoticeKind = "result" | "info" | "warning"
/** Feedback for one survivor (search results, recipes learned, "Inventory full"), drained by its presentation. */
export type Notice = { text: string; kind: NoticeKind; key?: string }

/** A survivor's timed action as the HUD and the wire see it (searching, boarding up, tinkering). */
export type ChannelView = { kind: string; targetId: string; label: string; x: number; y: number; elapsed: number; duration: number }

/** A digit while a strip is open: take from the target, run a bench row, craft, or swap a pack slot in. */
export type PickMode = "take" | "bench" | "craft" | "pack"

/** A pistol view for combat: loaded rounds, capacity, belt reserve, spending and reloading. */
export type PistolAmmo = {
  readonly loaded: number
  readonly capacity: number
  readonly reserve: number
  spend(): boolean
  reload(): boolean
  fill(): void
}
