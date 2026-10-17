import type { Builder } from "../kit"
import type { StoreyContext, StoreyHandle } from "./types"
import { buildCorridor } from "../corridor"
import { buildLobby } from "../lobby"
import { placeProps } from "../props"
import { buildCloset, buildLab } from "../rooms"
import { groundWindows } from "../storeys"

/** Ground floor: lobby (r5-02), link and main corridor (r3-02), the lab (r5-05), the janitor's closet, blinds behind
 *  the other ground-floor windows. */
export async function build(b: Builder, { pause }: StoreyContext): Promise<StoreyHandle> {
  buildLobby(b)
  await pause()
  const corridor = buildCorridor(b)
  await pause()
  buildLab(b)
  await pause()
  buildCloset(b)
  groundWindows(b)
  placeProps(b)
  return { update: corridor.update, proxy: null }
}
