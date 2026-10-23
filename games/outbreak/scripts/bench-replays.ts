// Compare the replaced determinism and squad cases with both goldens + small runner contracts.
// HiveMind only: bun games/outbreak/scripts/bench-replays.ts
import { assertReplayMatches, replay, type ReplayGolden, type ReplayRecording } from "@arcade/kit/sim/replay"
import { gunzipSync } from "node:zlib"
import { BotReplayPlayer, runHeadlessBotGame } from "../shared/bot-runner"
import type { Command } from "../shared/session"
import { combat, scavenging } from "../tests/replays/scenarios"

const fixtures = await Promise.all(["scavenging", "combat"].map(async (name) => {
  const bytes = await Bun.file(new URL(`../tests/replays/${name}.json.gz`, import.meta.url)).bytes()
  return JSON.parse(gunzipSync(bytes).toString()) as { recording: ReplayRecording<Command>; golden: ReplayGolden }
}))
function runner(seconds: number): void {
  const options = { seed: 7, preset: "Skilled" as const, maxDurationSeconds: seconds, timeScale: 240 }
  const a = runHeadlessBotGame({ ...options, recordReplay: true })
  const b = runHeadlessBotGame(options)
  if (a.survivalTime !== b.survivalTime || JSON.stringify(a.killsByWeapon) !== JSON.stringify(b.killsByWeapon)) throw new Error("Bot determinism failed")
  if (new BotReplayPlayer(a.replay!).runAll().time !== a.survivalTime) throw new Error("Bot playback failed")
}
function goldens(): void {
  for (const [i, sim] of [scavenging, combat].entries()) {
    const fixture = fixtures[i]!
    assertReplayMatches(replay(sim, fixture.recording), fixture.golden)
  }
}
function squad(seconds: number): void {
  const run = runHeadlessBotGame({ seed: 7, preset: "Skilled", playerCount: 4, maxDurationSeconds: seconds, timeScale: 180 })
  if (run.playerCount !== 4 || run.distanceExplored.totalDistanceWalked <= 0) throw new Error("Squad failed")
}
const cases = { before: () => { runner(90); squad(60) }, after: () => { runner(3); squad(3); goldens() }, goldens }
const times: Record<string, number[]> = {}
// One warmup, five alternating samples; no browser, queue or install time in these measurements.
for (let round = -1; round < 5; round++) {
  for (const [name, fn] of Object.entries(cases)) {
    const start = performance.now()
    fn()
    const ms = performance.now() - start
    if (round >= 0) (times[name] ??= []).push(ms)
  }
}
for (const [name, values] of Object.entries(times)) {
  values.sort((a, b) => a - b)
  console.log(`METRIC ${name}_median_ms=${values[2]!.toFixed(1)} min_ms=${values[0]!.toFixed(1)} max_ms=${values[4]!.toFixed(1)}`)
}
