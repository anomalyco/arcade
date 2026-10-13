# Outbreak zombie adapter

`games/outbreak/src/zombie-profile.ts` prepares Outbreak's art controls for the shared human rig in flight.
It uses the draft `human-profile.ts` field names and the existing PR7 `@arcade/kit/rig` clamp helper.
No locomotion, IK, spring, pose evaluation or detached-part engine is implemented here.

The intended performance is an uneven approach toward a target: a short, hunched stride, late chest/head response,
one dragging foot and unequal reaching hands. Four normalized controls map to the shared profile's metres,
radians, timing bias and spring frequencies. Zero removes each exaggeration; it does not change the actor type.

## When the shared rig lands

Use the animation agent's `@arcade/kit/human-profile`, `human-locomotion` and `human-pose` implementations on top
of PR7's rig extraction. Do not copy the current survivor gait to create a zombie renderer.

```ts
import { humanProfiles, type HumanProfile } from "@arcade/kit/human-profile"
import { zombieControls, zombieProfileOverrides, zombieTuning } from "./zombie-profile"

// Merge into the existing settings and controls, using the existing LabPanel instance.
const settings = { ...viewSettings, ...zombieTuning }
const controls = [...viewControls, ...zombieControls]
let profile: HumanProfile = { ...humanProfiles.zombie, ...zombieProfileOverrides(settings) }

// In the shared Lab's change callback:
profile = { ...humanProfiles.zombie, ...zombieProfileOverrides(settings) }
// Pass this profile to the common actor renderer/pose evaluator.
```

The descriptors are ready for the shared Lab but are not installed as inert live controls in M1. The shared rig
is still in flight, and M1 has no zombie actor. The adapter has no rendered-motion proof yet. Its integration must
preserve `supportHeight(town, x, z)` for foot contacts, thresholds and terrain, plus teleport/reset behavior.
Validate forward/sideways/backward approaches, stop/start, turns, slopes and doors at normal playback speed.
Use `Vision.visible` before submitting a zombie draw; remembered scenery is not permission to draw an actor.

## Detachable parts

The shared rig owns stable part identities, attachment transforms and visual detachment. Outbreak's future
server snapshots/events decide which limbs are attached and any movement, attack or health consequence.
The client consumes those decisions and presents local detached visuals; a local debris collision or Lab edit
must never change authoritative limb state, damage or movement capability. Use the shared detachment API when
it lands; do not introduce an Outbreak limb enum, ragdoll integrator or dismemberment event format meanwhile.
