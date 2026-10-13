import { DriverVoice as Voice } from "@arcade/kit/vehicle/audio/synth"
import type { CarView } from "../../shared/sim/world"
export { EngineVoice, Transients, NitroVoice } from "@arcade/kit/vehicle/audio/synth"
export class DriverVoice extends Voice<CarView> {}
