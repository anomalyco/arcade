import { DriverVoice as Voice } from "../../../../packages/kit/vehicle/audio/synth"
import type { CarView } from "../../shared/sim/world"
export { EngineVoice, Transients, NitroVoice } from "../../../../packages/kit/vehicle/audio/synth"
export class DriverVoice extends Voice<CarView> {}
