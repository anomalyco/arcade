import type { VoiceClientFrame, VoiceMember, VoiceServerFrame, VoiceSignal, VoiceState } from "../net/voice"
import { VoiceAudio } from "./audio"
import { VOICE_SPATIAL, unit, type VoicePoint, type VoiceSpatialSettings } from "./spatial"

export type VoiceWorld = {
  listener: VoicePoint
  source(id: string): (VoicePoint & { battery?: number }) | null
  occlusion(listener: VoicePoint, source: VoicePoint): number
}
export type VoiceGraph = { ctx: AudioContext; output: AudioNode; reverb?: AudioNode }
export type VoiceOptions = {
  /** Called on the opt-in gesture; unlocks the game's actual audio graph. */
  audio(): Promise<VoiceGraph>
  changed?(): void
}
type Peer = { member: VoiceMember; pc: RTCPeerConnection; queue: Promise<void>; candidates: RTCIceCandidateInit[]; source?: MediaStreamAudioSourceNode; audio?: VoiceAudio; playback?: HTMLAudioElement; retries: number; sentIce: number; receivedIce: number }

/** Ask for Opus DTX in the negotiated SDP. setCodecPreferences keeps telephone codecs out of the preferred slot. */
export function opusDtx(sdp: string): string {
  const opus = [...sdp.matchAll(/^a=rtpmap:(\d+) opus\/48000\/2\r?$/gm)].map((m) => m[1]!)
  for (const pt of opus) {
    const re = new RegExp(`^a=fmtp:${pt} (.*)\\r?$`, "m")
    if (re.test(sdp)) sdp = sdp.replace(re, (_, params: string) => `a=fmtp:${pt} ${params.trim().replace(/;?\s*usedtx=\d/g, "")};usedtx=1\r`)
    else sdp = sdp.replace(new RegExp(`(a=rtpmap:${pt} opus/48000/2\\r?\\n)`), `$1a=fmtp:${pt} usedtx=1\r\n`)
  }
  return sdp
}

export class VoiceChat {
  readonly spatial: VoiceSpatialSettings = { ...VOICE_SPATIAL }
  enabled = false
  pending = false
  micMuted = false
  mode: "open" | "push" = "open"
  volume = 1
  error = ""
  relay = false
  readonly muted = new Set<string>()
  private stream: MediaStream | null = null
  private graph: VoiceGraph | null = null
  private send: ((m: VoiceClientFrame) => void) | null = null
  private id = ""
  private session = ""
  private iceServers: RTCIceServer[] = []
  private readonly peers = new Map<string, Peer>()
  private generation = 0
  private held = { proximity: false, radio: false }
  private state: VoiceState = { proximity: false, radio: false }
  private refresh: ReturnType<typeof setInterval> | null = null
  private readonly listeners = new Set<() => void>()

  constructor(private readonly options: VoiceOptions) {}

  /** The sole getUserMedia entry point; construction, room joins and Settings renders never request permission. */
  async setEnabled(on: boolean): Promise<void> {
    if (on === this.enabled) return
    const generation = ++this.generation
    this.enabled = on
    this.error = ""
    if (!on) {
      this.pending = false
      this.send?.({ type: "voice.leave" })
      this.resetPeers()
      for (const t of this.stream?.getTracks() ?? []) t.stop()
      this.stream = null
      this.changed()
      return
    }
    this.pending = true
    this.changed()
    let stream: MediaStream | null = null
    try {
      // Start both from the gesture, but acquire the stream first so it can always be stopped on an audio failure.
      const graph = this.options.audio()
      void graph.catch(() => {})
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      for (const t of stream.getAudioTracks()) t.enabled = false
      const audio = await graph
      if (generation !== this.generation) { stream.getTracks().forEach((t) => t.stop()); return }
      this.stream = stream
      this.graph = audio
      stream.getAudioTracks()[0]!.onended = () => { void this.setEnabled(false); this.error = "Microphone disconnected. Switch Voice chat on to reconnect."; this.changed() }
      this.pending = false
      this.send?.({ type: "voice.join" })
    } catch {
      stream?.getTracks().forEach((t) => t.stop())
      if (generation !== this.generation) return
      this.enabled = false
      this.pending = false
      this.error = "Microphone unavailable. Check your browser’s microphone permission, then try again."
    }
    this.changed()
  }

  connected(send: (m: VoiceClientFrame) => void): void {
    this.disconnected()
    this.send = send
    if (this.enabled && this.stream) send({ type: "voice.join" })
  }
  disconnected(): void {
    this.send = null
    this.resetPeers()
    this.release()
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = false
  }
  private resetPeers(): void {
    for (const id of this.peers.keys()) this.remove(id)
    this.id = this.session = ""
    this.state = { proximity: false, radio: false }
    if (this.refresh) clearInterval(this.refresh)
    this.refresh = null
  }

  receive(frame: VoiceServerFrame): void {
    if (!this.enabled || !this.stream || !this.graph || !this.send) return
    if (frame.type === "voice.ready") {
      this.id = frame.id; this.session = frame.session
      this.iceServers = frame.iceServers
      this.relay = frame.relay
      for (const p of this.peers.values()) p.pc.setConfiguration({ iceServers: this.iceServers })
      if (!this.refresh) this.refresh = setInterval(() => this.send?.({ type: "voice.refresh" }), 30 * 60_000)
      this.changed()
      return
    }
    if (!this.session) return
    if (frame.type === "voice.members") {
      const others = frame.members.filter((m) => m.id !== this.id).slice(0, 5)
      for (const [id, p] of this.peers) if (!others.some((m) => m.id === id && m.session === p.member.session)) this.remove(id)
      for (const member of others) {
        const peer = this.peers.get(member.id)
        if (peer) peer.member = member
        else this.add(member)
      }
      return
    }
    const peer = this.peers.get(frame.from)
    if (!peer || peer.member.session !== frame.session) return
    this.enqueue(peer, async () => {
      const signal = frame.signal
      if ("candidate" in signal) {
        peer.receivedIce++
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.candidate)
        else if (peer.candidates.length < 64) peer.candidates.push(signal.candidate)
        return
      }
      // One offerer per pair means no negotiation glare, including ICE restarts.
      if (signal.description.type === "offer" && this.id < peer.member.id) return
      await peer.pc.setRemoteDescription(signal.description)
      for (const c of peer.candidates.splice(0)) await peer.pc.addIceCandidate(c)
      if (signal.description.type === "offer") {
        const answer = await peer.pc.createAnswer()
        answer.sdp = opusDtx(answer.sdp!)
        await peer.pc.setLocalDescription(answer)
        this.signal(peer, { description: { type: "answer", sdp: peer.pc.localDescription!.sdp } })
      }
    })
  }

  private add(member: VoiceMember): void {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    const peer: Peer = { member, pc, queue: Promise.resolve(), candidates: [], retries: 0, sentIce: 0, receivedIce: 0 }
    this.peers.set(member.id, peer)
    const track = this.stream!.getAudioTracks()[0]!
    // addTrack's transceiver is reused by an incoming offer; addTransceiver would leave the answer recvonly.
    const sender = pc.addTrack(track, this.stream!)
    const transceiver = pc.getTransceivers().find((t) => t.sender === sender)!
    const codecs = RTCRtpSender.getCapabilities("audio")?.codecs.filter((c) => c.mimeType.toLowerCase() === "audio/opus")
    if (codecs?.length) transceiver.setCodecPreferences(codecs)
    pc.onicecandidate = (e) => { if (e.candidate) { peer.sentIce++; this.signal(peer, { candidate: e.candidate.toJSON() as Required<Pick<RTCIceCandidateInit, "candidate" | "sdpMid" | "sdpMLineIndex">> }) } }
    pc.ontrack = (e) => {
      peer.source?.disconnect(); peer.audio?.dispose()
      if (peer.playback) { peer.playback.pause(); peer.playback.srcObject = null }
      const graph = this.graph!
      const stream = e.streams[0] ?? new MediaStream([e.track])
      // Chromium's remote WebRTC decoder needs a media sink even when WebAudio owns the audible path.
      const playback = new Audio()
      playback.muted = true
      playback.srcObject = stream
      peer.playback = playback
      void playback.play().catch(() => {})
      peer.source = graph.ctx.createMediaStreamSource(stream)
      peer.audio = new VoiceAudio(graph.ctx, graph.output, graph.reverb)
      peer.source.connect(peer.audio.input)
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        if (this.id < member.id && peer.retries++ < 2) this.offer(peer, true)
        else { this.error = this.relay ? "A voice connection failed. Toggle Voice chat to retry." : "A voice connection failed. This network may need a relay."; this.changed() }
      }
    }
    if (this.id < member.id) this.offer(peer)
  }

  private offer(peer: Peer, iceRestart = false): void {
    this.enqueue(peer, async () => {
      const offer = await peer.pc.createOffer({ iceRestart })
      offer.sdp = opusDtx(offer.sdp!)
      await peer.pc.setLocalDescription(offer)
      this.signal(peer, { description: { type: "offer", sdp: peer.pc.localDescription!.sdp } })
    })
  }
  private signal(peer: Peer, signal: VoiceSignal): void {
    if (this.peers.get(peer.member.id) === peer) this.send?.({ type: "voice.signal", to: peer.member.id, session: peer.member.session, signal })
  }
  private enqueue(peer: Peer, run: () => Promise<void>): void {
    peer.queue = peer.queue.then(async () => { if (this.peers.get(peer.member.id) === peer) await run() }).catch(() => {
      if (this.peers.get(peer.member.id) !== peer) return
      this.error = "A voice connection failed. Toggle Voice chat to retry."
      this.changed()
    })
  }
  private remove(id: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    this.peers.delete(id)
    peer.pc.ontrack = peer.pc.onicecandidate = peer.pc.onconnectionstatechange = null
    peer.pc.close(); peer.source?.disconnect(); peer.audio?.dispose()
    if (peer.playback) { peer.playback.pause(); peer.playback.srcObject = null }
  }

  hold(kind: "proximity" | "radio", on: boolean): void { this.held[kind] = on }
  release(): void {
    this.held.proximity = this.held.radio = false
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = false
    if (this.state.proximity || this.state.radio) {
      this.state = { proximity: false, radio: false }
      this.send?.({ type: "voice.state", state: this.state })
    }
  }
  toggleMic(): void { this.micMuted = !this.micMuted; this.changed() }
  setMode(mode: "open" | "push"): void { this.mode = mode; this.changed() }
  setVolume(volume: number): void { this.volume = unit(volume); this.changed() }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  mute(id: string, on: boolean): void { if (on) this.muted.add(id); else this.muted.delete(id); this.changed() }
  speaking(id: string): boolean {
    const p = this.peers.get(id)
    return !!p && !this.muted.has(id) && (p.member.proximity || p.member.radio) && (p.audio?.level() ?? 0) > 0.012
  }
  get transmitting(): boolean { return this.state.radio }

  /** World poses are rendered positions, not delayed authoritative snapshots. Mic activity is never game authority. */
  update(world: VoiceWorld, active: boolean, gain = 1): void {
    const can = this.enabled && !!this.session && !this.micMuted && active
    const state = { proximity: can && (this.mode === "open" || this.held.proximity || this.held.radio), radio: can && this.held.radio }
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = state.proximity || state.radio
    if (state.proximity !== this.state.proximity || state.radio !== this.state.radio) {
      this.state = state
      this.send?.({ type: "voice.state", state })
    }
    for (const [id, peer] of this.peers) {
      const source = world.source(id)
      peer.audio?.update(source ?? world.listener, world.listener, source ? world.occlusion(world.listener, source) : 0,
        !!source && peer.member.proximity, !!source && peer.member.radio,
        active && source && !this.muted.has(id) ? unit(this.volume) * unit(gain) : 0, source?.battery ?? 1, this.spatial)
    }
  }

  /** Read-only diagnostics for the two-client proof; contains no SDP, candidates or credentials. */
  diagnostics() {
    const media = (d: RTCSessionDescription | null) => d?.sdp.split(/\r?\n/).filter((l) => /^(m=audio|a=(sendrecv|recvonly|sendonly|inactive|rtpmap|fmtp))/.test(l))
    return { enabled: this.enabled, pending: this.pending, context: this.graph?.ctx.state, transmitting: this.stream?.getAudioTracks().some((t) => t.enabled), peers: [...this.peers].map(([id, p]) => ({ id, connection: p.pc.connectionState, ice: p.pc.iceConnectionState, gathering: p.pc.iceGatheringState, sentIce: p.sentIce, receivedIce: p.receivedIce, signalling: p.pc.signalingState, localMedia: media(p.pc.localDescription), remoteMedia: media(p.pc.remoteDescription), receivedTrack: !!p.source, level: p.audio?.level() ?? 0 })), error: this.error }
  }
  private changed(): void { this.options.changed?.(); for (const fn of this.listeners) fn() }
  dispose(): void { void this.setEnabled(false); this.disconnected() }
}
