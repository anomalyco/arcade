import { SmokeRenderer as SharedSmokeRenderer } from "../../../../packages/kit/vehicle/smoke-renderer"
import { common } from "./shaders"
export class SmokeRenderer extends SharedSmokeRenderer {
  constructor(device: GPUDevice, main: GPUBindGroupLayout) { super(device, main, common) }
}
