import type { Builder } from "../kit"
import type { StoreyContext, StoreyHandle } from "./types"
import { buildStorey } from "../storeys"

/** Storey 4: the abandoned floor (shared upper-storey template in ../storeys.ts, theme and finishes from THEMES / STYLES). */
export function build(b: Builder, { storey, pause }: StoreyContext): Promise<StoreyHandle> {
  return buildStorey(b, storey, pause)
}
