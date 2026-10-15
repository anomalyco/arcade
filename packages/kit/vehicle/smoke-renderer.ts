import { SmokeRenderer as SharedSmokeRenderer } from "../fx/tyre-renderer"

/** Compatibility adapter for the vehicle light layout. The GPU implementation is shared with FX. */
export class SmokeRenderer extends SharedSmokeRenderer {
  constructor(device: GPUDevice, main: GPUBindGroupLayout, common: string, cone?: string, depthFormat: GPUTextureFormat = "depth24plus-stencil8", base?: string, dust?: string) {
    super(device, main, common, depthFormat, cone, base, dust)
  }
}
