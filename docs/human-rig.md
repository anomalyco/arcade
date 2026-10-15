# Human rig

`@arcade/kit/rig` is the canonical Outbreak/Blackout frame, spring, IK and proportion module. The Blackout
`src/game/rig.ts` path re-exports it. There is no second skeleton or renderer in this package. For how the rig
should move and why, read [animation.md](animation.md).

## Ownership

| Module | Owns |
| --- | --- |
| `human-profile` | Serializable soldier, wizard and zombie presentation presets; shared Lab controls |
| `human-locomotion` | World-locked contacts, toe roll, swing/reach, timing asymmetry, foot drag and pelvis springs |
| `human-pose` | Arm/leg IK, semantic bones, attachments, visibility and copied detach motion |
| Blackout `anim.ts` | Avatar adapter, weapon aim/recoil and action clips |

All frames and velocities use world XYZ with Y up. The locomotion adapter's `x/y`, `vx/vy` and aim follow the
games' X/Z ground plane. Angles are radians, distances metres, linear velocities metres/sec, angular velocities
world radians/sec and spring frequencies Hz. The current shared contact solver targets a flat Y=0 floor.

The server owns health, movement and attack consequences. A hidden limb does not change those rules. Visual
subtrees keep an underlying animated pose so IK and corpse attachment remain well-defined after removal.

## Profiles and consumers

```ts
import { humanProfiles } from "@arcade/kit/human-profile"

avatar.profile = humanProfiles.soldier // Blackout: undefined also follows the live Animation Lab
avatar.profile = humanProfiles.wizard // narrower gait, upright trunk, right-hand staff target
avatar.profile = humanProfiles.zombie // uneven timing, dragged right foot, delayed aim, asymmetric reach
```

Presets are immutable. Spread a preset to tune an individual actor; it will not change other actors or the Lab.
The neutral soldier defaults to the crouch-run posture: `leanScale=1.25`, `hipDrop=0.095`, `bobScale=1`,
`turnBank=1`, `stepLift=1`, `armSwing=1`, `transitionHz=6`, `runPosture=0.34`, `crouchDepth=0.08`,
`headStability=0.8`. Weapon clips can replace rest
hand targets before IK. Profile hand poses do not implement spells, attacks, pathfinding or new zombie AI.

The comparison fixture uses the test mesh and a hand-attached staff. Runtime Blackout wizards use the released
wizard meshes and the shared wizard posture, with `handPose="weapon"` so their staff/wand/orb aim frames and
casting clips retain ownership of the hands. An explicit per-actor profile takes precedence.

Outbreak's `zombieProfile` maps its lurch/asymmetry/drag/reach controls onto the shared preset. Lab → Zombie → Pose
switches the existing survivor's presentation to Zombie. The terrain adapter retains its height sampling and
existing contact schedule; it consumes shared posture, hand IK and angular springs plus profile stride, timing
and drag values. Survivor remains the default. This is a local pose preview, not an NPC or a gameplay mode.

Consumers with a different avatar shape implement the structural `Locomotion` state, smooth their root inputs,
then call `locomotion(state, dt, distance, teleport, profile)`. `poseLegs(state, pelvis)` preserves the rendered toe
lock. `poseArms(torso, leftHand, rightHand)` solves game-owned hand targets. `profileTorso` must run before locating
shoulders and neck. See Blackout's adapter for clip precedence and independent weapon-frame ownership.

## Attachments and detachment

```ts
import { attachment, bodyBones, detach, pointVelocity } from "@arcade/kit/human-pose"

const bones = bodyBones(displayedBody)
const hand = attachment(bones, "right.hand", hiddenBones) // Frame | null
const pieces = detach(bones, previousBones, dt, "right.foreArm", hiddenBones)
// pieces: { bone, frame, linear, angular }[]
```

Sample after posing and before rendering. `detach` copies the exact displayed frame, hides the selected subtree,
and returns visible descendants only. Repeated or absent-part detaches return an empty array. No previous frame
or invalid dt produces zero seed velocity. Keep previous/current samples on the same clock; a teleport starts
a new history rather than seeding an enormous velocity.

The linear velocity is at the frame origin, not at the centre of mass. `pointVelocity(piece, worldPoint)` computes
`linear + angular × (worldPoint − frame.p)` for an offset centre of mass or emitter. Debris physics owns the copied
frames and begins integrating on the next tick; integrating before the first emission would introduce a spawn pop.

Semantic IDs are `pelvis`, `torso`, `head`, and `left`/`right` `.upperArm`, `.foreArm`, `.thigh`, `.shin`, `.foot`,
`.toe` (`left.toe` is `limbId 13` parented to `left.foot`; `right.toe` is `limbId 14` parented to `right.foot`, keeping
existing IDs `0..12` unchanged). The foot splits at the ball (MTP joint) into `RIG.foot = 0.125 m` (ankle to ball) and
`RIG.toe = 0.065 m` (ball to toe tip, `0.19 m` total forward reach, `RIG.heel = 0.06 m`), exposed on `HumanBody.toe`.
Attachments are `left.hand`, `right.hand`, `head.top`. `limbIds` gives explicit stable numeric cosmetic IDs; never
derive IDs from model registration order. Blackout's corpse adapter copies the visibility mask on death. Detaching
from a corpse samples `bodyBones(ragdollBody(...))`, not its last living pose; hidden constraints remain visual-only.

## Cosmetic splatter

Blackout's `human-splatter.ts` adapter calls the released `Game.cosmeticSplatter` hook. Pass one selected detached
part, a caller-owned event ID and seed, and a world-space impact direction. An optional world-space wound point
uses offset velocity; otherwise the part's origin is used. The adapter maps `BoneId` through `limbIds` and forwards
sampled linear motion. It does not infer impact direction from angular velocity or emit for every descendant.

The Detached forearm fixture exercises this adapter. Enable Blood → Surface splatter in the shared Lab to see
the burst. The hook retains its style gate and event/limb deduplication; production blood defaults are unchanged.
Actual gameplay detach events still need a server-owned damage policy and caller-owned event identity.

## Interactive Characters page, Lab and proof

Open `/arcade/blackout/characters.html` (reachable from the Dev Hub top bar under `Characters`, with deep-link hashes `#soldier`, `#wizard`, `#zombie`, `#survivor` and `#outbreak-zombie`). It renders Blackout's soldier, wizard and zombie alongside Outbreak's survivor and zombie on a lit tile stage through the real `Game`/`Renderer` and shared `@arcade/kit` rig:
- Orbit, pan, zoom and frame (`F`) share `@arcade/kit/orbit-gestures` with the Catalogue viewer.
- Click an actor (or its tab) to select it; press `P` (or `Possess · P`) to possess and drive it with normal game keys (QWERTY `WASD`, Dvorak `, o a e`, arrows, `Shift` sprint), and `Escape` to release back to Edit mode.
- Switch profiles per actor, trigger `Walk loop`, `Run loop`, `Stop`, `Detach limb` (any bone subtree, with surface blood splatter) or `Reset`, and control transport with `Pause`, `Step` (`1/60 s`) and `Speed`.
- The `Lab ~` button (`Backquote`) toggles the shared `LabPanel` scoped to the selected actor's `Profile` controls.

For scripted A/B fixtures, `anim.html?lab=1` retains `Profile walk`, `Three profiles` and `Detached forearm`. Production defaults remain the neutral soldier profile (`4500970e` New parity; `8223033` Old parity).

`games/blackout/scripts/prove-characters.ts` and `games/blackout/scripts/prove-human.ts` exercise interactive possession, camera gestures, per-actor profiles, attachments, detach handoff and Lab input on headless Metal through Hivemind. Shared tests cover contact locking, asymmetry bounds, semantic IDs, attachment visibility and origin/offset motion. Blackout tests cover default/profile parity, dt spikes, missing limbs, weapon stability and corpse detachment. Visual proof and release-base results belong in `perf/human-rig.md`.

## Motion rules and tuning

This file covers the API. The gait, contact, arm and posture rules, their measured values and the known gaps are in
[animation.md](animation.md). The measure-first tuning procedure and its scripts (`pose-diff.ts`, `gait-metrics.ts`,
`render-sheets.ts` under `games/blackout/scripts/animation/`) are in the
[`procedural-animation-iteration`](../.opencode/skills/procedural-animation-iteration/SKILL.md) skill.
`@arcade/kit/pose-diff` supplies the joint extraction, BVH retargeting, Williams reference poses and cycle comparison
those scripts use.
