import { expect, test } from "bun:test"
import { OutbreakLobby } from "../src/lobby/lobby-ui"

test("invite feedback waits for the clipboard and never claims a failed copy succeeded", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  let finish!: () => void
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    clipboard: { writeText: () => new Promise<void>((resolve) => { finish = resolve }) },
  } })
  const lobby = Object.assign(Object.create(OutbreakLobby.prototype), {
    copiedUntil: 0, render() {},
  }) as { copiedUntil: number; copyInvite(room: string): Promise<void> }
  try {
    const copying = lobby.copyInvite("abcde")
    expect(lobby.copiedUntil).toBe(0)
    finish()
    await copying
    expect(lobby.copiedUntil).toBeGreaterThan(performance.now())
    lobby.copiedUntil = 0
    navigator.clipboard.writeText = async () => { throw new Error("NotAllowedError") }
    await lobby.copyInvite("abcde")
    expect(lobby.copiedUntil).toBe(0)
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous)
    else Reflect.deleteProperty(globalThis, "navigator")
  }
})
