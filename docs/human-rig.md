# Human rig

`@arcade/kit/rig` is the canonical Outbreak/Blackout frame, spring, IK and proportion module. The Blackout
`src/game/rig.ts` path re-exports it. There is no second skeleton or renderer in this package.

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
The neutral soldier preserves PR #9's restored forward posture: `runPosture=0.18`. Weapon clips can replace rest
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

Semantic IDs are `pelvis`, `torso`, `head`, and `left`/`right` `.upperArm`, `.foreArm`, `.thigh`, `.shin`, `.foot`.
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

## Lab and proof

Open `anim.html?lab=1`. Animation contains Profile and all profile parameters, plus exact keyboard editing,
Randomize, Reset and Copy. Demo offers Profile walk, Three profiles and Detached forearm; Demo speed is in m/s.
The scripted fixtures loop and use the real Game/Renderer. Production defaults remain the soldier profile.

`games/blackout/scripts/prove-human.ts` exercises profiles, attachments, detach handoff and Lab input on headless
Metal. Run through Hivemind; `--video` captures 180 frames. Shared tests cover contact locking, asymmetry bounds,
semantic IDs, attachment visibility and origin/offset motion. Blackout tests cover default/profile parity, dt spikes,
missing limbs, weapon stability and corpse detachment. Visual proof and release-base results belong in `perf/human-rig.md`.
