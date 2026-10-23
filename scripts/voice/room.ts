/// <reference path="../../packages/kit/server/workers-shim.d.ts" />
import { RoomCore, type RoomFrame } from "../../packages/kit/net/room-core"
import { VoiceRoom } from "../../packages/kit/net/voice"
import { RoomObject } from "../../packages/kit/server/room-object"
import type { DurableObjectNamespace, Request as WorkerRequest } from "@cloudflare/workers-types"

type Hello = { type: "hello"; build: string }
type Frame = RoomFrame<never, never>
/** Tiny game adapter. The proof runs the production seat handshake, socket and voice relay in workerd. */
class Core extends RoomCore<Hello, number, never, never, null, Frame> {
  private players = new Set<string>()
  constructor(code: string) {
    super({ code, build: "voice-proof", title: "Voice proof", maxPlayers: 6, snapEvery: 30, inputs: { merge: (_, b) => b, standIn: (v) => v, hasEdges: () => false } })
    this.voice = new VoiceRoom(async () => ({ iceServers: [], relay: false }))
  }
  protected decode(raw: unknown): Hello | null {
    if (typeof raw !== "string" || raw.length > 1024) return null
    try { const m = JSON.parse(raw); return m?.type === "hello" && m.build === "voice-proof" ? m : null } catch { return null }
  }
  protected encode(m: Frame) { return JSON.stringify(m) }
  protected hasPlayer(id: string) { return this.players.has(id) }
  protected join(id: string) { this.players.add(id) }
  protected leave(id: string) { this.players.delete(id) }
  protected push() {}
  protected activity() { return false }
  protected handle() {}
  protected idleState() { return "rest" as const }
  protected stepWorld() {}
  protected takeEvents(): never[] { return [] }
  protected roster(): never[] { return [] }
  protected entities() { return null }
  protected snapshot(): Frame { return { type: "roster", players: [] } }
}
type Env = { ROOM: DurableObjectNamespace }
export class ProofRoom extends RoomObject<Env, Core> {
  protected readonly tickMs = 1000 / 30
  protected async open(code: string) { return this.core ??= new Core(code) }
  protected report() { return null }
  protected async send() {}
}
export default {
  fetch(req: WorkerRequest, env: Env) {
    const code = new URL(req.url).pathname.split("/").pop()!
    return env.ROOM.get(env.ROOM.idFromName(code)).fetch(req.url, { headers: { Upgrade: "websocket", "x-room": code } })
  },
}
