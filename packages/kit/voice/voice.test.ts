import { describe, expect, test } from "bun:test"
import { decodeVoiceClient, VoiceRoom, type VoiceServerFrame } from "../net/voice"
import { opusDtx } from "./client"
import { radioStatic, voiceSpatial } from "./spatial"

const flush = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)))
describe("voice signalling", () => {
  test("rejects malformed and oversized payloads, strips a forged sender", () => {
    for (const raw of ["null", "[]", "bad", JSON.stringify({ type: "voice.state", state: { radio: 1, proximity: true } }), JSON.stringify({ type: "voice.signal", to: "b", session: "s", signal: { description: { type: "rollback", sdp: "" } } }), " ".repeat(16_385)]) expect(decodeVoiceClient(raw)).toBeNull()
    expect(decodeVoiceClient(JSON.stringify({ type: "voice.signal", from: "victim", to: "b", session: "s", signal: { description: { type: "offer", sdp: "v=0" } } }))).toEqual({ type: "voice.signal", to: "b", session: "s", signal: { description: { type: "offer", sdp: "v=0" } } })
  })

  test("only enrolled members in this room signal, stale sessions cannot reach a reconnect", async () => {
    const room = new VoiceRoom(), a: VoiceServerFrame[] = [], b: VoiceServerFrame[] = []
    room.message("a", { type: "voice.join" }, (m) => a.push(m))
    room.message("b", { type: "voice.join" }, (m) => b.push(m))
    await flush()
    const ready = b.find((m) => m.type === "voice.ready")!
    if (ready.type !== "voice.ready") throw new Error("missing ready")
    const offer = { type: "voice.signal", to: "b", session: ready.session, signal: { description: { type: "offer", sdp: "v=0" } } } as const
    b.length = 0
    room.message("outsider", offer, () => {})
    new VoiceRoom().message("a", offer, () => {})
    expect(b).toHaveLength(0)
    room.message("a", offer, () => {})
    expect(b[0]).toMatchObject({ type: "voice.signal", from: "a" })
    room.leave("b")
    room.message("b", { type: "voice.join" }, (m) => b.push(m))
    await flush()
    b.length = 0
    room.message("a", offer, () => {})
    expect(b).toHaveLength(0)
  })

  test("caps mesh at six, throttles TURN refresh and ignores credentials resolving after leave", async () => {
    let calls = 0
    const room = new VoiceRoom(async () => { calls++; return { iceServers: [], relay: false } })
    const messages: VoiceServerFrame[] = []
    for (let i = 0; i < 7; i++) room.message(String(i), { type: "voice.join" }, (m) => messages.push(m))
    room.message("0", { type: "voice.refresh" }, () => {})
    room.leave("0")
    await flush()
    expect(calls).toBe(6)
    expect(messages.filter((m) => m.type === "voice.ready")).toHaveLength(5)
    expect(messages.filter((m) => m.type === "voice.members").every((m) => m.type === "voice.members" && m.members.every((p) => p.id !== "0" && p.id !== "6"))).toBe(true)
  })
})

test("nearby speech fades out completely, including reverb; occlusion darkens and attenuates it", () => {
  const near = voiceSpatial(2, 0), far = voiceSpatial(30, 0), blocked = voiceSpatial(2, 1)
  expect(near.gain).toBe(1)
  expect(far.gain).toBeLessThan(near.gain * 0.2)
  expect(blocked.gain).toBeLessThan(near.gain * 0.5)
  expect(blocked.cutoff).toBeCloseTo(650)
  expect(voiceSpatial(36, 0).gain).toBe(0)
  expect(voiceSpatial(100, 1).wet).toBe(0)
  expect(voiceSpatial(34.3, 0).delay).toBeCloseTo(0.1)
  expect(radioStatic(300, 0)).toBeGreaterThan(radioStatic(10, 1))
})

test("Opus DTX negotiation is idempotent and preserves other codec parameters", () => {
  const sdp = "v=0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n"
  const result = opusDtx(sdp)
  expect(result).toContain("minptime=10;useinbandfec=1;usedtx=1\r\n")
  expect(opusDtx(result)).toBe(result)
})
