import { expect, test } from "bun:test"
import { assertReplayMatches, replay, type ReplayGolden, type ReplayRecording } from "@arcade/kit/sim/replay"
import { gunzipSync } from "node:zlib"
import type { Command } from "../shared/session"
import { combat, scavenging } from "./replays/scenarios"

for (const [name, sim] of [["scavenging", scavenging], ["combat", combat]] as const) {
  test(`30 seconds of recorded Outbreak ${name} match every golden tick`, async () => {
    const bytes = await Bun.file(new URL(`./replays/${name}.json.gz`, import.meta.url)).bytes()
    const fixture: { recording: ReplayRecording<Command>; golden: ReplayGolden } = JSON.parse(gunzipSync(bytes).toString())
    const verbs = new Set<string>()
    const trace = replay({ ...sim, step(state, inputs, dt) {
      sim.step(state, inputs, dt)
      if (state.combat.shots.length) verbs.add("shoot")
      if (state.combat.meleeSwings.length) verbs.add("swing")
      if (state.progression.containers.some((c) => c.searched)) verbs.add("search")
      for (const slot of state.slots) {
        if (slot.survivor.reloadRemaining > 0) verbs.add("reload")
        if (slot.survivor.crouching) verbs.add("crouch")
        if (Math.abs(slot.survivor.vx) + Math.abs(slot.survivor.vy) > 0.1) verbs.add("move")
      }
    } }, fixture.recording)
    assertReplayMatches(trace, fixture.golden)
    // Keep re-recording from accidentally blessing an inert or dead-on-arrival tape.
    for (const verb of name === "combat" ? ["shoot", "swing", "reload", "crouch", "move"] : ["search", "move"]) {
      expect(verbs.has(verb), `${name} must exercise ${verb}`).toBe(true)
    }
  })
}
