import type { StoreyModule } from "./types"
import * as s0 from "./s0"
import * as s1 from "./s1"
import * as s2 from "./s2"
import * as s3 from "./s3"
import * as s4 from "./s4"

/** One content module per storey, indexed by storey number. Replace an entry to rebuild that storey. */
export const STOREY_MODULES: readonly StoreyModule[] = [s0, s1, s2, s3, s4]
export type { StoreyContext, StoreyHandle, StoreyModule } from "./types"
