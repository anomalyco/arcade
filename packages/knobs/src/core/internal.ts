import type { Schema, State } from "./schema.js"

/**
 * Swaps a store's schema in place (see `RemoteControls.update`). Shared through the global symbol
 * registry, so the core and panel bundles agree on it.
 */
export const RESHAPE: unique symbol = Symbol.for("knobs.reshape") as never

export type Reshape = (schema: Schema, values: State, options?: { land?: boolean }) => void
