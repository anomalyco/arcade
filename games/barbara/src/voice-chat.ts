import { VoiceChat, type VoiceGraph, type VoicePoint } from "@arcade/kit/voice"
import { bindVoiceKeys } from "@arcade/kit/voice/controls"
import { VoiceMarkers } from "@arcade/kit/voice/markers"
import { groundHeight, type WoodsWorld } from "../shared/world"
import type { WoodsAudio } from "./audio"
import { forestImpulse } from "./audio/soundscape"
import { trunksBetween } from "./audio/voices"
import type { FriendsView } from "./friends-view"
import type { Session } from "./session"

/** Forest queries stay in the game; transport, microphone state and both audio paths live in the kit. */
export function forestVoiceOcclusion(world: WoodsWorld, a: VoicePoint, b: VoicePoint): number {
  const distance = Math.hypot(b.x - a.x, b.z - a.z)
  for (let d = 1; d < distance; d += 2) {
    const t = d / distance
    if (groundHeight(world, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t) > a.y + (b.y - a.y) * t) return 1
  }
  return Math.min(1, trunksBetween(world, a.x, a.z, b.x, b.z) * 0.18)
}

export class WoodsVoice {
  readonly chat: VoiceChat
  private graph: VoiceGraph | null = null
  private limiter: DynamicsCompressorNode | null = null
  private readonly markers = new VoiceMarkers()
  private focused = true
  private wasBlocked = false
  private readonly abort = new AbortController()
  private readonly unbind: () => void

  constructor(private readonly audio: WoodsAudio, blocked: () => boolean) {
    this.chat = new VoiceChat({ audio: () => this.unlock(), changed: () => {
      audio.keepVoiceAlive(this.chat.enabled)
      if (!this.chat.enabled && this.graph) (this.graph.output as GainNode).gain.setValueAtTime(0, this.graph.ctx.currentTime)
    } })
    this.unbind = bindVoiceKeys(this.chat, blocked)
    const signal = this.abort.signal
    window.addEventListener("blur", () => { this.focused = false; this.chat.release() }, { signal })
    window.addEventListener("focus", () => { this.focused = true }, { signal })
  }

  private async unlock(): Promise<VoiceGraph> {
    this.audio.keepVoiceAlive(true)
    if (!await this.audio.bank.unlock()) throw new Error("Audio unavailable")
    const ctx = this.audio.bank.runtime.ctx
    if (!(ctx instanceof AudioContext)) throw new Error("Live audio unavailable")
    if (!this.graph) {
      // Independent of the world's paused mix and NPC Voices slider, but on the same context/listener.
      const output = ctx.createGain(), reverb = ctx.createConvolver(), limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -6; limiter.knee.value = 0; limiter.ratio.value = 20
      limiter.attack.value = 0.002; limiter.release.value = 0.12
      this.limiter = limiter
      output.connect(limiter).connect(ctx.destination)
      reverb.buffer = forestImpulse(ctx)
      reverb.connect(output)
      this.graph = { ctx, output, reverb }
    }
    return this.graph
  }

  frame(session: Session, world: WoodsWorld, friends: FriendsView, eye: readonly number[], yaw: number, matrix: ArrayLike<number>, playing: boolean, gain: number, blocked: boolean): void {
    const active = this.focused && !document.hidden
    const released = blocked || !active
    if (released && !this.wasBlocked) this.chat.release()
    this.wasBlocked = released
    const listener = { x: eye[0]!, y: eye[1]!, z: eye[2]! }
    const sources = new Map<string, VoicePoint>()
    if (this.chat.enabled) for (const r of session.roster()) {
      if (!r.connected || r.pid === session.me) continue
      const head = friends.head(r.pid, world)
      if (head) sources.set(r.id, { x: head[0], y: head[1], z: head[2] })
    }
    const occlusion = (a: VoicePoint, b: VoicePoint) => Math.hypot(b.x - a.x, b.z - a.z) < this.chat.spatial.distance ? forestVoiceOcclusion(world, a, b) : 0
    if (this.chat.enabled && this.graph) {
      const { ctx, output } = this.graph, l = ctx.listener, now = ctx.currentTime
      // Gate after the convolver too, so game mute silences an already-ringing forest tail.
      ;(output as GainNode).gain.setTargetAtTime(active ? gain : 0, now, 0.015)
      if (active && ctx.state === "suspended") void ctx.resume()
      l.positionX.setValueAtTime(listener.x, now); l.positionY.setValueAtTime(listener.y, now); l.positionZ.setValueAtTime(listener.z, now)
      l.forwardX.setValueAtTime(-Math.sin(yaw), now); l.forwardY.setValueAtTime(0, now); l.forwardZ.setValueAtTime(-Math.cos(yaw), now)
      l.upX.setValueAtTime(0, now); l.upY.setValueAtTime(1, now); l.upZ.setValueAtTime(0, now)
    }
    this.chat.update({ listener, source: (id) => sources.get(id) ?? null, occlusion }, active)
    // Do not give away a speaking friend's position through terrain/trunks or beyond the hearing range.
    const visible = [...sources].filter(([, p]) => Math.hypot(p.x - listener.x, p.y - listener.y, p.z - listener.z) < this.chat.spatial.distance && occlusion(listener, p) === 0)
    this.markers.update(this.chat, visible.map(([id, p]) => ({ id, point: { ...p, y: p.y + 0.35 } })), matrix, playing)
  }

  dispose(): void {
    this.unbind(); this.abort.abort(); this.chat.dispose(); this.markers.dispose()
    this.graph?.output.disconnect(); this.graph?.reverb?.disconnect()
    this.limiter?.disconnect()
    this.audio.keepVoiceAlive(false)
  }
}
