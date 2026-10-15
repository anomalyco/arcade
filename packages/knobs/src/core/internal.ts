import type { Schema, State } from "./schema.js"

/**
 * Swaps a store's schema in place (see `RemoteControls.update`). Shared through the global symbol
 * registry, so the core and panel bundles agree on it.
 */
export const RESHAPE: unique symbol = Symbol.for("knobs.reshape") as never

export type Reshape = (
  schema: Schema,
  values: State,
  options?: { land?: boolean; mixed?: readonly string[] },
) => void

/**
 * What a remote store hears from `reset(keys)` in place of an `onReset({ key })` per key, so it
 * can send the keys' resets together (see `RemoteControlsOptions.onSetBatch`).
 */
export const RESET_KEYS: unique symbol = Symbol.for("knobs.resetKeys") as never

export type ResetKeys = (keys: readonly string[]) => void

/** How many times `controls.refresh()` was called: panels ask their accessories again when it moves. */
export const REFRESHES: unique symbol = Symbol.for("knobs.refreshes") as never
