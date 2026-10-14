import { describe, expect, test } from "bun:test"
import { ALL_GAMES, resolveGames } from "../src/games/registry"

const ids = (search: string, hash = "") => resolveGames(search, hash).games.map(game => game.id)

describe("game selection", () => {
  test("no game loads every adapter", () => {
    expect(resolveGames("", "").choice).toBe(ALL_GAMES)
    expect(ids("")).toEqual(["getaway", "blackout", "outbreak"])
    expect(ids("?game=carrier")).toEqual(["getaway", "blackout", "outbreak"])
  })
  test("a game loads only its adapters", () => {
    expect(resolveGames("?game=Blackout", "").choice).toBe("blackout")
    expect(ids("?game=blackout")).toEqual(["blackout"])
  })
  test("deep-linked sections pull in their owner", () => {
    expect(ids("?game=getaway&section=fire-water")).toEqual(["getaway", "blackout"])
    expect(ids("?game=getaway", "#outbreak-vignette")).toEqual(["getaway", "outbreak"])
    expect(ids("?game=getaway", "#section=splatter")).toEqual(["getaway", "blackout"])
    expect(ids("?game=getaway&section=looks")).toEqual(["getaway"])
  })
})
