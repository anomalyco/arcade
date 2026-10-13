import { SmokeRenderer as SharedSmokeRenderer } from "@arcade/kit/fx/tyre-renderer"
import { common } from "./shaders"

/** Game binding adapter; the shared shader and simulation preserve the approved tyre look. */
export class SmokeRenderer extends SharedSmokeRenderer {
  constructor(device: GPUDevice, main: GPUBindGroupLayout) { super(device, main, common) }
}
