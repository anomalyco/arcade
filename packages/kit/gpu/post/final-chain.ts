import type { FinalPass } from "../renderer"

/**
 * Several final passes in order (`Renderer.setFinalPass` takes one): the composite goes into the first active pass's
 * source, each active pass writes the next one's source, and the last writes the canvas. Inactive passes are skipped
 * each frame; with none active the renderer composites straight to the canvas, as with no final pass at all.
 */
export class FinalPassChain implements FinalPass {
  private live: FinalPass[] = []
  private size: [number, number] = [0, 0]

  constructor(readonly passes: readonly FinalPass[]) {}

  get active(): boolean {
    // Every pass is asked every frame: an inactive camera filter forgets its recording when asked.
    this.live = this.passes.filter(p => p.active)
    return this.live.length > 0
  }

  source(width: number, height: number): GPUTextureView {
    this.size = [width, height]
    return this.live[0]!.source(width, height)
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, frame: Float32Array): void {
    const [w, h] = this.size
    for (let i = 0; i < this.live.length; i++) {
      const next = this.live[i + 1]
      this.live[i]!.encode(encoder, next ? next.source(w, h) : target, frame)
    }
  }
}
