import { expect, test } from "bun:test"
import { type ChatMsg, type ServerMsg, decodeServer, encodeClient } from "../shared/protocol"
import { type Conn, RoomCore } from "../server/core"

function join(core: RoomCore, name: string) {
  const msgs: ServerMsg[] = []
  const conn: Conn = { send: (d) => msgs.push(decodeServer(d)!), close: () => core.close(conn) }
  core.open(conn)
  core.message(conn, encodeClient({ type: "hello", name, picks: { robber: "muscle", cop: "cruiser" } }))
  const say = (text: string) => core.message(conn, JSON.stringify({ type: "chat", text }))
  const chats = () => msgs.filter((m): m is ChatMsg => m.type === "chat" && m.role !== "system")
  return { say, chats, msgs }
}

test("chat is cleaned, broadcast and rate limited", () => {
  const core = new RoomCore("CHAT")
  const a = join(core, "Ann")
  const b = join(core, "Bob")
  expect(a.msgs.some((m) => m.type === "chat" && m.role === "system" && m.name === "Bob")).toBe(true)
  a.say("  hi\u0000 there\u202e ")
  a.say("   ")
  a.say("x".repeat(500))
  a.say("third")
  a.say("dropped")
  expect(b.chats().map((m) => m.text)).toEqual(["hi there", "x".repeat(140), "third"])
  expect(b.chats()[0]!.name).toBe("Ann")
  for (let i = 0; i < 30; i++) core.step()
  a.say("after")
  expect(b.chats().at(-1)!.text).toBe("after")
})
