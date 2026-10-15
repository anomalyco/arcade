import { describe, expect, test } from "bun:test"
import { type Conn, RoomCore } from "../server/core"
import { BUILD } from "../shared/build.gen"
import { CHAT, ChatLimiter, cleanChat, hearsChat } from "../shared/chat"
import { playerOf } from "../shared/crew"
import { type ClientMsg, type ServerMsg, decodeClient, decodeServer, encode } from "../shared/protocol"
import { chatInputKey, chatOpenKey } from "../src/ui/chat-keys"

class FakeConn implements Conn {
  sent: ServerMsg[] = []
  send(data: string) {
    const m = decodeServer(data)
    if (!m) throw new Error(`bad frame ${data}`)
    this.sent.push(m)
  }
  close() {}
  chats(): Extract<ServerMsg, { type: "chat" }>[] {
    return this.sent.filter((m): m is Extract<ServerMsg, { type: "chat" }> => m.type === "chat")
  }
  get id(): number {
    return this.sent.findLast((m) => m.type === "welcome")!.id
  }
}

function room() {
  let now = 1_000_000
  const core = new RoomCore(
    () => now,
    () => 42,
  )
  const join = (name: string) => {
    const c = new FakeConn()
    core.message(c, encode({ type: "hello", build: BUILD, name }))
    return c
  }
  const say = (c: FakeConn, msg: ClientMsg) => core.message(c, encode(msg))
  const raw = (c: FakeConn, msg: object) => core.message(c, JSON.stringify(msg))
  const mate = (name: string, of: FakeConn) => {
    const c = join(name)
    say(c, { type: "board", ship: playerOf(core.crew!, of.id)!.ship })
    return c
  }
  return { core, join, say, raw, mate, advance: (ms: number) => (now += ms) }
}

describe("chat text", () => {
  test("cleanChat strips control and bidi characters, collapses whitespace, caps the length", () => {
    expect(cleanChat("  hi\tthere\n\nall  ")).toBe("hi there all")
    expect(cleanChat("a\u0000b\u0007c\u202ed\u200be")).toBe("a b c d e")
    expect(cleanChat("x".repeat(300))).toHaveLength(CHAT.max)
    expect(Array.from(cleanChat("🚢".repeat(200)))).toHaveLength(CHAT.max)
    expect(cleanChat("   ")).toBe("")
    expect(cleanChat(42)).toBe("")
    expect(cleanChat(null)).toBe("")
  })

  test("decodeClient keeps clean text only and the crew flag only when exactly true", () => {
    expect(decodeClient(JSON.stringify({ type: "chat", text: " hello\u0001 " }))).toEqual({ type: "chat", text: "hello" })
    expect(decodeClient(JSON.stringify({ type: "chat", text: "hi", crew: true }))).toEqual({ type: "chat", text: "hi", crew: true })
    expect(decodeClient(JSON.stringify({ type: "chat", text: "hi", crew: "yes" }))).toEqual({ type: "chat", text: "hi" })
    expect(decodeClient(JSON.stringify({ type: "chat", text: "  " }))).toBeNull()
    expect(decodeClient(JSON.stringify({ type: "chat", text: ["hi"] }))).toBeNull()
    expect(decodeClient(JSON.stringify({ type: "chat" }))).toBeNull()
  })

  test("decodeServer validates the sender fields", () => {
    const ok = { type: "chat", from: 3, name: "ada", team: 1, text: "hi" }
    expect(decodeServer(JSON.stringify(ok))).toEqual(ok as ServerMsg)
    expect(decodeServer(JSON.stringify({ ...ok, crew: true }))).toEqual({ ...ok, crew: true } as ServerMsg)
    expect(decodeServer(JSON.stringify({ ...ok, team: 9 }))).toBeNull()
    expect(decodeServer(JSON.stringify({ ...ok, from: -1 }))).toBeNull()
    expect(decodeServer(JSON.stringify({ ...ok, name: "x".repeat(200) }))).toBeNull()
    expect(decodeServer(JSON.stringify({ ...ok, text: "" }))).toBeNull()
  })
})

describe("chat rate limit", () => {
  test("burst lines per window, per player, sliding", () => {
    const l = new ChatLimiter(5, 5000)
    for (let i = 0; i < 5; i++) expect(l.allow(1, i * 100)).toBe(true)
    expect(l.allow(1, 600)).toBe(false)
    expect(l.allow(2, 600)).toBe(true)
    // The first line ages out at 5000 ms after it was sent.
    expect(l.allow(1, 4999)).toBe(false)
    expect(l.allow(1, 5000)).toBe(true)
    expect(l.allow(1, 5001)).toBe(false)
    l.forget(1)
    expect(l.allow(1, 5002)).toBe(true)
  })
})

describe("room chat", () => {
  test("everyone hears an ALL line, stamped by the room: sender id, crew name and team", () => {
    const { core, join, raw } = room()
    const a = join("ada")
    const b = join("bo")
    // A client can't pick its name, id or team: extra fields are ignored.
    raw(a, { type: "chat", text: "hello  sea", name: "admin", from: b.id, team: 3 })
    const me = playerOf(core.crew!, a.id)!
    const want = { type: "chat", from: a.id, name: "ada", team: me.team, text: "hello sea" }
    expect(a.chats()).toEqual([want as Extract<ServerMsg, { type: "chat" }>])
    expect(b.chats()).toEqual([want as Extract<ServerMsg, { type: "chat" }>])
  })

  test("a CREW line reaches only the sender's carrier", () => {
    const { core, join, say, mate } = room()
    const a = join("ada")
    const enemy = join("eve")
    const b = mate("bo", a)
    expect(playerOf(core.crew!, b.id)!.team).toBe(playerOf(core.crew!, a.id)!.team)
    expect(playerOf(core.crew!, enemy.id)!.team).not.toBe(playerOf(core.crew!, a.id)!.team)
    say(b, { type: "chat", text: "launch now", crew: true })
    expect(a.chats().map((m) => [m.from, m.text, m.crew])).toEqual([[b.id, "launch now", true]])
    expect(b.chats()).toHaveLength(1)
    expect(enemy.chats()).toHaveLength(0)
    expect(hearsChat(core.crew!, enemy.id, playerOf(core.crew!, a.id)!.team, "crew")).toBe(false)
    expect(hearsChat(core.crew!, enemy.id, playerOf(core.crew!, a.id)!.team, "all")).toBe(true)
  })

  test("over the budget lines are dropped silently; it refills with time", () => {
    const { join, say, advance } = room()
    const a = join("ada")
    const b = join("bo")
    for (let i = 0; i < CHAT.burst + 3; i++) say(a, { type: "chat", text: `m${i}` })
    expect(b.chats()).toHaveLength(CHAT.burst)
    expect(a.sent.some((m) => m.type === "nope")).toBe(false)
    // Another player's budget is their own.
    say(b, { type: "chat", text: "me too" })
    expect(b.chats()).toHaveLength(CHAT.burst + 1)
    advance(CHAT.windowMs)
    say(a, { type: "chat", text: "later" })
    expect(b.chats().at(-1)!.text).toBe("later")
  })

  test("nothing before the hello", () => {
    const { core } = room()
    const c = new FakeConn()
    core.message(c, encode({ type: "chat", text: "hi" }))
    expect(c.sent).toHaveLength(0)
  })
})

describe("chat keys", () => {
  const key = (code: string, mods: Partial<{ repeat: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ code, repeat: false, metaKey: false, ctrlKey: false, altKey: false, ...mods })

  test("physical T opens ALL, Y opens CREW; not with modifiers or on repeat", () => {
    expect(chatOpenKey(key("KeyT"))).toBe("all")
    expect(chatOpenKey(key("KeyY"))).toBe("crew")
    expect(chatOpenKey(key("KeyT", { ctrlKey: true }))).toBeNull()
    expect(chatOpenKey(key("KeyT", { metaKey: true }))).toBeNull()
    expect(chatOpenKey(key("KeyT", { repeat: true }))).toBeNull()
    expect(chatOpenKey(key("KeyE"))).toBeNull()
  })

  test("inside the input only Enter, Esc and Tab act; game keys are typing", () => {
    expect(chatInputKey("Enter")).toBe("send")
    expect(chatInputKey("NumpadEnter")).toBe("send")
    expect(chatInputKey("Escape")).toBe("cancel")
    expect(chatInputKey("Tab")).toBe("channel")
    for (const code of ["KeyW", "KeyS", "KeyA", "KeyD", "KeyE", "KeyM", "KeyG", "KeyC", "KeyF", "Space", "Backquote", "F2", "Digit1"]) expect(chatInputKey(code)).toBe("type")
  })
})
