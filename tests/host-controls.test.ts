import { describe, expect, mock, test } from "bun:test"
import { DT } from "../shared/config"
import { decodeClient } from "../shared/protocol"
import { HOST_COOLDOWN, hostRestart, moveTeam } from "../shared/sim/host"
import type { ModeId } from "../shared/sim/modes"
import { buildSnapshot } from "../shared/sim/view"
import { World } from "../shared/sim/world"

/** A world on a procedural floor (so a reset can change it) with only the named humans. */
function room(mode: ModeId, names: string[]): World {
  const w = new World(7, null, mode)
  for (const n of names) w.addHuman(n, n)
  w.step()
  w.takeEvents()
  return w
}

const wait = (w: World, seconds: number) => {
  for (let i = 0; i < Math.ceil(seconds / DT); i++) w.step()
}

describe("host controls", () => {
  test("only the host can reset or switch the mode", () => {
    const w = room("tdm", ["a", "b"])
    const seed = w.map.seed
    expect(hostRestart(w, "b")).toBe(false)
    expect(hostRestart(w, "b", "ctf")).toBe(false)
    expect(w.map.seed).toBe(seed)
    expect(w.mode.id).toBe("tdm")
    expect(w.takeEvents().some((e) => e.k === "host")).toBe(false)
  })

  test("a reset starts a fresh match on a new floor: scores zeroed, everyone respawned, gear gone", () => {
    const w = room("tdm", ["a", "b", "c", "d"])
    const [a, b] = [w.players.get("a")!, w.players.get("b")!]
    b.team = 1 - a.team
    w.kill(b, a)
    expect(a.kills).toBe(1)
    expect(w.mode.score.some((s) => s > 0)).toBe(true)
    w.claymores.push({ id: 99, by: "a", x: 5, y: 5, aim: 0, armAt: 0, blowAt: 0 })
    const seed = w.map.seed
    const match = w.match
    wait(w, 1)
    expect(hostRestart(w, "a")).toBe(true)
    expect(w.map.seed).not.toBe(seed)
    expect(w.match).toBe(match + 1)
    expect(w.mode.id).toBe("tdm")
    expect(w.mode.score).toEqual([0, 0])
    expect(w.phase).toBe("play")
    expect(w.claymores).toEqual([])
    expect(w.grenades).toEqual([])
    for (const p of w.players.values()) {
      expect(p.alive).toBe(true)
      expect([p.kills, p.deaths]).toEqual([0, 0])
    }
    expect(w.takeEvents()).toContainEqual({ k: "host", what: "reset", mode: "tdm" })
    expect(buildSnapshot(w, "a").match).toBe(match + 1)
  })

  test("a reset can keep the floor", () => {
    const w = room("ffa", ["a", "b"])
    const seed = w.map.seed
    expect(hostRestart(w, "a", "ffa", false)).toBe(true)
    expect(w.map.seed).toBe(seed)
  })

  test("switching mode starts play in the new mode on a new floor", () => {
    const w = room("ffa", ["a", "b", "c"])
    const seed = w.map.seed
    expect(hostRestart(w, "a", "ctf")).toBe(true)
    expect(w.mode.id).toBe("ctf")
    expect(w.phase).toBe("play")
    expect(w.map.seed).not.toBe(seed)
    expect(w.takeEvents()).toContainEqual({ k: "host", what: "mode", mode: "ctf" })
    // Free for all to a team mode: everyone is balanced onto a side.
    const teams = [...w.players.values()].map((p) => p.team)
    expect(teams.every((t) => t === 0 || t === 1)).toBe(true)
    expect(Math.abs(teams.filter((t) => t === 0).length - teams.filter((t) => t === 1).length)).toBeLessThanOrEqual(1)
    wait(w, 1)
    expect(w.phase).toBe("play")
    expect([...w.players.values()].every((p) => p.alive)).toBe(true)
  })

  test("host-picked teams stand through a switch between team modes", () => {
    const w = room("tdm", ["a", "b", "c", "d"])
    for (const id of ["a", "b", "c"]) moveTeam(w, "a", id, 0)
    moveTeam(w, "a", "d", 1)
    expect(hostRestart(w, "a", "dom")).toBe(true)
    expect(["a", "b", "c", "d"].map((id) => w.players.get(id)!.team)).toEqual([0, 0, 0, 1])
    wait(w, HOST_COOLDOWN + 0.1)
    expect(hostRestart(w, "a", "inf")).toBe(true)
    wait(w, HOST_COOLDOWN + 0.1)
    expect(hostRestart(w, "a", "kc")).toBe(true)
    expect(["a", "b", "c", "d"].map((id) => w.players.get(id)!.team)).toEqual([0, 0, 0, 1])
  })

  test("works from the end screen and clears the vote", () => {
    const w = room("tdm", ["a", "b"])
    w.endMatch()
    w.vote("b", w.voteOptions[1]!)
    expect(w.votes.size).toBe(1)
    expect(hostRestart(w, "a", "hp")).toBe(true)
    expect(w.phase).toBe("play")
    expect(w.mode.id).toBe("hp")
    expect(w.votes.size).toBe(0)
    expect(w.voteOptions).toEqual([])
    expect(buildSnapshot(w, "b").mode.votes).toBeNull()
    wait(w, 1)
    expect(w.phase).toBe("play")
  })

  test("at most one restart every few seconds", () => {
    const w = room("ffa", ["a", "b"])
    expect(hostRestart(w, "a")).toBe(true)
    expect(hostRestart(w, "a", "tdm")).toBe(false)
    expect(w.mode.id).toBe("ffa")
    wait(w, HOST_COOLDOWN - 0.5)
    expect(hostRestart(w, "a", "tdm")).toBe(false)
    wait(w, 0.6)
    expect(hostRestart(w, "a", "tdm")).toBe(true)
    expect(w.mode.id).toBe("tdm")
  })

  test("the protocol takes resets and valid mode switches only", () => {
    const d = (o: unknown) => decodeClient(JSON.stringify(o))
    expect(d({ type: "host", action: "reset" })).toEqual({ type: "host", action: "reset", newFloor: true })
    expect(d({ type: "host", action: "reset", newFloor: false })).toEqual({ type: "host", action: "reset", newFloor: false })
    expect(d({ type: "host", action: "mode", mode: "ctf" })).toEqual({ type: "host", action: "mode", mode: "ctf", newFloor: true })
    expect(d({ type: "host", action: "mode", mode: "quake" })).toBeNull()
    expect(d({ type: "host", action: "mode" })).toBeNull()
    expect(d({ type: "host", action: "nuke" })).toBeNull()
    expect(d({ type: "host" })).toBeNull()
  })

  test("rooms take restarts only from the host", async () => {
    mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
    const { RoomCore } = await import("../server/room")
    const core = new RoomCore("hstc", "ffa")
    const join = (name: string) => {
      const sent: string[] = []
      const conn = { send: (d: string) => sent.push(d), close() {} }
      core.message(conn, JSON.stringify({ type: "hello", name, gun: "rifle", equip: "frag" }))
      return { conn, sent }
    }
    const a = join("a")
    const b = join("b")
    const seed = core.world.map.seed
    core.message(b.conn, JSON.stringify({ type: "host", action: "mode", mode: "snd" }))
    core.message(b.conn, JSON.stringify({ type: "host", action: "reset" }))
    expect(core.world.mode.id).toBe("ffa")
    expect(core.world.map.seed).toBe(seed)
    core.message(a.conn, JSON.stringify({ type: "host", action: "mode", mode: "snd" }))
    expect(core.world.mode.id).toBe("snd")
    expect(core.world.map.seed).not.toBe(seed)
    b.sent.length = 0
    core.step()
    expect(b.sent.some((m) => m.includes('"k":"host"') && m.includes('"mode":"snd"'))).toBe(true)
  })
})
