export type Gpu = { device: GPUDevice; context: GPUCanvasContext; format: GPUTextureFormat }

/**
 * Opens WebGPU on a game canvas: a high-performance adapter, timestamp queries when offered, uncaptured errors
 * logged, and the canvas configured opaque in the preferred format. Returns a message for the player instead when
 * WebGPU isn't available.
 */
export async function openGpu(canvas: HTMLCanvasElement, title: string): Promise<Gpu | string> {
  if (!navigator.gpu) return `${title} needs WebGPU. Use a recent Chrome, Edge or Safari over https or localhost.`
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) return "No WebGPU adapter is available on this device."
  const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has("timestamp-query") ? ["timestamp-query"] : [] })
  device.addEventListener("uncapturederror", (e) => console.error(`[gpu] ${e.error.message}`))
  const context = canvas.getContext("webgpu")!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  return { device, context, format }
}
