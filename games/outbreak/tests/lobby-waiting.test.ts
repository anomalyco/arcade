import { expect, test } from "bun:test"
import { lobbyWaitingOn } from "../src/lobby/waiting"

// Playtest (Oct 20): "I'm stuck waiting" ... "Oh, you gotta click Ready."
test("the lobby names who it is waiting on, you first", () => {
  const p = (id: string, ready: boolean, connected = true) => ({ id, name: id.toUpperCase(), ready, connected })
  expect(lobbyWaitingOn([p("a", true), p("b", true)], "a")).toEqual({ text: "", button: "Waiting for Host…" })
  expect(lobbyWaitingOn([p("a", false), p("b", true)], "a")).toEqual({ text: "waiting for you: press Ready", button: "Ready up to start" })
  expect(lobbyWaitingOn([p("a", true), p("b", false), p("c", false, false)], "a")).toEqual({ text: "waiting for B", button: "Waiting for B" })
  expect(lobbyWaitingOn([p("a", false), p("b", false), p("c", false), p("d", false), p("e", false)], "a").text).toBe("waiting for you and B, C +2")
})
