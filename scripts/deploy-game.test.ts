import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fingerprint, playerCount, waitForIdle } from "./deploy-game"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "arcade-deploy-"))
  dirs.push(dir)
  mkdirSync(join(dir, "dist/arcade/carrier"), { recursive: true })
  mkdirSync(join(dir, ".wrangler/deploy-check"), { recursive: true })
  writeFileSync(join(dir, "dist/arcade/carrier/index.html"), "game")
  writeFileSync(join(dir, ".wrangler/deploy-check/index.js"), "worker")
  writeFileSync(join(dir, "wrangler.jsonc"), "config")
  return dir
}

test("fingerprint is location-independent and ignores its own marker and Worker diagnostics", () => {
  const a = fixture(), b = fixture()
  const expected = fingerprint(a, "carrier")
  writeFileSync(join(b, "dist/arcade/carrier/deploy.txt"), "old stamp")
  writeFileSync(join(b, ".wrangler/deploy-check/index.js.map"), "absolute checkout path")
  writeFileSync(join(b, ".wrangler/deploy-check/README.md"), "generated instructions")
  expect(fingerprint(b, "carrier")).toBe(expected)
})

test("client, Worker-only, configuration, added and removed assets all change the fingerprint", () => {
  const dir = fixture()
  let prev = fingerprint(dir, "carrier")
  for (const path of ["dist/arcade/carrier/index.html", ".wrangler/deploy-check/index.js", "wrangler.jsonc", "dist/arcade/carrier/new.ogg"]) {
    writeFileSync(join(dir, path), "changed")
    const next = fingerprint(dir, "carrier")
    expect(next).not.toBe(prev)
    prev = next
  }
  rmSync(join(dir, "dist/arcade/carrier/new.ogg"))
  expect(fingerprint(dir, "carrier")).not.toBe(prev)
})

test("only a valid nonnegative integer player count establishes occupancy", () => {
  for (const body of [null, {}, { players: "0" }, { players: -1 }, { players: Infinity }, { players: 0.5 }]) expect(playerCount(body)).toBeNull()
  expect(playerCount({ players: 0, games: 0 })).toBe(0)
  // Private/full rooms can have games=0. Always use players, not joinable games.
  expect(playerCount({ players: 6, games: 0 })).toBe(6)
})

test("a new join between empty samples restarts the quiet window", async () => {
  let clock = 0
  const counts = [0, 2, 0, 0]
  const waits: number[] = []
  const result = await waitForIdle(async () => counts.shift()!, {
    now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms }, log: () => {},
  })
  expect(result).toBe("idle")
  expect(waits).toEqual([15_000, 60_000, 15_000])
})

test("busy rooms and unavailable counts wait at most 30 minutes", async () => {
  for (const count of [4, null, "error"] as const) {
    let clock = 0
    let reads = 0
    const result = await waitForIdle(async () => {
      reads++
      if (count === "error") throw new Error("offline")
      return count
    }, { now: () => clock, wait: async (ms) => { clock += ms }, log: () => {} })
    expect(result).toBe("deadline")
    expect(clock).toBe(30 * 60_000)
    expect(reads).toBe(31)
  }
})
