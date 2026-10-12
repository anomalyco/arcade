import { describe, expect, mock, test } from "bun:test"
import { DT, END_SECONDS } from "../shared/config"
import { decodeClient } from "../shared/protocol"
import { moveTeam, shuffleTeams } from "../shared/sim/host"
import type { ModeId } from "../shared/sim/modes"
import { rosterOf } from "../shared/sim/view"
import { World } from "../shared/sim/world"
import { testMap } from "./helpers"

function modeWorld(mode: ModeId, names: string[]): World {
  const w = new World(11, testMap(), mode)
  for (const n of names) w.addHuman(n, n)
  w.step()
  w.takeEvents()
  return w
}

const teamOf = (w: World, id: string) => w.players.get(id)!.team
const sizes = (w: World) => [0, 1].map((t) => [...w.players.values()].filter((p) => p.team === t).length)

/** The next match in `next`: through the end screen with nobody voting for the same mode, else the way a vote switches. */
function nextMatch(w: World, next: ModeId): void {
  if (next === w.mode.id) {
    w.endMatch()
    for (let i = 0; i < Math.ceil(END_SECONDS / DT) + 2; i++) w.step()
  } else w.setMode(next)
  expect(w.phase).toBe("play")
  expect(w.mode.id).toBe(next)
}

describe("room host", () => {
  test("the first human in hosts; when they leave, the longest-connected human takes over", () => {
    const w = modeWorld("tdm", ["a", "b", "c"])
    expect(w.host).toBe("a")
    expect(rosterOf(w).find((r) => r.host)?.id).toBe("a")
    w.remove("b")
    expect(w.host).toBe("a")
    w.remove("a")
    expect(w.host).toBe("c")
    w.addHuman("d", "d")
    expect(w.host).toBe("c")
    w.remove("c")
    w.remove("d")
    expect(w.host).toBe("")
    w.addHuman("e", "e")
    expect(w.host).toBe("e")
  })

  test("only the host can move people", () => {
    const w = modeWorld("tdm", ["a", "b", "c", "d"])
    const c = teamOf(w, "c")
    expect(moveTeam(w, "b", "c", 1 - c)).toBe(false)
    expect(teamOf(w, "c")).toBe(c)
    expect(shuffleTeams(w, "b")).toBe(false)
    expect(moveTeam(w, "a", "c", 1 - c)).toBe(true)
    expect(teamOf(w, "c")).toBe(1 - c)
  })

  test("a living player moved mid-match sits out without a score and respawns on the new side", () => {
    const w = modeWorld("tdm", ["a", "b"])
    const b = w.players.get("b")!
    expect(b.alive).toBe(true)
    moveTeam(w, "a", "b", 1 - b.team)
    expect(b.alive).toBe(false)
    expect(b.deaths).toBe(0)
    expect(w.mode.score).toEqual([0, 0])
    expect(w.takeEvents().some((e) => e.k === "kill")).toBe(false)
    for (let i = 0; i < Math.ceil(4 / DT); i++) w.step()
    expect(b.alive).toBe(true)
  })

  test("moves persist across matches, through a free for all, and auto-balance doesn't undo them", () => {
    const w = modeWorld("tdm", ["a", "b", "c", "d"])
    for (const id of ["a", "b", "c"]) moveTeam(w, "a", id, 0)
    moveTeam(w, "a", "d", 1)
    expect(sizes(w)).toEqual([3, 1])
    nextMatch(w, "tdm")
    expect(["a", "b", "c"].map((id) => teamOf(w, id))).toEqual([0, 0, 0])
    expect(teamOf(w, "d")).toBe(1)
    nextMatch(w, "ffa")
    expect(teamOf(w, "a")).toBe(-1)
    nextMatch(w, "dom")
    expect(["a", "b", "c", "d"].map((id) => teamOf(w, id))).toEqual([0, 0, 0, 1])
    // A newcomer still goes to the smaller side; unpinned players are balanced around the pins.
    w.addHuman("e", "e")
    expect(teamOf(w, "e")).toBe(1)
  })

  test("shuffle deals even teams and sticks", () => {
    const w = modeWorld("tdm", ["a", "b", "c", "d", "e", "f", "g"])
    for (const id of ["b", "c", "d", "e"]) moveTeam(w, "a", id, 0)
    expect(shuffleTeams(w, "a")).toBe(true)
    const [x, y] = sizes(w)
    expect(Math.abs(x! - y!)).toBeLessThanOrEqual(1)
    const after = [...w.players.values()].map((p) => p.team)
    nextMatch(w, "tdm")
    expect([...w.players.values()].map((p) => p.team)).toEqual(after)
  })

  test("free for all ignores team moves", () => {
    const w = modeWorld("ffa", ["a", "b"])
    expect(moveTeam(w, "a", "b", 1)).toBe(false)
    expect(shuffleTeams(w, "a")).toBe(false)
    expect(teamOf(w, "b")).toBe(-1)
    expect(w.players.get("b")!.hostTeam).toBe(-1)
  })

  test("the protocol accepts team moves and shuffles, and rejects bad ones", () => {
    expect(decodeClient(JSON.stringify({ type: "team", id: "abc123", team: 1 }))).toEqual({ type: "team", id: "abc123", team: 1 })
    expect(decodeClient(JSON.stringify({ type: "team", id: "abc123", team: 2 }))).toBeNull()
    expect(decodeClient(JSON.stringify({ type: "team", id: "AB C", team: 0 }))).toBeNull()
    expect(decodeClient(JSON.stringify({ type: "team", team: 0 }))).toBeNull()
    expect(decodeClient(JSON.stringify({ type: "shuffle" }))).toEqual({ type: "shuffle" })
  })

  test("rooms take team moves only from the host", async () => {
    mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
    const { RoomCore } = await import("../server/room")
    const core = new RoomCore("hstt", "tdm")
    const join = (name: string) => {
      const sent: string[] = []
      const conn = { send: (d: string) => sent.push(d), close() {} }
      core.message(conn, JSON.stringify({ type: "hello", name, gun: "rifle", equip: "frag" }))
      const id = (JSON.parse(sent[0]!) as { id: string }).id
      return { conn, id }
    }
    const a = join("a")
    const b = join("b")
    const c = join("c")
    expect(core.world.host).toBe(a.id)
    const team = (id: string) => core.world.players.get(id)!.team
    const t = team(c.id)
    core.message(b.conn, JSON.stringify({ type: "team", id: c.id, team: 1 - t }))
    expect(team(c.id)).toBe(t)
    core.message(a.conn, JSON.stringify({ type: "team", id: c.id, team: 1 - t }))
    expect(team(c.id)).toBe(1 - t)
  })
})
