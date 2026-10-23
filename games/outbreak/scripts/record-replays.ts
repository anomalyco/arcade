import { recordReplay, replay, type ReplayGolden, type ReplayRecording } from "@arcade/kit/sim/replay"
import { gzipSync, gunzipSync } from "node:zlib"
import type { Command } from "../shared/session"
import { createBotWorldView, SurvivorBot } from "../shared/survivor-bot"
import { combat, combatInputs, REPLAY_DT, scavenging } from "../tests/replays/scenarios"

if (!process.argv.includes("--write")) throw new Error("Use --write to intentionally replace the checked-in golden")
for (const [name, adapter, players] of [
  ["scavenging", scavenging, ["player", "bot-1", "bot-2", "bot-3"]],
  ["combat", combat, ["player", "friend"]],
] as const) {
  const file = new URL(`../tests/replays/${name}.json.gz`, import.meta.url)
  const start = performance.now()
  let result: { recording: ReplayRecording<Command>; golden: ReplayGolden }
  if (process.argv.includes("--record-inputs")) {
    const bots = players.map((id, i) => new SurvivorBot(id, i, 7 + i * 97, "Skilled"))
    // Remove optional undefined input fields so the recording is lossless plain JSON.
    result = recordReplay(adapter, { seed: 7, tickDt: REPLAY_DT, players: [...players], ticks: 600 }, (sim, tick) =>
      JSON.parse(JSON.stringify(name === "combat" ? combatInputs(tick) : bots.map((bot) => bot.step(REPLAY_DT, createBotWorldView(sim))))),
    )
  } else {
    result = JSON.parse(gunzipSync(await Bun.file(file).bytes()).toString())
    result.recording.simVersion = adapter.version
    result.golden = replay(adapter, result.recording)
  }
  const bytes = gzipSync(JSON.stringify(result))
  await Bun.write(file, bytes)
  console.log(`${name}: ${result.recording.inputs.length} ticks, ${bytes.length} bytes, ${Math.round(performance.now() - start)} ms`)
}
