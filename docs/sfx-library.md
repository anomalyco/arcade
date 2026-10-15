# Shared sound library

One catalogue of game sounds keyed by what they are (`gun.pistol.shot`, `foot.wood.walk`, `zombie.groan.idle`), with
several variations each, a licence per file, loudness matched within each family, and mix defaults a game starts from.
Code: `packages/kit/audio/library.ts` (hand-written catalogue), `library-files.ts` (generated: files, provenance,
measurements), files in `packages/kit/audio/sfx/`. Outbreak is the first game to use it. Kit browses and auditions it in
the Lab's Audio section (`arcade station audio`). Inventory of every sound file in the repo: [sfx-inventory.md](sfx-inventory.md).

## Using it in a game

```ts
// vite.config.ts: serve and emit only the ids this game plays, under its own audio-assets/sfx/
plugins: [audioAssets({ sfx: ["game:outbreak"] })]   // or ids, "zombie.*", or "all" (the Lab)

// one runtime, the library's samples and one cue per id (seeded round-robin, pitch and gain jitter)
const entries = selectSfx(["game:outbreak"])
const audio = new AudioRuntime({ manifest: sfxManifest(entries), cues: sfxCues(entries), baseUrl: new URL("./audio-assets/", document.baseURI).href })
const entry = sfxEntry("door.wood.open")
audio.playCue("door.wood.open", { position: { x, z: y, refDistance: entry.range.ref, maxDistance: entry.range.max } })
```

- Each source file exists once in the repository. Four ids reuse existing game files in place (`ui.click` is Getaway's
  `ui_click.mp3`, `ui.tick` is Carrier's picked `ui-click-1.ogg`, `vehicle.tyre.screech`/`chirp` are Getaway's tyre
  recordings); the plugin copies a file only into the bundles of
  the hosts that select it.
- Each variant carries a playback `gain` that lands it on its id's loudness `target`: momentary-max LUFS (loudest
  400 ms) for one-shots, integrated LUFS for loops. Generated files are normalised in the file, so the gain only makes
  up for the -1 dBFS peak cap on peaky takes (largest 1.59, `door.locked.3`).
- Loops (`ambience.*`) carry 0.25 s of their own tail before and head after the loop region and record
  `loopStart`/`loopEnd`; the runtime loops that region, so the codec's imperfect first and last frames never play in
  the loop. Opus decodes in Chrome, Firefox and Safari 18.4+.
- Mix buses gained `weapon`, `foley` and `voice` beside the existing six. The Lab's Effects level drives all three.

## Catalogue

91 ids, 281 files, 2.28 MB the library owns (Ogg Opus: 64 kb/s mono for weapons and impacts, 48 kb/s other mono,
96 kb/s stereo beds; positional loops such as crafting and the horde are mono). Licence: "ElevenLabs commercial sound-generation license (Anomaly)" for every generated file;
the reused UI files keep theirs. Per-file provenance (take, prompt influence, request id) is in `library-files.ts`.

| Id | Variants | Bus | Seconds | KB | Source |
| --- | --: | --- | --- | --: | --- |
| `gun.pistol.shot` | 4 | weapon | 0.45–1.48 | 28 | ElevenLabs, 4 of 12 |
| `gun.pistol.reload` | 3 | weapon | 1.20–1.33 | 28 | ElevenLabs, 3 of 4 (whole clip; Lab only since the parts below) |
| `gun.pistol.{mag-release,mag-out,mag-in,slide}` | 3 each | weapon | 0.16–0.60 | 7–13 | ElevenLabs, 3 of 4 each |
| `gun.dry-fire` | 3 | weapon | 0.23–0.48 | 9 | ElevenLabs, 3 of 4 |
| `gun.casing` | 3 | foley | 0.80 | 16 | ElevenLabs, 3 of 4 |
| `melee.shove` | 3 | foley | 0.60–0.72 | 12 | ElevenLabs, 3 of 4 |
| `melee.swing.{light,heavy}` | 3 each | weapon | 0.27–0.65 | 8–10 | ElevenLabs, 3 of 4 each |
| `melee.hit.{wood,metal,blade}` | 3 each | impact | 0.26–0.71 | 9–13 | ElevenLabs, 3 of 4 each |
| `melee.break` | 2 | impact | 0.80–0.85 | 12 | ElevenLabs, 2 of 3 |
| `foot.{concrete,grass,wood}.walk` | 6 each | foley | 0.30–0.42 | 13–14 | ElevenLabs, steps sliced from 2 takes |
| `foot.{concrete,grass,wood}.run` | 6 each | foley | 0.19–0.30 | 10–11 | ElevenLabs, steps sliced from 2 takes |
| `door.wood.open` | 3 | foley | 0.97–1.20 | 19 | ElevenLabs, 3 of 4 |
| `door.wood.close` | 3 | foley | 0.71–1.00 | 13 | ElevenLabs, 3 of 4 |
| `door.locked` | 3 | foley | 0.91–1.00 | 16 | ElevenLabs, 3 of 4 |
| `door.bash` | 4 | impact | 0.85–1.20 | 32 | ElevenLabs, 4 of 5 |
| `window.slide` | 3 | foley | 0.97–1.16 | 18 | ElevenLabs, 3 of 4 |
| `glass.break` | 2 | impact | 1.60 | 24 | ElevenLabs, 2 of 3 |
| `barricade.hammer` | 4 | foley | 1.13–1.36 | 30 | ElevenLabs, 4 of 5 |
| `barricade.break` | 3 | impact | 1.04–1.15 | 28 | ElevenLabs, 3 of 4 |
| `search.rummage` | 3 | foley | 1.95–2.00 | 33 | ElevenLabs, 3 of 4 |
| `pickup.ammo` | 3 | foley | 0.56–0.68 | 11 | ElevenLabs, 3 of 4 |
| `pickup.item` | 3 | foley | 0.53–0.59 | 10 | ElevenLabs, 3 of 4 |
| `pickup.{tool,medical,part,key,battery,scrap,plank}` | 3 each | foley | 0.42–0.88 | 10–13 | ElevenLabs, 3 of 4 each |
| `item.drop` | 2 | foley | 0.40–0.54 | 5 | ElevenLabs, 2 of 4 |
| `pack.open`, `pack.close` | 2 each | ui | 0.57–0.64 | 7 | ElevenLabs, 2 of 4 each |
| `ui.ping` | 2 | ui | 0.60 | 7 | ElevenLabs, 2 of 4 |
| `flashlight.battery` | 2 | foley | 0.98–0.99 | 11 | ElevenLabs, 2 of 4 |
| `craft.{medical,tinker,wood}.loop` | 1 loop each | foley | 5.4 | 33–41 | ElevenLabs, 1 of 2 each |
| `craft.{medical,tinker,wood}.done` | 2 each | foley | 0.49–0.80 | 7–10 | ElevenLabs, 2 of 4 each |
| `bench.research.loop`, `bench.research.done` | 1 loop, 2 | foley | 5.4; 0.39–0.43 | 34; 5 | ElevenLabs, 1 of 2; 2 of 4 |
| `bench.deposit` | 3 | foley | 0.93–1.20 | 18 | ElevenLabs, 3 of 4 |
| `generator.loop`, `door.pry.loop`, `lure.loop` | 1 loop each | foley | 3.4–5.4 | 27–38 | ElevenLabs, 1 of 2 each |
| `lure.land` | 2 | foley | 0.63–0.80 | 9 | ElevenLabs, 2 of 4 |
| `flashlight.click` | 3 | foley | 0.12–0.14 | 3 | ElevenLabs, 3 of 4 |
| `zombie.groan.idle` | 6 | voice | 2.17–2.41 | 84 | ElevenLabs, 6 of 8 |
| `zombie.alert` | 4 | voice | 1.33–1.38 | 32 | ElevenLabs, 4 of 6 |
| `zombie.attack` | 4 | voice | 0.88–1.00 | 22 | ElevenLabs, 4 of 5 |
| `zombie.hit` | 4 | impact | 0.22–0.60 | 15 | ElevenLabs, 4 of 6 (the flesh impact) |
| `impact.bullet.{wood,plaster,concrete,metal,glass}` | 4 each | impact | 0.30–0.93 | 18–26 | ElevenLabs, 4 of 6 (wood 4 of 12) |
| `zombie.foot.{step,shuffle,drag}.{concrete,grass,wood}` | 5 each | impact | 0.35–0.75 | 15–31 | ElevenLabs, steps sliced from 2 takes each |
| `zombie.horde.shuffle` | 1 loop | impact | 7.4 | 55 | ElevenLabs, 1 of 3 |
| `zombie.death` | 4 | voice | 1.80–1.83 | 45 | ElevenLabs, 4 of 5 |
| `body.hurt` | 4 | voice | 0.54–0.68 | 15 | ElevenLabs, 4 of 5 |
| `body.vault` | 2 | foley | 0.66–1.20 | 10 | ElevenLabs, 2 of 3 |
| `body.breath.exhausted` | 2 | voice | 2.34–2.41 | 28 | ElevenLabs, 2 of 3 |
| `ambience.night.suburb` | 1 loop | ambience | 23.4 | 287 | ElevenLabs, 1 of 3 |
| `ambience.day.suburb` | 1 loop | ambience | 23.4 | 210 | ElevenLabs, 1 of 3 |
| `ambience.threat` | 1 loop | ambience | 23.4 | 215 | ElevenLabs, 1 of 2 |
| `creature.bees.swarm` | 3 | foley | 1.47–1.54 | 28 | ElevenLabs, 3 of 4 (Brawl's bee swarm) |
| `crowd.applause` | 3 | foley | 1.96–2.00 | 36 | ElevenLabs, 3 of 4 (Brawl's Standing Ovation) |
| `cooking.sizzle` | 3 | foley | 1.28 | 21 | ElevenLabs, 3 of 4 (Brawl's pan and grease) |
| `vehicle.tyre.screech` | 1 loop | tyre | 4.53 | 46 | reuses Getaway's `tire_screech_loop.mp3` (loop region measured by `build`) |
| `vehicle.tyre.chirp` | 1 | tyre | 0.38 | 5 | reuses Getaway's `skid_short.mp3` |
| `ui.click` | 1 | ui | 0.48 | 6 | reuses Getaway's `ui_click.mp3` |
| `ui.tick` | 1 | ui | 0.48 | 7 | reuses Carrier's `ui-click-1.ogg` |

## Making and curating sounds

`scripts/sfx/library.ts` runs offline and never plays anything:

1. `generate [ids…]` asks ElevenLabs `eleven_text_to_sound_v2` for each id's `candidates` takes from the prompt in its
   catalogue entry (key: `bun --env-file=<file with ELEVENLABS_API_KEY>`). Raw takes and request metadata go to
   `$SFX_WORK` (default `$TMPDIR/opencode/sfx`).
2. `curate [ids…]` trims each take to its audible extent (36 dB under peak in front; 54 dB under peak or 8 dB over the
   take's noise floor behind), slices footstep recordings into single steps at their onsets and re-trims each step to
   its own transient, crossfade-loops beds, measures every candidate and scores it: duration range, near-silent takes,
   flat-topped runs (clipping baked into the take; decoded overs are recoverable and not penalised), crest factor
   against the target, SNR over the take's floor (discrete sounds only), timbre distance from the family's median
   centroid, one onset for single events, decay by 0.2 s for transients, loudness spread for footsteps, steadiness
   and seam for beds. It keeps the best `variants`, at most a fair share per take, and writes a waveform and
   spectrogram contact sheet per id (`sheets/<id>.png`, picks in green).
3. `build` normalises the picks to their target with a -1 dBFS peak cap, encodes Ogg Opus, decodes the result to
   measure it again, and writes `library-files.ts`.

What analysis caught: the first pistol prompt returned six takes peaking at -22 to -39 dBFS (noise with a faint
transient); the first night and interior beds measured -62 and -67 LUFS. Both were regenerated with plainer, louder
prompts ("…sharp crack with a punchy low body and short tail. One shot only."; "loud dense chorus of crickets…").
Interior room tone was dropped: its best take was 42 Hz rumble. Opus decoding attenuates a stream's first samples,
which made a seam jump larger than any step inside the interior bed; padding loops on both sides fixed it (seam
steps now sit at the 44th–88th percentile of each bed's own sample steps, 20 ms RMS change 0.3–2.1 dB against a bed
median of 0.7–2.7 dB).

What it cannot judge: whether a groan sounds like a zombie or a shot sounds like a 9 mm pistol. Listen in the Lab.

Cost: 155 generations, about 6,200 ElevenLabs credits (2% of the Creator plan's monthly 300,789). The second batch
(zombie feet, impacts, reload parts, pickups, crafting, bench and the rest) took 165 generations and 3,856 credits.

What analysis caught in the second batch: four of six wood-impact takes were near-silent (-50 to -59 LUFS), so wood
was regenerated with a plainer prompt and its target lowered to -24.5 so the peaky picks need no more than 1.6× gain;
glass, a seated magazine and the ping are several onsets (crack and shards, scrape and click, a two-tone chime) and no
longer count as single events; the dry item drop and the battery swap were lowered for the same gain limit; and Opus
pushed one peak-capped take to -0.4 dBFS on decode, so `build` now re-encodes any file that decodes over -0.6.

Brawl's bees, applause and sizzle took 12 generations and 224 credits; curation dropped one muffled bee take, one
clipped applause take and one dull sizzle.

## Outbreak

`games/outbreak/src/audio/`:

- `SoundDirector` (`director.ts`) diffs world state each frame and returns sounds, like the HUD's `ActorFeedback`: new
  shots (report at the muzzle, casing 0.38–0.5 s later, hit and kill at the target), zombies turning alert or chasing
  (one snarl per zombie per 8 s, one per 0.35 s across the crowd), deaths without a shot, idle groans (a random zombie in
  earshot every 4.5 s / √n, never closer than 0.7 s apart, each zombie at most every 8 s), attacks paired with a
  survivor's damage, every door, window, plank and bash in town, and each survivor's reload, dry fire, pickups,
  rummaging, shove, flashlight, breath and vault. A missed shot strikes what stopped it (`impacts.ts`): a closed door
  is wood, a wall face inside a building is plaster, an outside face is its building's cladding (houses wood,
  warehouses metal, other shops brick and concrete), and the first window, board, fence or car it went through rings
  too (the sim's rounds pass those). Each plays at the hit point, positional and occluded, after the round's
  flight time at 360 m/s. Shots that hit a zombie keep `zombie.hit` (flesh), the event game-feel's blood also uses.
- The reload plays in four parts (`reload.ts`) when the reload pose reaches each event: release as the left hand
  reaches the gun (0.11 of the 1.15 s clip), the empty magazine falling as the hand leaves for the belt (0.19), the
  fresh one seated where it disappears into the grip (0.63) and the slide snapping forward (0.84). Each starts early by
  its variants' median time to their loudest transient and is scheduled up to one frame ahead from `reloadRemaining`;
  co-op peers, which replicate only "reloading", count from when it was first seen. Measured in `tests/audio.test.ts`:
  each part within 1.5 ticks of its pose time.
- `InventorySounds` (`inventory.ts`) diffs the ledger (the room's, or a co-op client's mirror): anything new on a
  survivor's belt, hotbar or pack plays its class's pickup (tool, ammo, medical, part, key, battery, scrap, plank;
  container strips, drops and the stash alike, at most two a frame), a new drop lands, a bench that gains stock plays a
  deposit, a ping chimes, a noisemaker lands and then loops where it lies, and a bench with a car battery runs its
  generator at night. Crafting, research, healing and prying hold a loop for as long as the channel runs (crafting by
  recipe kind: medical, tinkering, woodwork) and play their finishing sound if it ran out rather than being
  cancelled; the crafted item makes no pickup. A flashlight battery swap and the pack opening and closing (`Tab`)
  are heard too. Held loops are re-spatialised every frame.
- Zombie feet (`zombie-steps.ts`) come from the crowd rig's own contacts (`ZombieCrowdRenderer.onFootfall`), and for
  zombies the rig does not animate (off screen, unseen behind a wall) from a cadence on the rig's stride. The gait
  follows the shamble variant and the foot: the dragged foot scrapes, limpers and lungers stomp, the rest shuffle, on
  wood, concrete or grass. Only the nearest four moving zombies within 14 m are heard step by step, at most 8 steps a
  second, never into the last 8 free voices, and the ids drop rather than steal; every other moving zombie within 22 m
  raises a horde bed (many feet shuffling) panned toward the crowd. It reads `CoopSim` (`soundWorld`), so offline play and co-op clients
  (whose `CoopSim` is filled from snapshots) sound the same; remote survivors are heard at their positions. It runs
  while muted, so unmuting never replays stale changes.
- `OutbreakAudio` (`outbreak-audio.ts`) plays them through one `AudioRuntime`: listener at the survivor's drawn
  position (ear 1.7 m, full pan at 12 m to either side of the top-down camera), distance rolloff from each id's range,
  occlusion from the sight geometry (`space.ts`: each wall or closed door between listener and source adds 0.6, a
  window 0.25; the runtime turns it into gain loss and a low-pass down to 950 Hz), room reverb indoors and street reverb
  outdoors (`setSpace`, eased through doorways), footsteps on the rig's own foot contacts (`Survivor.onFootfall`, also
  for remote survivors) on wood, concrete or grass, and beds: birds with the sun, insects with darkness, a threat drone
  following the day cycle's threat curve and zombies chasing within 25 m. Indoors the beds drop and lose their top end.
- Silent until the first pointer or key press. `M` mutes; mute and master volume persist (`outbreak.audio.v1`).
  Automated browsers start muted. The Lab panel's **Audio** group sets master, weapons, movement, zombies, ambience and
  UI levels, wall occlusion, reverb and the voice cap (24). Loops are never stolen by one-shots.

Measured again after the second batch (same proof, mini worker, 250 shipped files, 2,156 KB, all decoded): a miss into
Ash's front wall from the lawn played `impact.bullet.wood`; a reload played its four parts; a crowbar, the pack and a
drop played theirs. 10 s among 100 chasing zombies at 22:00: the rig reported 1,478 foot contacts and the cadence 3
more; 26 zombie steps played (2.6 a second) and the horde bed sat at full level; at most 24 voices (the cap); the audio
update cost 0.062 ms per frame on average (2.7 ms worst); median frame time 7.88 ms with audio on and 7.62 ms muted,
within run-to-run noise. `tests/audio.test.ts` also holds a 100-zombie crowd to the step budget with the bed full.

First measurement (`bun scripts/prove-audio.ts` from `games/outbreak`, production bundle in headless Metal Chromium with
`--mute-audio` on the mini worker, so the graph runs and nothing is heard): all 124 shipped files fetched and decoded;
5 footfalls in a 1.5 s walk; 10 s among 100 zombies at 22:00 played 59 sounds with at most 15 voices (cap 24, 13 stolen
and 10 dropped by per-id limits); the audio update cost 0.037 ms per frame on average (2.1 ms worst, the first frame);
median frame time 7.45 ms with audio on and 8.0 ms muted, the same within run-to-run noise. `tests/audio.test.ts`:
director 0.013 ms per frame with 100 zombies; groans spaced and capped over a simulated minute.

## Not done yet

- Reload part timing uses each id's median transient offset, not the picked variant's own (the runtime picks the
  variant), so a part can land up to about 0.15 s off its pose.
- Co-op peers' channels are not replicated, so their crafting and research loops are heard only by themselves.
- Smashing a container open has no sound of its own beyond the rummage; hotbar switching is silent.
- Outbreak has no Lab scene-sound adapter, so its sounds are heard in the game and auditioned in the Audio section,
  not driven by Lab characters.
- Getaway, Blackout and Carrier migrations: see [shared-code.md](shared-code.md#sound).
