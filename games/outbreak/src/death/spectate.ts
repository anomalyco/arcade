import type { SurvivorSlot } from "../../shared/coop-sim"
export { lifeIn, spectateTarget } from "../../shared/death/spectate"
import type { LocalSession } from "../../shared/session"
import type { NetSession } from "../net-session"

/** The local survivor's slot: the offline session's own, or the room's predicted one. */
export function localSlot(session: LocalSession | NetSession): SurvivorSlot {
  return "local" in session ? session.local : session.slot
}
