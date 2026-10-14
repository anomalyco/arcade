# Animation

What we have learned about procedural human animation in arcade, written as rules with the numbers behind them
and the reason each rule exists. Every humanoid in Blackout and Outbreak runs on the shared rig in `packages/kit/`,
and a new game should start from the same rules.

Three documents split the subject, and each fact lives in only one of them:

- This file holds the insights: what the motion should do, the measured values, and what is still wrong.
- [human-rig.md](human-rig.md) holds the module API: ownership, profiles, attachments, detachment and the
  Characters page.
- The [`procedural-animation-iteration`](../.opencode/skills/procedural-animation-iteration/SKILL.md) skill holds
  the procedure: how to turn a feel note into metrics, which scripts to run, and how to prove a fix.

The rules that matter most: drive both feet from one anti-phase stride clock; never move a planted toe; build
the body's vertical motion as one smooth curve sampled from phase, never from impulses; drive arms by joint
angles, not by Cartesian hand targets; and never let a planted foot pull a leg past its length.

Numbers below come from `games/blackout/scripts/animation/gait-metrics.ts` and `pose-diff.ts` at fixed
speeds (walk 1.4, run 4.2, sprint 6.3 m/s, `dt = 1/60`) on main on 2026-10-14 (`23e8250`), unless a line says otherwise. Mocap
means the Bandai Namco walk and run clips described in
[the fixtures README](../games/blackout/scripts/animation/fixtures/mocap/README.md).

## Code map

| File | What it owns |
| --- | --- |
| `packages/kit/human-locomotion.ts` | `gaitAt` (stride, duty, run blend), `locomotion` (stride clock, step release, swing, pelvis springs, arm springs), `plantedFoot` (toe lock and roll), `pelvisPoint` |
| `packages/kit/human-pose.ts` | `poseLegs` (leg IK, swing ankle), `unarmedHands` (FK arm angles), `poseUnarmedArms` (arm IK pole), `poseArms` (armed hands) |
| `packages/kit/human-profile.ts` | `humanProfiles` presets and their Lab controls |
| `packages/kit/rig.ts` | `RIG` link lengths, `ik`, frames and springs |
| `games/blackout/src/game/anim.ts` | `animate`/`build`: pelvis pitch, torso and head, weapon frame, action clips |
| `games/outbreak/src/survivor.ts`, `zombies.ts` | Terrain adapters with their own stride clocks |

The leg is `RIG.thigh + RIG.shin = 0.42 + 0.41 = 0.83 m`. Hip height is about 0.86 m.

## Gait timing

**Drive both feet from one stride clock, half a cycle apart.** `locomotion` releases a foot when its phase
(`a.phase + 0.5 × i`) passes the duty factor and it has been planted for at least 55% of a stance. Separate
per-foot timers drifted into a locked stagger: 45% in the run and 12.5% in the walk, which read as a limp. After
the fix the survivor run's left/right step-time ratio went from 1.45 to 1.00 and step-time variation from 18.5%
to 1.2%. Keep the L/R ratio within 1.00 ± 0.01 and variation under 2%.

**Advance the clock by cadence, with stride from the Froude number.** `gaitAt` blends walk to run on
`Fr = v² / (g × 0.83)` between 0.36 and 0.64 (1.7 to 2.3 m/s). Stride grows almost linearly with speed at low
speeds and then flattens above 3.6 m/s, so speed comes increasingly from cadence, as in human running
(Alexander 1984). If stride and distance travelled disagree, the phase wraps unevenly and the body bobs with a
beat every few steps; it shows as a subharmonic in the pelvis curve, not as a visible single-frame glitch.

| Mode | Speed | Cadence | Step length | Duty factor | Double support | Flight |
| --- | --- | --- | --- | --- | --- | --- |
| Walk | 1.4 m/s | 157 steps/min | 0.54 m | 0.56 | 12% of the cycle | 0 |
| Run | 4.2 m/s | 240 steps/min | 1.05 m | 0.32 | 0 | 36% |
| Sprint | 6.3 m/s | 285 steps/min | 1.32 m | 0.24 | 0 | 52% |

The old notes quoted about 207 steps/min at 1.4 m/s. That was before the stride clock fix; 157 is current.
Human walking at 1.4 m/s is closer to 110 steps/min (the mocap walk clip takes 109), so our walk still steps
fast with short steps. See Known gaps.

**Run with flight; do not crouch to reach.** A running foot releases its support once the other foot's swing
is 32% complete (48% when strafing), which gives the flight fractions above. Swings last 0.08 to 0.385 s.
Crouching the hips to reach a distant lock looked worse and still overstretched the leg.

## Body bob

**Build the vertical bob as one smooth curve sampled from phase.** `locomotion` drives `m.bob` with a single
harmonic at twice the stride frequency and compensates the spring's gain and lag, so the sampled curve keeps
Williams' timing: Contact at the mean height, Down lowest an eighth of a cycle later, then rising through Passing
to Up. Peak-to-peak pelvis travel is 4.1 cm walking, 5.9 cm running and 4.5 cm sprinting; the mocap walk travels
4.0 cm.

**Do not add touchdown impulses.** A dip kicked on touchdown produced jerk spikes of 280 m/s³ in the walk and
630 m/s³ in the run. The smooth curve cut them to 90 and 450. `packages/kit/human.test.ts` caps touchdown jerk at
95, 540 and 880 m/s³ for walk, run and sprint.

**Keep one amplitude across the walk-to-run blend.** An earlier version blended a walk bounce (`+cos 2θ`) with a
run bounce (`−cos 2θ`), and the two cancelled to zero at `run = 0.5`. The current curve has one phase and an
amplitude that grows with `run`.

**Check the subharmonic.** Energy at half the step frequency means left and right steps differ. The walk's
subharmonic ratio fell from 0.92 to 0.03 once the stride clock was shared.

**Keep the pelvis between the feet and near the aim.** The pelvis yaw springs toward the circular midpoint of
the two foot headings and never leaves 1.05 rad of the aim; the leg heading obeys the same limit.

Side-to-side, the pelvis shifts toward the stance foot (`m.sway`), drops on the swing side by `hipDrop`
(0.095 rad for the soldier), banks into turns from lateral acceleration (up to 0.18 rad), and twists with the
feet's forward offset. These are the classic determinants of gait (Inman 1981). Pelvis sway and drop are
amplified 1.6× (`swayScale`, `twistScale`) because the games are seen from above.

## Foot contact

**Lock the rendered toe in world space, not just the IK target.** `plantedFoot` pins a point 0.19 m ahead of the
ankle (`lockToe`), and the boot pivots around it. A clamped IK endpoint can move the mesh while the stored lock
reports zero slip, so measure the rendered toe. Planted toe slip is below 1e-12 m in every gait test.

**Touch down at zero speed.** Horizontal swing motion uses `smoother(u)`, which has zero velocity at both ends, and
the lift is `1.72 sin²(πu)(1 − u)`: it rises early (peak at about 42% of the swing) and settles cubically.
Contact foot speed fell from 0.63 to 0.03 m/s in the run. Walk lift peaks near 8 cm and run lift near 20 cm.

**Roll heel to toe.** In late swing the toe lifts up to 0.20 rad and settles flat by touchdown; in terminal
stance the heel rises onto the locked toe by up to 0.26 rad (`plantedFoot`, from 62% of stance). At liftoff the
toe pivot fades out over the first 25% of swing (`poseLegs`), so liftoff and touchdown are continuous.

**Let the swing ankle relax.** Between 22% and about 80% of the swing the foot follows the shin with a 0.12 rad
toe drop, then recovers ground alignment before contact. A foot held flat while the shin is near horizontal
looks rigid.

**Turn feet in place.** A planted boot stays within 0.96 rad of the leg heading and pivots at its toe when it
exceeds that. Idle feet replant when their home error passes 0.24 m.

## Foot placement and legs

**Place the landing ahead of the hip by half a stance.** `computeTarget` predicts the footprint from the
remaining swing time plus half a stance, measured from a lagging foot centre. That centre is a 4 Hz spring that
trails the root by up to 0.30 m, which gives a slanted feet-to-head line at speed, sideways lean in tight turns,
and catch steps ahead of the body on hard stops.

**Fold mid-swing retargets into the swing start.** Writing a new landing target directly into the swing
interpolation scaled the change by the completed swing and snapped feet by up to 0.35 m on hard stops. The fix
rewrites `f.lift` so the foot's current position is unchanged and only the remaining swing bends toward the new
target.

**Release a foot before the leg overstretches.** A planted foot that falls more than 0.52 m from the root, or
0.34 m behind it during a reversal, steps immediately. Before this rule, a start from rest at sprint speed
stretched the hip-to-ankle distance to 1.46 m on a 0.83 m leg; the IK clamped the shin and the boot visibly
separated from it by 53 cm. That is the main cause of "legs kick out".

**Keep the knee pole above the swing chord.** The knee pole is `dirIn(pelvis, 1, 0.28, ±0.25)` in pelvis space.
A level pole tilted down with the crouch-run pelvis, lined up with the hip-to-ankle chord and bowed the knee
outward. With the up-bias there are zero knee flips in all ten stress scenarios.

**Clear the floor before solving IK.** `poseLegs` lifts the swing ankle so the sole stays above the floor, then
solves `ik(hip, ankle)`. Clamping after IK separated the boot from the shin by 7 to 9 cm in a steady walk.

**Filter pelvis height on terrain; never clamp it with `sqrt(L² − d²)`.** Outbreak's survivor clamped the pelvis
to the reach of the farther foot. The square root's slope runs to infinity at full reach, which popped the pelvis
0.36 m in one frame on slopes and reversals (0.57 m for the zombie). A sprung `reachDrop` cut that to 0.05 m.

**Reset when the root jumps.** If every foot is more than 1.1 m from the root, `locomotion` resets the contacts.
The Characters page once moved actors 6 to 10 m at loop wrap without announcing a teleport, and the feet stayed
behind.

## Arms

**Drive unarmed arms by FK joint angles calibrated from mocap.** `unarmedHands` computes shoulder flexion,
abduction and elbow flexion from the arm springs, then places the hand from those angles. Feeding Cartesian hand
offsets into two-bone IK tied the elbow angle to the shoulder-to-hand distance: the elbow bent at mid-swing and
straightened at the peak, the opposite of mocap. Arm angle error against mocap fell from 12.7° to 2.6° in the walk
and from 31.7° to 7.6° in the run.

| Angle | Walk (ours / mocap) | Run (ours / mocap) |
| --- | --- | --- |
| Shoulder flexion | −30° to +19° / −28° to +18° | −58° to +28° / −60° to +24° |
| Elbow flexion | 7° to 35° / 2° to 34° | 77° to 116° / 61° to 121° |
| Abduction baseline | about 12.6° | about 14.5° |

The elbow bends most on the forward swing. Running hands also cross toward the midline by up to 22°.

**Give abduction its own baseline.** Hand targets inside shoulder width drive abduction to zero and pin the arms
to the body. Abduction is set directly, not derived from the hand position.

**Keep the elbow pole behind the shoulder-to-wrist chord.** `poseUnarmedArms` moves the pole with the chord's
length and direction. A fixed pole passed through the arm plane on the backswing and flipped the elbow, which
showed as 41° of abduction.

**Swing each arm with the opposite leg.** Two springs (`m.arms`, then `m.hands`) follow a signal that is 75%
stride clock and 25% actual foot separation, with a phase lead of `0.22 + 1.06 × run` rad to cancel the springs'
lag. The left arm correlates with the right leg at r = 0.92 walking and 0.87 running, with an 11° lag (mocap walk
lag: 17°). Targets: correlation above 0.9 and lag under 10° to 20°.

**Damp a shared output once.** Outbreak once scaled arm swing down in the shared rig and again in `survivor.ts`.
Before a game damps a shared value, check whether the rig already does.

Armed soldiers do not use these rules: their hands come from the weapon frame (`poseArms`) or an action clip.

## Torso and head

**Walk upright.** At or below 1.8 m/s the pelvis pitches less than 1°, the chest 2.5° to 6° and the head less
than 3.5°, with no crouch (`games/blackout/tests/anim.test.ts`). Unarmed characters keep only 22% of the velocity
lean below 1.65 m/s, rising to full lean at 3.4 m/s.

**Lean from speed and acceleration, about the head.** Lean is `0.025 rad` per m/s of velocity plus `0.007 rad`
per m/s² of acceleration, times `leanScale`, capped at 0.24 rad and sprung at 2.5 Hz. `pelvisPoint` moves the
hips under the head rather than throwing the head forward. Backpedalling keeps 35% of the velocity lean.

**Crouch-run is a profile choice.** The soldier's `runPosture` (0.34 rad) and `crouchDepth` (0.08 m) ramp in
with run speed. Measured on 2026-10-13 at run and sprint speed, the pelvis lowers about 14.5 and 17.2 cm, the
knees bend about 75° and 72° (50° walking), the pelvis pitches 12.5° and 15.6° and the chest 29° and 39°. Unarmed civilians keep 32% of the
posture and 25% of the crouch: a 4.2 m/s survivor's chest pitches 10° to 18° against the soldier's 24° or more.

**Pitch the pelvis about the hip axis, after the support roll.** `build` in `anim.ts` does this so both hip joints
stay put and planted reaches are unchanged.

**Align run posture with the leg heading.** Multiplying the posture by `svx / speed` flipped pelvis pitch by
23° in one frame when velocity reversed. Projecting along `a.legYaw` cut that to 1.8°.

**Stabilise the head, attached.** `headStability` (0.8 for the soldier) cancels most of the posture pitch at the
head. Keep the head on the neck: pinning its position separately opened a visible gap.

**Counter-twist the chest.** The chest turns back 65% of the pelvis twist (`animate` in `anim.ts`).

## Transitions

**Keep one clock through speed changes.** Walk, run and sprint share the stride clock, so a speed ramp never
jumps phase. The Characters page's Walk loop ↔ Run loop toggle transitions in place.

**Inertialize discrete flips.** Switching between forward and backpedal changes the leg heading's goal. The jump
goes into `m.yawOffset`, which decays at `transitionHz` (6 Hz), so heading and its velocity stay continuous
(Bollo, GDC 2018). The flip uses hysteresis: forward to back above 2.05 rad of aim error, back to forward below
1.72.

**Anticipate starts.** On leaving rest the pelvis dips (`a.dip.v −= 0.14`), the body leans into the acceleration,
and the first step comes from the foot on the side of any sideways motion (the left foot when moving straight). The
stride clock starts with that foot at its swing boundary.

**Catch stops with the lagging centre.** On a hard stop the foot centre overshoots ahead of the root, swing
targets keep updating until 96% of the swing, and the feet plant ahead. A hard stop settles in at most two catch
steps.

**Redirect late swings on reversal.** A foot between 60% and 95% of its swing when the travel direction reverses
restarts at 25% toward a new target once, so it never plants behind the reversal.

## Strafing

**Step out with the leading foot, then bring the other beside it.** On a strafe start or reversal the outside
foot steps first. The leading foot reaches 6% further and the following foot 32% shorter, so the inside foot steps
up beside the leading one instead of crossing it (Overgrowth's `HandleFootStance`). The leading boot opens toward
travel by up to 0.6 rad and the follower by 0.12 rad.

**Separate feet in aim space, with a smooth weight.** Feet keep at least 0.20 m apart sideways in aim space,
weighted by `smooth((strafe − 0.05) / 0.20)`. A binary `strafe > 0.2` gate teleported a foot 0.56 m in one frame
when it switched. Aim space stays stable while the pelvis turns during reversals.

Strafe swings are 14% shorter. Backpedal strides are 15% shorter with 12% longer swings.

## Profiles

Presets live in `humanProfiles`. Spread one to tune an actor; never mutate the preset.

| Profile | Character | Notable values |
| --- | --- | --- |
| Soldier | default; crouch-run with rifle | `runPosture 0.34`, `crouchDepth 0.08`, `leanScale 1.25`, `headStability 0.8` |
| Survivor | soldier profile with `unarmed = true` | FK arm swing, upright walk, 32% of the run posture |
| Wizard | upright, narrow, staff in hand | `strideScale 0.85`, `runPosture 0.12`, `bobScale 0.7`, `handPose "staff"` |
| Zombie | uneven and dragging | `timingBias 0.28`, `footDrag 0.9` (right foot), `hipDrop 0.13`, `headStability 0.2`, `handPose "reach"` |

`timingBias` shifts one foot's phase and swing length; `footDrag` shortens and flattens only the right foot's
swing and adds a limp to the pelvis. Tests bound both and keep the toe locks exact.

## Weapons

**Anchor the gun to a stabilised shoulder frame.** `build` in `anim.ts` builds a steady pelvis and torso from the
root, crouch, lean and dip, leaving out hip sway, pelvic drop, spine twist and most of the bob. The gun springs
toward a point off that frame's shoulder, and root translation and aim change are added to the spring 1:1 before
it steps. The first version chased a world-space point at 6 Hz, lagged 18 to 34 cm behind a running soldier and
vibrated at 30 Hz under 30-in-60 Hz stepping. Now the rifle sits about 0.26 m ahead of the crouched shoulders
with no velocity lag.

Rifle, shotgun and sniper scale the spring frequency (`*Ergonomics`). Recoil holds for 1 to 3 ticks before
recovering. Reload, gear and melee clips own the hands while they play.

## Determinism and performance

- Animation is presentation only. It has no simulation or wire fields, and the server owns movement, health and
  hits. A hidden limb changes nothing in gameplay.
- Step at a fixed `1/60` s for measurement; `locomotion` caps `dt` at 0.05 s and survives spikes and 30-in-60 Hz
  stepping. Seeded recoil and hit impulses replay exactly.
- `games/blackout/scripts/prove-human-parity.ts` hashes 900 soldier frames per mode. A motion change must update
  the hash on purpose, with the reason beside it.
- The death pose copies the last two posed frames into Verlet with per-joint velocities (capped at 15 m/s per
  axis), so a ragdoll starts exactly where the body was.
- CPU and GPU cost of the rig have not been measured.

## Tuning in the Lab

Every profile value has a labelled control with units in the shared Lab (Backquote → Animation, and on the
Characters page). Blackout also keeps an Old/New switch: Old is the gait before the shared rig, kept for side-by-side
comparison. Presentation settings never touch simulation or network state.

## Known gaps

- **Leg angles do not match mocap.** Walk RMSE: hip 5°, knee 16°, ankle 19°. Run: hip 15°, knee 34°, ankle 29°.
  Outbreak's survivor is worse at the ankle (37° walk, 50° run). Arms are fixed; legs are next.
- **The walk steps fast and short:** 157 steps/min with 0.54 m steps, against about 110 steps/min in the mocap
  walk at a similar speed.
- **The walk's bob peaks late.** Our pelvis is highest about 0.39 of a cycle after left heel strike; the mocap
  walk peaks at 0.27, near Passing, as an inverted pendulum should. The run's timing is close.
- **Outbreak's survivor and zombies have their own stride clocks** (`Survivor.draw`, `src/zombies.ts`). They use
  the shared IK, arms and profiles but not `locomotion`. The survivor walks at 204 steps/min and runs at 310, with
  contact foot speeds of 0.14 and 0.50 m/s.
- **The shared contact solver assumes a flat floor at Y = 0.** Outbreak adds terrain support itself.
- **Continuous playback has not been reviewed** for most passes; evidence is sampled sheets and metrics.
  Headless Chrome cannot hold 60 fps, so recorded video stutters even when the motion is smooth.

## Sources

- Richard Williams, *The Animator's Survival Kit*: Contact, Down, Passing, Up (used as a reference cycle in
  `buildWilliamsReferenceCycle`).
- Kit's biped walk rules and the Lamplight walker, `lamplight/docs/procedural-animation.md`: pelvis within
  1.05 rad of aim, feet within 0.96 rad of the pelvis, pelvis between the feet, lead foot opens on sidesteps,
  relaxed swing foot, lean about the head with a lagging foot centre.
- David Rosen, *An Indie Approach to Procedural Animation* (GDC 2014), and the Overgrowth source
  (`aschar.as`, `HandleFootStance`, `HandleAccelTilt`).
- Alexander Bereznyak, *IK Rig* (GDC 2016): release or replant before an effector leaves its chain.
- Rune Skovbo Johansen's thesis (2009) and Valve's *The Right Foot in the Wrong Place* (SIGGRAPH 2021):
  symmetric footprint prediction and a footbase that keeps the sole above ground before IK.
- David Bollo (GDC 2018) and Daniel Holden: inertialization.
- Measurement notes: `~/code/home/artifacts/2026-10-14-procedural-locomotion-research.md` (stress scenarios and
  root causes), `2026-10-14-walk-audit/` and `2026-10-14-pose-diff/` (before and after data and sheets).
