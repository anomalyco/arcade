import { Input as SharedInput } from "@arcade/kit/client/input"
import type { SpellId } from "../../shared/sim/spell-config"
export type { MuxState, MuxKey, MuxMouse } from "@arcade/kit/client/input"
export class Input extends SharedInput<SpellId> {
  override castSpell: () => SpellId = () => "moon"
}
