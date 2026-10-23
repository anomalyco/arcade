import type { FinalPass } from "../renderer"

/** A final pass that can draw its last picture again without its source (`CameraArtifacts`). */
export type RepeatablePass = FinalPass & { repeat(encoder: GPUCommandEncoder, target: GPUTextureView): boolean }
/** A final pass whose clocks move on frames the chain does not draw through it (`CameraFilter`, `CameraArtifacts`). */
export type SkippablePass = FinalPass & { skip(frame: Float32Array): void }

/**
 * Several final passes in order (`Renderer.setFinalPass` takes one): the composite goes into the first active pass's
 * source, each active pass writes the next one's source, and the last writes the canvas. Inactive passes are skipped
 * each frame; with none active the renderer composites straight to the canvas, as with no final pass at all.
 *
 * Held frames: when a pass holds (a 30 fps camera between its frames, `FinalPass.holds`) nothing before it runs, the
 * composite included, and if the last pass can `repeat` its own last picture, that one copy is the whole chain. Each
 * pass left out is told it was (`skip`), so its clocks keep moving.
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
    // Every live pass sized now, so `holds` answers for this frame's targets.
    for (let i = this.live.length - 1; i > 0; i--) this.live[i]!.source(width, height)
    return this.live[0]!.source(width, height)
  }

  holds(frame: Float32Array): boolean {
    return this.held(frame) >= 0
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, frame: Float32Array): void {
    const [w, h] = this.size
    const live = this.live, last = live.length - 1
    const held = this.held(frame)
    const skip = (to: number) => { for (let i = 0; i < to; i++) (live[i] as Partial<SkippablePass>).skip?.(frame) }
    if (held >= 0 && held < last && (live[last] as Partial<RepeatablePass>).repeat?.(encoder, target)) return skip(last)
    skip(held)
    for (let i = Math.max(0, held); i <= last; i++) live[i]!.encode(encoder, i < last ? live[i + 1]!.source(w, h) : target, frame)
  }

  /** The last live pass holding this frame, or -1. */
  private held(frame: Float32Array): number {
    for (let i = this.live.length - 1; i >= 0; i--) if (this.live[i]!.holds?.(frame)) return i
    return -1
  }
}
