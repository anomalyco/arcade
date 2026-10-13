# Arcade integration

One review branch, based on `origin/main` at `bf5f6277e38ee52e9bfa4ae4a01337b46175c181`.
Sources were snapshotted before merging on 2026-10-13. Each source is merged separately in this order.

| Source | Exact committed tip | Original PR |
| --- | --- | --- |
| fix/blackout-quick-taps | `7519dcc67be91e0077f23c253dc3320d198ba88f` | #11 |
| blackout-look (local) | `111dda9b40c8610e0235fdd0049b4aa37bf930f6` | #8 |
| blackout-anim | `822303310da0bd95901879570e27c5b942ca4aa9` | #9 |
| fx-kit (local) | `452db1806a5978d38c752a515ab8099ef136cc33` | #12 |
| vehicle-kit | `0bbe1a962012f4c2bf2b980c161af1e9d4aa9d91` | #6 |
| outbreak | `e5554a76fc3543ef9ce4ca2a37829005fd0b44b2` | #7 |
| wizards | `2e3177ab673bcdc8163eb7d8cb6e858b34ddd808` | — |
| compare-video | `716b5cdc074038b845a5713905735a3e581b3116` | — |
| architecture-plan | `f05630039bf2ee28f1b142144c0318a7473f4398` | — |
| simplify-review | `81e9a4b94e08a76494dccbdf0dc0cd832813e013` | #10 |
| audio-lab (additive follow-up) | `778b8a157ae7c5b46092d6ce9030638e0b3458d6` | — |
| outbreak-look-refinement (additive follow-up) | `5805f66ab08a4a9e2ffbd8a17de27dd2be6bdd0e` | — |
| lab-workbench (additive follow-up) | `bb0eca486375a0044e515cc950b263bc484fa7d4` | — |

The local Look tip includes the window moonlight coverage fix missing from its remote PR.
The local FX tip includes surface splatter and the completed fire/water work.
Wizards' latest committed change is immediate click casting (`2e3177a`), after the older rune-casting study.

## Excluded

The unfinished `shared-human-rig` work remains excluded. The initial Lab workbench, Audio Lab and Outbreak refinement
are included. Additional smoke-volume and workbench refinements are pending as described below; the other items here
are intentional scope exclusions.

- Rejected experimental Getaway look presets; existing approved Night presentation stays.
- Historical branches already squashed into main.
- Wings changes and public homepage promotion of Outbreak or Wizards.
- Unfinished `shared-human-rig` work: its worktree has modified animation/rig/Lab files and untracked
  `human-locomotion.ts`, `human-pose.ts`, `human-profile.ts`, `human.test.ts`, `rig.ts` and proof/demo files.
  None of that uncommitted work is an integration input.

## Resolution and verification log

- Look/FX: retained tile reflections, separate fine moon mask, and removed sound rings/shot lamp brownouts.
  Explicit Lab lamp sparks remain available without reviving shot-triggered light changes.
- Vehicle/FX: one canonical tyre solver and GPU pipeline in `kit/fx`; `kit/vehicle` holds compatible adapters.
  Moved live effect settings and sprite identities into kit so Lab tuning reaches shared vehicle emitters.
- Outbreak extraction: forward-ported current renderer, input and camera changes into the canonical kit modules.
  Motion stays at binding 7, fine moon mask at 8, exploration at 9. Blackout paths are adapters/re-exports.
- Wizards: immediate click capture and gun tap capture both survive; animation adds wizard pose to the latest gait.
- Simplify: retained `testEffect`, shared motion and dependent GPU timing, and the benchmark emission-study methods
  used by current FX/Lab proof runners. Retained the corresponding smoke proof script; removed obsolete proof
  scripts and unused ghost submission path. Kept shared implementations rather than reviving per-game copies.
- The first remote package check saw stale `kit/playground` files from Hivemind's reused checkout seed, which are
  absent from this branch. Subsequent checks use a clean archive export.

## Local review

Outbreak's `5805f66` art refinement is included and needs local visual review. It reduces the washed-out look and
adds house setbacks, frontage planting and usable furniture groups. It remains darker and less textured than the
paintover; foliage is angular, some corners are too dark, and the interior still feels sparse. Neither the source
comparison nor functional proofs establish visual approval or a target match. Shared-renderer hooks stay opt-in,
preserving Blackout/Getaway defaults and the fine Blackout window mask. This PR stays draft; no deployment is authorized.

The shared hybrid audio runtime and Audio Lab are included. In either existing Lab host, choose **Audio**.
**Audition** is the only live unlock action; entering the section or changing controls does not start playback.
**Render offline** renders the selected recipe without playing it. Approved in-game vehicle audio stays in use;
the new candidate voice graphs are for review, with their reuse/parity boundary in `docs/audio-design.md`.

Further `smoke-volume-refinement` and `lab-workbench` follow-up work remains in independent branches. Their next tested
commits are not yet inputs to this PR and do not block upstream reconciliation. The workbench revision already listed
in the source manifest remains included.

The standalone Lab workbench is included. Its Library selects effects, objects, lighting and audio directly;
the Inspector shows the selected item's controls beside a correctly sized central viewport. Edit/Play, transport,
room-seed reroll and keyboard interaction replace the prior long all-effects control list. Embedded game debug
overlays remain floating panels. Audio still requires an explicit Audition click before live playback.

Run `bun install --frozen-lockfile` at the root. Start each client from its game directory with
`bunx --no-install vite --host 127.0.0.1`; Blackout also needs `bun scripts/build-id.ts` first.
For the full game server use the existing `bun run dev` script from Getaway or Blackout.

The integration worktree has these named client previews:

- Getaway: <http://arcade-review-getaway.localhost:1355/?peaceful=1&seed=7>
- Blackout: <http://arcade-review-blackout.localhost:1355/?sandbox=1&seed=1>
- Wizards: <http://arcade-review-blackout.localhost:1355/?sandbox=1&mode=wizards&seed=1>
- Shared Lab: <http://arcade-review-blackout.localhost:1355/lab.html>
- Outbreak: <http://arcade-review-outbreak.localhost:1355/?solo&seed=7>

These client previews support local play. The sniper network proof uses a mocked socket feeding the real shared World.

## Combined-tree evidence

- Package check: 30 tests passed. Getaway: 188 passed, 12 existing skips. Blackout: 342 passed. Outbreak: 14 passed.
  All game typechecks and builds passed, with the normal Blackout chunk-size warning.
- Metal on the local named previews: sniper taps passed local and mocked-network paths, each with 12 predicted and
  12 authoritative shots. Click-casting passed independent cooldowns, wheel/1/2 selection, caster-targeting skeletons,
  Moon Ball capture/pop, Dvorak movement and Lab input isolation.
- `scripts/prove-integration.ts` drove the combined Getaway capture hook, observed 33 smoke particles, checked all
  approved light defaults, and crossed the tunnel at 32.43 m/s. Outbreak's closed-door sample changed from unexplored
  to visible after interaction. Blackout retained reflections/default-off motion and absent ring/lamp toggles; a
  forced tyre-smoke fixture also rendered with motion enabled. Spawn, fire/water and splatter Lab sections rendered.
- The GPU proof caught and repaired the shared vehicle-sprite return type in the MRT motion shader and added a
  compatible tyre-smoke pipeline for that attachment layout. No browser/GPU errors remained in the cited proofs.
- Cited local evidence: `2026-10-13-arcade-integration/`, relative to the local artifact root (screenshots and JSON reports).

Final verification used a clean `git archive` of `c61876d` on the Studio through Hivemind. Frozen install, the package
check, all three game checks, all three production smokes, and all three `wrangler deploy --dry-run` commands passed.
The Blackout/Getaway production smokes check the lobby; their gameplay GPU proof is the separate Metal run above.
No deployment or main-branch push has run.

To repeat from a clean export:

```sh
git archive HEAD | tar -x -C /path/to/empty/export
cd /path/to/empty/export
bun install --frozen-lockfile
bun run check:packages
for game in getaway blackout outbreak; do
  (cd "games/$game" && bun run check && bun ../../scripts/smoke.mjs && bunx --no-install wrangler deploy --dry-run)
done
```

Run the checks through the fleet in this environment. The smoke runner requires an installed Playwright Chromium.
The repair commits after source integration contain the adapter and GPU fixes; this document records their
combined verification rather than relying on any source PR's checks.

### Release-scope follow-up

`48430d9` separates recognized mode IDs from public choices. Wizards stays playable through explicit routing and
existing wizard rooms, but ordinary Create/Host menus and next-round voting omit it. Stale stored wizard selections
fall back to a public mode. Two regression tests cover public discovery, vote rejection and continued wizard rounds.
A fresh archive passed Blackout's full check (344 tests) and production smoke on the Studio. A separate Metal check
confirmed the real menu output and direct wizard sandbox with both spells ready and no browser errors.

Public reports use paths relative to an artifact root; the original local evidence files were preserved.

### Audio Lab integration

The exact `audio-lab` source tip `778b8a1` was merged with a separate merge commit. Its copied panel files already
matched the integrated changes; the existing Lab panel/navigation code was preserved. Integration then registered
Audio in both hosts, added per-host sample routes/build assets, removed the test-context production import, and
reconciled emitter/voice ownership. The four generated stems retain the source commit's bytes and provenance.

A clean archive of `d688c7f` passed frozen install, package checks (39 tests), Getaway (197 tests, 12 existing skips),
Blackout (353 tests), Outbreak (14 tests), all production smokes and all Worker dry-runs through Hivemind on the Studio.
`scripts/prove-audio-integration.mjs --production` then exercised the actual built Lab pages under their deployed
prefixes. Both decoded all 20 MP3 assets, and the Outbreak-prefixed asset route independently decoded the same 20.
The build rejects imports of the deterministic test context into any game bundle.

Local named-preview checks and the production proof used native browser `OfflineAudioContext`, with live contexts
deliberately blocked and browser output muted. Entering Audio created neither live nor offline contexts; only clicking
Audition attempted live unlock, which the proof blocked. Render offline produced nonzero PCM with no clipped samples.
The one-shot fixture disconnected all 18 owned nodes. The vehicle/spell fixture stayed below full scale, reset and
suspended its emitters, had a silent final tail, disposed cleanly, and retained exactly one nitro ignition through
exhaustion/refill while held. Both hosts had no browser/GPU errors, and leaving/re-entering Audio did not resume playback.

These proofs establish decoding, graph scheduling, cleanup and gating in a browser, not subjective sound approval
or successful audible playback. Existing in-game vehicle voices remain in use. Cited audio screenshots, check logs
and JSON reports are in `2026-10-13-arcade-integration/audio/`,
relative to the local artifact root.

### Outbreak art integration

The exact `5805f66` refinement tip was merged after Audio Lab. All 12 default shared shader outputs match the
pre-merge integration (`dcd0272`) after whitespace normalization, including Blackout's look/motion combinations.
Bindings remain motion 7, fine moon mask 8, and exploration 9. A compatibility adapter extracts legacy directional
coverage from the packed floor map when a level supplies no separate mask. This preserves Outbreak's indoor sky
mask instead of replacing it with white; explicit Blackout window masks retain their finer resolution. Two focused
regression tests cover the distinction. The Outbreak R8 compatibility texture is 144 KiB at its 384² mask size.

The source branch reduced static vertices from 299,238 to 196,722 (about 34%). Its paired queue-completion spans
support broadly unchanged frame cost, not a measured GPU speedup. Those measurements have not been repeated on
the combined renderer.

A clean archive of `5365942` passed frozen install, package checks (41 tests), Getaway (199 tests, 12 existing skips),
Blackout (355 tests), Outbreak (15 tests), all production smokes and all Worker dry-runs on the Studio through
Hivemind. The production Audio Lab proof also passed again, including all three asset prefixes.

The merged Outbreak build passed native Metal door/LOS, F/WASD/Dvorak, Lab input-isolation and contribution-selector
checks without browser/GPU errors. Its seed-7 1000×680 street and interior beauty captures match the refinement
source's corresponding captures pixel-for-pixel (zero differing RGB pixels in both). Both report 196,722 static
vertices. This verifies those two integrated views against the source revision, not against the paintover or all
possible views. Timing was disabled for these captures.

Cited merged-build images and reports are in `2026-10-13-arcade-integration/outbreak-refinement/`, relative to the
local artifact root. Visual gaps remain as described above and in `docs/outbreak-look-v2.md`; local review is needed.
Linux CI took 6.0 seconds for the six-generation reproducibility test, exceeding Bun's default five-second timeout.
That test alone now has a 20-second allowance; its mesh/mask assertions are unchanged, and this is not a frame-cost budget.

### Lab workbench integration

The exact `bb0eca4` workbench tip was merged after the Audio and Outbreak follow-ups. The integrated Audio lifecycle,
sample asset roots, Outbreak sky-mask adapter and motion7/moon8/exploration9 bindings were preserved. Existing game
effect defaults were compared directly with `76b96dc`; all values match. The new Lab-only glass/paper size multipliers
default to one and are labelled as multipliers rather than metres. Game renderers and simulation code did not change.

A clean archive of `7ff751c` passed frozen install, package checks (42 tests), Getaway (200 tests, 12 existing skips),
Blackout (356 tests), Outbreak (15 tests), all production smokes and all Worker dry-runs on the Studio through Hivemind.
The combined Metal workbench proof passed for both hosts:

- Canvas dimensions exactly matched the center viewport: 740×722 at a 1280×800 window, and 1380×1002 at 1920×1080.
- Keyboard library search selected Glass shards. Only Emitter, Glass shards and Environment were mounted, with
  23 controls; shard scale changed to 2.2× by keyboard. Room reroll preserved the effect and edited size.
- Group reset and undo/redo passed. A placed hydrant could be undone/redone. The car reached 10.92 m/s in Play;
  Escape returned to Edit with zero throttle, and editing the Inspector left input released.
- Audio selection and native offline rendering made zero live AudioContext attempts. Preset validation rejected
  invalid input without losing the current scene. No browser/GPU errors occurred.

The production Audio Lab proof passed again with its per-host asset/decode, cleanup and lifecycle assertions.
The real Blackout floating overlay also passed the sniper local/network input proof, retaining 12 predicted and
12 authoritative shots in each path. Both named local Lab previews were checked in their normal interactive mode:
the workbench appeared, canvas dimensions matched, and Audio selection stayed silent with no browser errors.

Cited combined screenshots and reports are in `2026-10-13-arcade-integration/workbench/`, relative to the local
artifact root. Source-branch screenshots remain separate. The unfinished shared-human-rig work is still excluded.
