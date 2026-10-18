import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { LabPanel } from "@arcade/kit/lab-panel"
import { describeQualityState, type AdaptiveQualityController } from "@arcade/kit/quality"
import { FrameClock, TICK_DT } from "../../shared/clock"
import { clockText } from "../../shared/day-cycle"

export interface OutbreakFramePacerHost {
  readonly device: GPUDevice
  readonly renderer: Renderer
  readonly qualityController: AdaptiveQualityController
  readonly lab: () => LabPanel
  readonly initialFrozen: boolean
  readonly isCoopPaused: () => boolean
  readonly isSampleLoading: () => boolean
  readonly liveMove: () => { mx: number; my: number; sprint: boolean }
  readonly releaseInput: () => void
  readonly stepSubsteps: (wallNow: number, clock: FrameClock) => number
  readonly draw: (dt: number) => void
  readonly hudSummaryContext: () => { hour: number; seed: number; livingZombies: number }
}

/**
 * Single-in-flight WebGPU frame pacer and fixed-tick `FrameClock` driver for Outbreak.
 * Coalesces RAF, un-nested `MessageChannel` wakeups, `device.queue.onSubmittedWorkDone()` GPU pacing,
 * and idle-to-moving `keydown` phase priming while updating the Lab header telemetry every 250 ms.
 */
export class OutbreakFramePacer {
  readonly clock = new FrameClock()
  private frozen: boolean
  private frames = 0
  private meterAt = performance.now()
  private meterSubmits: number
  private pendingDrawDt = 0
  private lastDrawAt = -Infinity
  private lastWallDrawAt = 0
  private pacerTimer = 0
  private rafScheduled = false
  private channelPending = false
  private readonly paceChannel = new MessageChannel()
  private gpuPacerPending = false
  private gpuPacerUntil = 0

  constructor(private readonly host: OutbreakFramePacerHost) {
    this.frozen = host.initialFrozen
    this.meterSubmits = host.renderer.submittedFrames
    this.paceChannel.port1.onmessage = () => {
      this.channelPending = false
      this.onPacerWake()
    }
    host.renderer.onIdle = () => {
      const now = performance.now()
      if (!this.frozen && !document.hidden && !host.isCoopPaused() && host.renderer.inflight === 0) {
        if (this.canDrawNow(now)) this.tick(now)
        else {
          if (this.pacerTimer) {
            clearTimeout(this.pacerTimer)
            this.pacerTimer = 0
          }
          this.scheduleFrame()
        }
      }
    }
    this.installListeners()
  }

  private installListeners(): void {
    window.addEventListener("keydown", () => {
      const now = performance.now()
      this.clock.recordMove(now, this.host.liveMove())
      if (!this.frozen && !document.hidden && this.canDrawNow(now)) this.tick(now)
      else this.scheduleFrame()
    })
    window.addEventListener("keyup", () => {
      const now = performance.now()
      this.clock.recordMove(now, this.host.liveMove())
      if (!this.frozen && !document.hidden && this.canDrawNow(now)) this.tick(now)
      else this.scheduleFrame()
    })
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.clock.pause(performance.now())
      else this.scheduleFrame()
    })
    window.addEventListener("blur", () => this.clock.pause(performance.now()))
    window.addEventListener("pointerdown", () => this.kickGpuPacer(150), true)
    window.addEventListener("keydown", () => {
      if (!this.frozen && !document.hidden && !this.host.isCoopPaused()) {
        const now = performance.now()
        if (this.clock.primeIdleMove(now, this.host.liveMove())) {
          this.lastDrawAt = -Infinity
          if (this.canDrawNow(now)) {
            this.tick(now)
          }
        }
      }
      this.kickGpuPacer(150)
    })
    window.addEventListener("keyup", () => this.kickGpuPacer(150), true)
  }

  onAudioTick(): void {
    if (!this.frozen && !document.hidden && !this.host.isCoopPaused()) {
      const now = performance.now()
      if (this.canDrawNow(now)) this.tick(now)
      else this.scheduleFrame()
    }
  }

  isFrozen(): boolean {
    return this.frozen
  }

  setFrozen(value = true): void {
    this.frozen = value
    if (this.pacerTimer) {
      clearTimeout(this.pacerTimer)
      this.pacerTimer = 0
    }
    this.pendingDrawDt = 0
    this.lastDrawAt = -Infinity
    this.host.releaseInput()
    this.clock.reset(performance.now(), this.host.liveMove())
    if (!this.frozen) {
      this.scheduleFrame()
      this.kickGpuPacer(150)
    }
  }

  incrementFrames(count = 1): void {
    this.frames += count
  }

  resetForSession(): void {
    this.pendingDrawDt = 0
    this.lastWallDrawAt = 0
    this.host.qualityController.reset()
    this.clock.reset(performance.now(), this.host.liveMove())
  }

  recordFrameStart(nowDraw: number): void {
    if (!this.frozen && this.lastWallDrawAt > 0) {
      this.host.qualityController.recordFrame(nowDraw - this.lastWallDrawAt, this.host.renderer.lastGpuMs, nowDraw)
    }
    this.lastWallDrawAt = nowDraw
  }

  updateMeter(meterNow: number): void {
    const elapsed = (meterNow - this.meterAt) / 1000
    if (elapsed > 0.25) {
      const lab = this.host.lab()
      const { renderer, qualityController } = this.host
      const { hour, seed, livingZombies } = this.host.hudSummaryContext()
      lab.header.textContent = `${Math.round((renderer.submittedFrames - this.meterSubmits) / elapsed)} draws/s · ${Math.round(this.frames / elapsed)} updates/s · ${renderer.drawnChunks} chunks · ${livingZombies} zombies\n${clockText(hour)} · seed ${seed}\n${describeQualityState(qualityController.state(devicePixelRatio))}`
      if (lab.visible) lab.refresh()
      this.frames = 0
      this.meterAt = meterNow
      this.meterSubmits = renderer.submittedFrames
    }
  }

  drawInitialFrame(): void {
    this.lastDrawAt = performance.now()
    this.host.draw(TICK_DT)
  }

  private canDrawNow(nowMs: number): boolean {
    return (
      this.host.renderer.inflight === 0 &&
      nowMs - this.lastDrawAt >= TICK_DT * 1000 - 0.65 &&
      (this.pendingDrawDt > 0 || this.clock.readyForStep(nowMs))
    )
  }

  private msUntilNextDraw(nowMs: number): number {
    const stepWait = this.pendingDrawDt > 0 ? 0 : this.clock.msUntilNextStep(nowMs)
    const paceWait = Math.max(0, TICK_DT * 1000 - 0.55 - (nowMs - this.lastDrawAt))
    return Math.max(stepWait, paceWait)
  }

  private onPacerWake(): void {
    if (this.frozen || document.hidden) return
    const now = performance.now()
    if (this.canDrawNow(now)) {
      this.tick(now)
    } else {
      this.scheduleFrame()
    }
  }

  scheduleFrame(): void {
    if (this.frozen || document.hidden) return
    if (!this.rafScheduled) {
      this.rafScheduled = true
      requestAnimationFrame(this.rafLoop)
    }
    if (this.host.isCoopPaused()) return
    if (!this.channelPending) {
      const now = performance.now()
      const rem = this.msUntilNextDraw(now)
      if (this.host.renderer.inflight === 0 && rem <= 0.35) {
        if (this.pacerTimer) {
          clearTimeout(this.pacerTimer)
          this.pacerTimer = 0
        }
        this.channelPending = true
        this.paceChannel.port2.postMessage(null)
      } else if (
        this.host.renderer.inflight === 0 &&
        (rem <= 3.6 || now < this.gpuPacerUntil || this.host.isSampleLoading())
      ) {
        if (this.pacerTimer) {
          clearTimeout(this.pacerTimer)
          this.pacerTimer = 0
        }
        this.kickGpuPacer(rem + 1.0)
      } else if (!this.pacerTimer) {
        const waitMs = Math.max(1, Math.floor(rem - 3.5))
        this.pacerTimer = window.setTimeout(() => {
          this.pacerTimer = 0
          this.onPacerWake()
        }, waitMs)
      }
    }
  }

  private readonly stepGpuPacer = (): void => {
    if (this.gpuPacerPending || this.frozen || document.hidden || this.host.isCoopPaused()) return
    const now = performance.now()
    if (this.canDrawNow(now)) {
      this.tick(now)
      if (performance.now() < this.gpuPacerUntil) queueMicrotask(this.stepGpuPacer)
      return
    }
    if (now >= this.gpuPacerUntil) return
    this.gpuPacerPending = true
    if (this.host.renderer.inflight === 0) {
      this.host.device.queue.submit([this.host.device.createCommandEncoder().finish()])
    }
    void this.host.device.queue.onSubmittedWorkDone().then(() => {
      this.gpuPacerPending = false
      if (this.frozen || document.hidden || this.host.isCoopPaused()) return
      const t = performance.now()
      if (this.canDrawNow(t)) {
        this.tick(t)
        if (performance.now() < this.gpuPacerUntil) queueMicrotask(this.stepGpuPacer)
      } else if (t < this.gpuPacerUntil) {
        this.stepGpuPacer()
      } else {
        this.scheduleFrame()
      }
    })
  }

  kickGpuPacer(durationMs = 150): void {
    this.gpuPacerUntil = Math.max(this.gpuPacerUntil, performance.now() + durationMs)
    this.stepGpuPacer()
  }

  private readonly rafLoop = (now: number): void => {
    this.rafScheduled = false
    const wallNow = performance.now()
    if (this.frozen) {
      this.clock.pause(wallNow)
      return
    }
    if (document.hidden || this.host.isCoopPaused()) {
      this.clock.pause(wallNow)
      this.rafScheduled = true
      requestAnimationFrame(this.rafLoop)
      return
    }
    if (this.canDrawNow(wallNow)) {
      this.tick(now)
    } else {
      this.scheduleFrame()
    }
  }

  private tick(now: number): void {
    void now
    if (this.pacerTimer) {
      clearTimeout(this.pacerTimer)
      this.pacerTimer = 0
    }
    const wallNow = performance.now()
    if (this.frozen || document.hidden || this.host.isCoopPaused()) {
      this.clock.pause(wallNow)
    } else {
      const mv = this.host.liveMove()
      if (mv.mx !== 0 || mv.my !== 0) {
        this.gpuPacerUntil = Math.max(this.gpuPacerUntil, wallNow + 100)
      }
      this.pendingDrawDt += this.host.stepSubsteps(wallNow, this.clock)
      if (this.pendingDrawDt > 0 && this.host.renderer.inflight === 0) {
        const dt = this.pendingDrawDt
        this.pendingDrawDt = 0
        this.lastDrawAt = wallNow
        this.host.draw(dt)
      }
    }
    this.scheduleFrame()
  }
}
