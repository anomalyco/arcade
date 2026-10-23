// Full-duration offline DSP assertions, invoked by @arcade/kit's test:soak.
import assert from "node:assert/strict"
import { renderOcclusionReverbAb, renderWorldSignalReplayOffline } from "../packages/kit/audio/offline"
import { DeterministicOfflineAudioContext } from "../packages/kit/audio/test-context"

const OfflineCtx = DeterministicOfflineAudioContext as unknown as typeof OfflineAudioContext
const ab = await renderOcclusionReverbAb(7, OfflineCtx)
assert.equal(ab.dryOpen.stats.clippedSamples, 0)
assert.equal(ab.reverbOccluded.stats.clippedSamples, 0)
assert(ab.dryOpen.stats.peak > 0.05 && ab.dryOpen.stats.peak < 1)
assert(ab.reverbOccluded.stats.peak > 0.03 && ab.reverbOccluded.stats.peak < 1)
assert(ab.delta.centroidDropHz > 100, "occlusion darkens the spectrum")
assert(ab.delta.reverbTailGainRatio > 1.4, "reverb extends the tail")
assert(ab.dryOpen.wav.byteLength > 44)
assert.equal(ab.reverbOccluded.wav.byteLength, ab.dryOpen.wav.byteLength)
console.log("PASS full occlusion/reverb A/B")

const run1 = await renderWorldSignalReplayOffline("chase", 7, OfflineCtx)
const run2 = await renderWorldSignalReplayOffline("chase", 7, OfflineCtx)
assert.deepEqual(run1.events, run2.events)
assert.equal(run1.events.nitroIgnitions, 2)
assert.equal(run1.events.impacts.length, 2)
assert(run1.events.shifts.length >= 2)
assert.equal(run1.stats.clippedSamples, 0)
assert(run1.stats.peak > 0.05 && run1.stats.peak < 1)
assert(run1.stats.quietWindowRms[0]! < 1e-4, "chase is silent after stop")

const spell = await renderWorldSignalReplayOffline("spell_cycle", 7, OfflineCtx)
assert.equal(spell.events.spellActivations, 2)
assert.equal(spell.events.spellCasts, 1, "mana depletion must not cast")
assert.equal(spell.stats.clippedSamples, 0)
assert(spell.stats.quietWindowRms[0]! < 1e-4, "spell is silent after stop")
console.log("PASS full chase and spell replays")
