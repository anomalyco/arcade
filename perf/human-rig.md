# Shared human rig proof

Status: PR #13's released main is merged; runtime wizard/terrain-zombie adapters and the splatter hook are wired.
Final release-base workspace and Metal checks are in progress.

Hivemind run `20261013-130146-98650` passed on the Mini: frozen root install, ten shared-package tests,
Blackout client/server/script typechecks, all 288 tests (including 18 animation cases) and production build.
The subsequent clean `git archive` export of `03aea689a966c88f8de6a651cb983a9dc3fed170` also passed frozen
installation and package checks, both games' typechecks/builds, 288 Blackout tests and 177 Getaway tests
(12 existing skips), both production lobby smokes and both Worker dry-runs. No deployment occurred.
That pre-release archive did not contain Outbreak. Release-base results below supersede it for consumer integration.

The first Hivemind check reached the new Mini after a cold sync but failed before running tests: its non-login
shell PATH omitted `/opt/homebrew/bin`, where Bun 1.4.2 is already installed. The corrected invocation explicitly
prepends that directory and `$HOME/.bun/bin`; no toolchain installation or worker service change is required.

## Baseline

The canonical `packages/kit/rig.ts` matches PR #13's rig byte-for-byte (SHA-256
`78cafc3896fdb94c7a18b8724d54a273a1a74d046678d9805f439ab854506e03`). The GPU extraction is not modified.

900 frames per animation mode were compared with `822303310da0bd95901879570e27c5b942ca4aa9` in one Bun process.
Walk/run/sprint, turning, seeded recoil and hit events produced exact JSON body equality:

| Mode | Both source hashes |
| --- | --- |
| Old | `00bde28afe7d26930d81018826ee561968bf95508793210202b301ee80a6e9ac` |
| New | `f6efd0e32ebeb77beef47891277c0f8911f7c6e9ab58a8feb1ad28b6423a02e5` |

Reproduce with `scripts/prove-human-parity.ts <exported-baseline-repository>` from Blackout. This verifies the
refined soldier pose, not identical GPU pixels across graphics implementations.

After merging released main, both soldier hashes still match. Outbreak's default survivor also matches its
released-main adapter exactly over 600 frames: a curved path, turning aim and sloped support, comparing every
emitted instance byte. Both SHA-256 hashes were `9a41bbb8e1eea9d8ed3c38aeed32e721220ed87f22841cd7fa031a988c115c10`.
The zombie override is opt-in; default terrain motion is preserved.

## Fixtures

Animation Lab → Three profiles presents a soldier, wizard with a hand-attached staff, and asymmetric zombie.
Detached forearm copies the posed right forearm at two seconds; physics starts on the following tick.
Profiles, speed and individual parameters live in the shared Lab. The scripted fixture loops every six seconds.

`scripts/prove-human.ts --video` captures the three presets, their comparison and six seconds of detachment,
then exercises Randomize, Reset, exact Copy and keyboard profile selection. Headless Chromium must report Metal.

The first run on Studio reported `apple / metal-3`, three profiles, one detached forearm, exact copied spawn frame,
180 captured frames, passing keyboard/Copy controls and zero page/GPU errors. The comparison, individual profiles,
and detach samples before/at/after release were inspected. The sample shows staff attachment, an asymmetric
reaching zombie, and the detached forearm falling behind the moving actor. It does not establish continuous
playback quality. Captures are in `captures/shared-human/`; `proof.json` includes profile poses and copied settings.

## Limits

The three-profile fixture uses the test soldier mesh. Runtime wizards retain the released wizard meshes and
weapon/casting adapters. The zombie is a pose/gait profile, not a new NPC simulation. The shared contact solver
is flat-ground; Outbreak retains its terrain contact schedule and consumes shared posture/hand IK and springs.
Detached debris uses simple local gravity/floor response. Hidden corpse joints retain constraints; this is not
physical dismemberment or a server movement/damage rule. Continuous playback and CPU/GPU cost are unmeasured.
Existing Blackout cadence remains unchanged and higher than the research reference targets.
