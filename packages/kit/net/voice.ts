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
  | { type: "voice.ready"; id: string; session: string; iceServers: VoiceIceServer[]; relay: boolean; retryAfterMs?: number }
  | { type: "voice.members"; members: VoiceMember[] }
  | { type: "voice.signal"; from: string; session: string; signal: VoiceSignal }

export const STUN_SERVERS: VoiceIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }]
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const short = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128

export function decodeVoiceClient(raw: unknown): VoiceClientFrame | null {
  if (typeof raw !== "string" || raw.length > 16_384 || !raw.includes('"voice.')) return null
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
type Bucket = { tokens: number; at: number }
function take(bucket: Bucket, now: number, rate: number, burst = rate): boolean {
  bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.at) * rate / 1000)
  bucket.at = now
  if (bucket.tokens < 1) return false
  bucket.tokens--
  return true
}
type Budget = { signals: Bucket; descriptions: Bucket; states: Bucket; joins: Bucket }
type Member = Budget & {
  public: VoiceMember; send: (m: VoiceServerFrame) => void; refreshAt: number; ready: boolean
  pending?: VoiceState; stateTimer?: ReturnType<typeof setTimeout>
}

/** Room-local, opt-in mesh of at most six authenticated seats. Sender identity is always supplied by RoomCore. */
export class VoiceRoom {
  private readonly members = new Map<string, Member>()
  private readonly budgets = new Map<string, Budget>()
  private readonly credentials = new Map<string, { at: number; value: Promise<VoiceIce> }>()
  private tokens = 6
  private refillAt = 0
  constructor(private readonly ice: () => Promise<VoiceIce> = async () => ({ iceServers: STUN_SERVERS, relay: false }), private readonly clock = Date.now) {}

  message(id: string, msg: VoiceClientFrame, send: (m: VoiceServerFrame) => void): void {
    if (msg.type === "voice.leave") return this.leave(id)
    let member = this.members.get(id)
    if (msg.type === "voice.join") {
      if (member || this.members.size >= 6) return
      const at = this.clock()
      let budget = this.budgets.get(id)
      if (!budget) {
        budget = { signals: { tokens: 40, at }, descriptions: { tokens: 5, at }, states: { tokens: 4, at }, joins: { tokens: 2, at } }
        if (this.budgets.size >= 64) this.budgets.delete(this.budgets.keys().next().value!)
        this.budgets.set(id, budget)
      }
      // Re-enrolling cannot reset a seat's limits or flood membership broadcasts.
      if (!take(budget.joins, at, 2)) return
      member = { public: { id, session: crypto.randomUUID(), proximity: false, radio: false }, send, refreshAt: -Infinity, ready: false,
        ...budget }
      this.members.set(id, member)
      this.refresh(id, member)
      return
    }
    if (!member) return
    if (msg.type === "voice.refresh") return this.refresh(id, member)
    if (msg.type === "voice.state") {
      member.pending = msg.state
      return this.publishState(member)
    }
    const target = this.members.get(msg.to)
    if (!target?.ready || !member.ready || target === member || target.public.session !== msg.session) return
    const now = this.clock()
    if (!take(member.signals, now, 20, 40)) return
    // Five descriptions can establish a full mesh; subsequent offers/answers share a 1/s budget.
    if ("description" in msg.signal && !take(member.descriptions, now, 1, 5)) return
    target.send({ type: "voice.signal", from: id, session: member.public.session, signal: msg.signal })
  }

  leave(id: string): void {
    const timer = this.members.get(id)?.stateTimer
    if (timer !== undefined) clearTimeout(timer)
    if (this.members.delete(id)) this.publish()
  }

  private publishState(member: Member): void {
    if (member.stateTimer !== undefined) clearTimeout(member.stateTimer)
    member.stateTimer = undefined
    const state = member.pending
    if (!state || (member.public.proximity === state.proximity && member.public.radio === state.radio)) { member.pending = undefined; return }
    if (!take(member.states, this.clock(), 4)) {
      // Coalesce a burst to its final state: dropping a key-up could leave a remote radio hissing forever.
      member.stateTimer = setTimeout(() => this.publishState(member), Math.ceil((1 - member.states.tokens) * 250))
      return
    }
    member.pending = undefined
    Object.assign(member.public, state)
    this.publish()
  }

  private refresh(id: string, member: Member): void {
    const now = this.clock()
    if (now < member.refreshAt) return
    member.refreshAt = now + 60_000
    let retryAfterMs: number | undefined
    let issued = this.credentials.get(id)
    if (!issued || now - issued.at >= 30 * 60_000) {
      // Toggling voice or churning seats cannot turn this public game into an unbounded credential mint.
      this.tokens = Math.min(6, this.tokens + Math.max(0, now - this.refillAt) / 10_000)
      this.refillAt = now
      if (this.tokens >= 1) {
        this.tokens--
        issued = { at: now, value: this.ice().catch(() => ({ iceServers: STUN_SERVERS, relay: false })) }
        if (this.credentials.size >= 64) this.credentials.delete(this.credentials.keys().next().value!)
        this.credentials.set(id, issued)
      } else {
        // This is admission backoff, not a credential result: don't cache it for thirty minutes.
        retryAfterMs = 10_000
        member.refreshAt = now + retryAfterMs
        issued = { at: now, value: Promise.resolve({ iceServers: STUN_SERVERS, relay: false }) }
      }
    }
    void issued.value.then((ice) => {
      if (this.members.get(id) !== member) return
      member.send({ type: "voice.ready", ...member.public, ...ice, ...(retryAfterMs ? { retryAfterMs } : {}) })
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
