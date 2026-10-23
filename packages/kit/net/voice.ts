/** Voice signalling shares the authenticated room socket. Audio never passes through the room. */
export type VoiceState = { proximity: boolean; radio: boolean }
export type VoiceMember = VoiceState & { id: string; session: string }
export type VoiceIceServer = { urls: string | string[]; username?: string; credential?: string }
export type VoiceSignal =
  | { description: { type: "offer" | "answer"; sdp: string } }
  | { candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment?: string | null } }
export type VoiceClientFrame =
  | { type: "voice.join" }
  | { type: "voice.leave" }
  | { type: "voice.refresh" }
  | { type: "voice.state"; state: VoiceState }
  | { type: "voice.signal"; to: string; session: string; signal: VoiceSignal }
export type VoiceServerFrame =
  | { type: "voice.ready"; id: string; session: string; iceServers: VoiceIceServer[]; relay: boolean }
  | { type: "voice.members"; members: VoiceMember[] }
  | { type: "voice.signal"; from: string; session: string; signal: VoiceSignal }

export const STUN_SERVERS: VoiceIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }]
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const short = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128

export function decodeVoiceClient(raw: unknown): VoiceClientFrame | null {
  if (typeof raw !== "string" || raw.length > 16_384) return null
  let m: unknown
  try { m = JSON.parse(raw) } catch { return null }
  if (!record(m)) return null
  if (m.type === "voice.join" || m.type === "voice.leave" || m.type === "voice.refresh") return { type: m.type }
  if (m.type === "voice.state" && record(m.state) && typeof m.state.proximity === "boolean" && typeof m.state.radio === "boolean") {
    return { type: m.type, state: { proximity: m.state.proximity, radio: m.state.radio } }
  }
  if (m.type !== "voice.signal" || !short(m.to) || !short(m.session) || !record(m.signal)) return null
  const d = m.signal.description, c = m.signal.candidate
  if (record(d) && (d.type === "offer" || d.type === "answer") && typeof d.sdp === "string" && d.sdp.length <= 12_000) {
    return { type: m.type, to: m.to, session: m.session, signal: { description: { type: d.type, sdp: d.sdp } } }
  }
  if (record(c) && typeof c.candidate === "string" && c.candidate.length <= 2048 && (c.sdpMid === null || short(c.sdpMid)) &&
      (c.sdpMLineIndex === null || (Number.isInteger(c.sdpMLineIndex) && Number(c.sdpMLineIndex) >= 0 && Number(c.sdpMLineIndex) <= 8)) &&
      (c.usernameFragment == null || short(c.usernameFragment))) {
    return { type: m.type, to: m.to, session: m.session, signal: { candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex as number | null, usernameFragment: c.usernameFragment as string | null | undefined } } }
  }
  return null
}

export type VoiceIce = { iceServers: VoiceIceServer[]; relay: boolean }
type Member = { public: VoiceMember; send: (m: VoiceServerFrame) => void; refreshed: number; ready: boolean }

/** Room-local, opt-in mesh of at most six authenticated seats. Sender identity is always supplied by RoomCore. */
export class VoiceRoom {
  private readonly members = new Map<string, Member>()
  private readonly credentials = new Map<string, { at: number; value: Promise<VoiceIce> }>()
  private tokens = 6
  private refillAt = 0
  constructor(private readonly ice: () => Promise<VoiceIce> = async () => ({ iceServers: STUN_SERVERS, relay: false }), private readonly clock = Date.now) {}

  message(id: string, msg: VoiceClientFrame, send: (m: VoiceServerFrame) => void): void {
    if (msg.type === "voice.leave") return this.leave(id)
    let member = this.members.get(id)
    if (msg.type === "voice.join") {
      if (member || this.members.size >= 6) return
      member = { public: { id, session: crypto.randomUUID(), proximity: false, radio: false }, send, refreshed: -Infinity, ready: false }
      this.members.set(id, member)
      this.refresh(id, member)
      return
    }
    if (!member) return
    if (msg.type === "voice.refresh") return this.refresh(id, member)
    if (msg.type === "voice.state") {
      if (member.public.proximity === msg.state.proximity && member.public.radio === msg.state.radio) return
      Object.assign(member.public, msg.state)
      return this.publish()
    }
    const target = this.members.get(msg.to)
    if (!target?.ready || !member.ready || target === member || target.public.session !== msg.session) return
    target.send({ type: "voice.signal", from: id, session: member.public.session, signal: msg.signal })
  }

  leave(id: string): void {
    if (this.members.delete(id)) this.publish()
  }

  private refresh(id: string, member: Member): void {
    if (this.clock() - member.refreshed < 60_000) return
    member.refreshed = this.clock()
    const now = this.clock()
    let issued = this.credentials.get(id)
    if (!issued || now - issued.at >= 30 * 60_000) {
      // Toggling voice or churning seats cannot turn this public game into an unbounded credential mint.
      this.tokens = Math.min(6, this.tokens + Math.max(0, now - this.refillAt) / 10_000)
      this.refillAt = now
      const value = this.tokens >= 1 ? (this.tokens--, this.ice().catch(() => ({ iceServers: STUN_SERVERS, relay: false }))) : Promise.resolve({ iceServers: STUN_SERVERS, relay: false })
      issued = { at: now, value }
      if (this.credentials.size >= 64) this.credentials.delete(this.credentials.keys().next().value!)
      this.credentials.set(id, issued)
    }
    void issued.value.then((ice) => {
      if (this.members.get(id) !== member) return
      member.send({ type: "voice.ready", ...member.public, ...ice })
      member.ready = true
      this.publish()
    })
  }

  private publish(): void {
    const ready = [...this.members.values()].filter((m) => m.ready)
    const frame: VoiceServerFrame = { type: "voice.members", members: ready.map((m) => ({ ...m.public })) }
    for (const m of ready) m.send(frame)
  }
}
