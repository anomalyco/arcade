# Animation

## Walkers physical human (Oct 20, learning incomplete)

`games/walkers/shared/human.ts` is a separate sagittal rigid-body learning prototype, not the shared 3D animation
rig below. Winter mass fractions, human joint ranges, bounded PD muscles and loaded-contact realism rules constrain
it. An authored leg-cycle prior failed (800 generations); direct PD learning without survival shaping then learned
to collapse early. Neutral initialization, a bounded balance reflex and a stage-zero survival reward learned to
stand for30 seconds. Three six-worker Pro runs took24m16s actual training.

The shipped balance policy: .056m drift, .9994 stance duty, .000773m/s contact slip, zero footfalls or illegal
contacts. Cadence, stride and mechanical cost of transport are **undefined**, not a successful gait. Walking and the
heist are not learned. `games/walkers/scripts/human-metrics.ts` measures loaded contacts and absolute joint work;
it does not infer success from the controller clock or claim mocap agreement. A walking fine-tune removes survival
shaping and uses an8s horizon; two attempts could not get Pro capacity. Preserve this limitation when presenting it.

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
means the walk and run reference clips that `common.ts` downloads on first use.

## Code map

| File | What it owns |
| --- | --- |
| `packages/kit/human-locomotion.ts` | `gaitAt` (stride, duty, run blend), `locomotion` (stride clock, step release, swing, pelvis springs, arm springs), `stanceFootRoll`, `plantedFoot` (ball lock and heel-to-toe roll), `plantedToe`, `pelvisPoint` |
| `packages/kit/human-pose.ts` | `poseLegs` (leg IK, swing ankle and toe bend), `unarmedHands` (FK arm angles), `poseUnarmedArms` (arm IK pole), `poseArms` (armed hands) |
| `packages/kit/human-profile.ts` | `humanProfiles` presets and their Lab controls (`zombieVariant`) |
| `packages/kit/shamble-crouch.ts` | `buildShambleReferenceCycle`, `buildCrouchRunReferenceCycle`, `extractAsymmetricBvhCycle`, `shambleHandsFK`, `shambleTorsoModulation`, zombie variants (`limper`, `dragger`, `reacher`, `lunger`) |
| `packages/kit/rig.ts` | `RIG` link lengths (`thigh`, `shin`, `ankle`, `foot`, `toe`, `heel`), `ik`, frames and springs |
| `packages/kit/avatar/anim.ts` | `animate`/`build`: pelvis pitch, torso and head, weapon frame, action clips (Blackout and Brawl; Blackout's `src/game/anim.ts` re-exports it) |
| `packages/kit/avatar/hit-reaction.ts`, `bone-ragdoll.ts` | Directional hit-reaction springs and the 15-bone Verlet ragdoll for any figure posed as `boneIds` frames (Outbreak zombies via `src/impact/`) |
| `games/outbreak/src/survivor.ts`, `zombies.ts` | Terrain adapters with their own stride clocks and split boot/toe meshes |

The leg is `RIG.thigh + RIG.shin = 0.42 + 0.41 = 0.83 m`, and the foot splits at the ball (MTP joint) into `RIG.foot = 0.125 m` (ankle to ball) and `RIG.toe = 0.065 m` (ball to toe tip, `0.19 m` total forward reach, `RIG.heel = 0.06 m`). Hip height is about 0.86 m.

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
| Walk | 1.4 m/s | 127 steps/min | 0.665 m | 0.54 | 8% of the cycle | 0 |
| Run | 4.2 m/s | 238 steps/min | 1.06 m | 0.32 | 0 | 36% |
| Sprint | 6.3 m/s | 285 steps/min | 1.33 m | 0.24 | 0 | 52% |

Before the ball-of-foot (MTP) toe joint, a rigid `0.19 m` boot could not bend at the forefoot, so `145 steps/min`
(`0.580 m` steps, `1.16 m` stride) was the longest walk stride a `0.83 m` two-bone leg at `pelvis.y = 0.819 m` could
reach (`maxChord = 0.816 m < 0.829 m`) without separating the shin from the ankle. Splitting the boot at the ball
(`RIG.foot = 0.125 m`, `RIG.toe = 0.065 m`) lets the trailing ankle lift up and forward by `L_foot (1 - cos φ)` (`+3.5 cm`
vertical, `+1.5 cm` horizontal at `φ = −0.46 rad`) while the toe stays planted flat on the floor. That extends effective
terminal-stance leg reach and lengthens 1.4 m/s walking steps from `0.580 m` (`144.6 steps/min`) to **`0.665 m`**
(**`126.6 steps/min`**, Outbreak `127.2 steps/min`, vs. `112.5 steps/min` in mocap) without dropping the pelvis (`pelvis.y = 0.819 m`)
and with `0.00 mm` shin-to-ankle separation. Touchdown jerk in the walk also dropped from `51` to **`33 m/s³`** (`contactFootSpeedMax = 0.032 m/s`).

**Run with flight; do not crouch to reach.** A running foot releases its support once the other foot's swing
is 32% complete (up to 48% on side-steps), which gives the flight fractions above. Swings last 0.08 to 0.385 s.
Crouching the hips to reach a distant lock looked worse and still overstretched the leg.

## Body bob

**Build the vertical bob as one smooth curve sampled from phase, with inverted-pendulum phase in walk and flight
phase in run.** `locomotion` drives `m.bob` with a single harmonic at twice the stride frequency and compensates the
spring's gain and lag. In walk (`run = 0`), `bobLead` adds a `+0.98 rad` inverted-pendulum advance so the pelvis is
lowest right after heel strike (`Down` during double support when the feet are furthest apart, giving extra leg-reach
headroom!) and peaks at **0.275 of the cycle** (`Passing` mid-stance when the stance foot is directly under the hip,
matching the mocap walk's **0.270**). In run (`run = 1`), the peak shifts to **0.37** during airborne flight.
Peak-to-peak pelvis travel is 4.1 cm walking, 5.9 cm running and 4.5 cm sprinting; the mocap walk travels 4.0 cm.

**Do not add touchdown impulses.** A dip kicked on touchdown produced jerk spikes of 280 m/s³ in the walk and
630 m/s³ in the run. The smooth curve cut them to **51** and **441**. `packages/kit/human.test.ts` caps touchdown jerk at
95, 540 and 880 m/s³ for walk, run and sprint.

**Keep one amplitude across the walk-to-run blend.** An earlier version blended a walk bounce (`+cos 2θ`) with a
run bounce (`−cos 2θ`), and the two cancelled to zero at `run = 0.5`. The current curve has one phase and an
amplitude that grows with `run`.

**Check the subharmonic.** Energy at half the step frequency means left and right steps differ. The walk's
subharmonic ratio fell from 0.92 to 0.03 once the stride clock was shared.

**Keep the pelvis between the feet and near the aim.** The pelvis yaw springs toward the circular midpoint of
the two foot headings and never leaves 1.05 rad of the aim; the leg heading obeys the speed-dependent strafe limit
in [Strafing](#strafing).

Side-to-side, the pelvis shifts toward the stance foot (`m.sway`), drops on the swing side by `hipDrop`
(0.095 rad for the soldier), banks into turns from lateral acceleration (up to 0.18 rad), and twists with the
feet's forward offset. These are the classic determinants of gait (Inman 1981). Pelvis sway and drop are
amplified 1.6× (`swayScale`, `twistScale`) because the games are seen from above.

## Foot contact

**Lock the ball of the foot in world space, and keep the planted toe flat on the floor.** `lockToe` pins the ball of
the foot `RIG.foot = 0.125 m` ahead of the ankle (`a.motion.toes[i]`), and `plantedFoot` pivots the rear foot around
that ball during terminal stance while `plantedToe` (`left.toe` / `right.toe`, `RIG.toe = 0.065 m`) stays flat on the
floor (`toeRelPitch = −footPitch`, reaching `+32.7°` dorsiflexion in walk and `+44.2°` in run). A clamped IK endpoint
can move the mesh while the stored lock reports zero slip, so measure both the rendered ball (`at(ft, RIG.foot, -RIG.ankle, 0)`)
and the rendered toe tip (`at(toe, RIG.toe, -RIG.ankle, 0)`). Planted ball and toe slip are `0.0 mm` (`< 1e-12 m`) across
walk, run, sprint, crouch-run and zombie shamble.

**Touch down at zero speed.** Horizontal swing motion uses `smoother(u)`, which has zero velocity at both ends, and
the lift is `1.72 sin²(πu)(1 − u)`: it rises early (peak at about 42% of the swing) and settles cubically.
Contact foot speed fell from 0.63 to 0.03 m/s in the run (`0.010 m/s` mean / `0.032 m/s` max in the walk). Walk lift
peaks near 12 cm and run lift near 39 cm.

**Roll heel-strike → foot-flat → heel-rise → toe-off.** `stanceFootRoll` (`packages/kit/human-locomotion.ts`) splits
stance into two pitches so early-stance heel rocker never displaces the ankle horizontally:
- **Heel strike → foot flat (`stanceFrac < 0.24` walk, `< 0.16` run):** `heelStrikePitch` holds `+0.17 rad` (`+10°`)
  dorsiflexion at touchdown and settles smoothly to `0` as weight loads onto the foot, with a slight `+0.06 rad` toe
  dorsiflexion lift.
- **Mid-stance (`foot flat`):** both `ft` (`heel → ball`) and `toe` (`ball → tip`) lie flat on the floor (`0 rad`).
- **Heel rise → toe-off (`stanceFrac > 0.50` walk, `> 0.36` run):** `heelRisePitch` pitches the rear foot nose-down up
  to `−0.46 rad` (walk) or `−0.62 rad` (run/sprint) around the locked ball (`lockToe`), lifting the heel `3.5–5.5 cm`
  while `plantedToe` counter-rotates (`toeRelPitch = −heelRisePitch`) so the toe box stays flat on the ground.
- **Swing push-off and toe clearance (`poseLegs`):** at liftoff (`u < 0.25`), the ball pivot and push-off plantarflexion
  fade out smoothly while the toe flexes down (`−0.20 rad`), then lifts slightly (`+0.12..+0.18 rad` dorsiflexion) in
  mid-to-late swing so the `6.5 cm` toe tip clears the floor before settling into heel strike. In zombie shamble
  (`footDrag > 0.2`), the dragged foot's toe flexes upward as it scrapes along the ground so the toe tip never digs
  underground.

**Turn feet in place.** A planted boot stays within 0.96 rad of the leg heading and pivots at its toe when it
exceeds that. Idle feet replant when their home error passes 0.24 m.

**Sounds land on touchdown.** `Survivor.onFootfall` and `ZombieCrowdRenderer.onFootfall` fire on the frame a foot
plants (the zombie hook also passes that foot's drag and the shamble variant), and Outbreak's footsteps play there
([sfx-library.md](sfx-library.md#outbreak)). A change to when feet plant moves the sounds with them.

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

**Point the knee over the boot.** `kneePole(pelvis, footYaw, side)` in `human-pose.ts` aims the knee pole along
the boot's heading with a small outward bias (`KNEE_OUT = 0.12`), so the knee tracks over the toes when the feet
turn away from the hips. The old pole was fixed in pelvis space (`dirIn(pelvis, 1, 0.28, ±0.25)`), which bowed the
knees 14° to 24° off the boots (21° in crouch-run, 23° to 24° in Outbreak, 4° to 7° in mocap); now the worst case
across all strafe angles is 7.5° to 9°. The price is crouch-run leg RMSE 10.7° → 11.2° and +0.1° to +0.3° leg RMSE
in the forward walk and run pose-diffs.

**Keep the knee pole orthogonal to the swing chord.** During running swing heel kick-up (`cx < 0`, when the ankle kicks up behind the hip), the chord points
backward and downward at `~−135°`, which is nearly anti-parallel to `(1, +0.28)`. `poseLegs` tilts the swing pole
downward (`0.28 − 0.65 × backKick`) and narrows its lateral offset so the pole stays orthogonal to the backward
hip-to-ankle chord and never bows the knee sideways.

**Fold the heel up behind the hip and tuck it horizontally in running swing.** Interpolating the swing foot along a
symmetric horizontal `smoother(u)` path with a low 19 cm bell pushed the ankle forward too early in mid-swing and
unbent the knee to 71° at `6/8` and 5.5° at `7/8` (mocap: 127° and 68.5°). `poseLegs` adds a running heel kick-up
bell (`+22 cm` at `u ≈ 0.56`, raising total swing ankle lift from 19.5 cm to **38.9 cm** vs. mocap's 44.5 cm) and a
horizontal heel-tuck lag (`−24 cm` at `u ≈ 0.65`) that tapers to zero before `u = 0.92`. Keeping the ankle tucked
under the hip during mid-to-late swing lets two-bone IK flex the knee to **119°** (sprint **122°**) while driving the
thigh high in front (`+62°`), then whip the lower leg down to a zero-velocity touchdown.

**Measure and drive swing ankle pitch relative to the shin.** `poseLegs` computes unwrapped sagittal shin pitch from
`sh0.y` (`-atan2(shinFwd, sh0.y[1])`, avoiding `±90°` folding when the shin tilts past horizontal during heel kick-up)
and applies plantarflexion (`−0.20..−0.35 rad`) during push-off and early swing followed by dorsiflexed recovery in
late swing. Combined with the ball-of-foot (MTP) toe joint (`RIG.foot = 0.125 m`, `RIG.toe = 0.065 m`), `stanceFootRoll`
heel-to-toe roll, and `0.665 m` walking steps (`126.6 steps/min`), leg angle RMSE against mocap dropped to **`8.07°`**
in the walk (hip `6.15° → 4.48°`, knee `12.69° → 10.94°`, ankle `14.33° → 8.78°`), **`12.96°`** in the run (hip `12.2° → 11.09°`,
knee `20.9° → 18.32°`, ankle `14.1° → 9.48°`), **`18.76°`** in the sprint (ankle `19.48° → 13.96°`), and in Outbreak to
**`10.72°`** in the walk (hip `8.44° → 6.66°`, ankle `15.49° → 8.93°`) and **`13.15°`** in the run (hip `10.89° → 9.76°`,
knee `17.90° → 15.95°`, ankle `16.72° → 13.72°`).

**Sample per-step variation once at liftoff with same-foot high-pass blue noise.** `stepVariation` (`0..1`, default
`0.35` on soldier, `0.30` on wizard, `0.65` on zombie, exposed in the shared Lab) samples deterministic seeded offsets
(`stepHash(seed, stepCount, ch)`) once when a foot lifts off (`m.stepReach`, `m.stepLat`, `m.stepLiftVar`,
`m.stepToeYaw`, `m.stepArmVar`), never per frame. Stride reach uses same-foot high-pass filtering (`0.65 h(n) − 0.55 h(n − 2)`,
where `n − 2` is the previous step of the *same* foot rather than the opposite foot `n − 1`) so each foot's mean
telescopes to zero (`L/R step duration ratio = 1.000–1.007` across 20 steps, stride range `2.5–2.7%`, lift
`38.9 ± 1.25 cm`, lateral placement `±0.37 cm`, toe-out `±0.80°`, planted toe slip `< 1.5e-14 m`). Per-actor stride and
phase traits (`actorSeed`) spread a 5-actor crowd by `17°–31°` so groups of survivors or zombies do not march in
lockstep.

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

**Crouch-run is a profile choice; attenuate swing heel-kick with crouch depth.** The soldier's `runPosture` (0.34 rad)
and `crouchDepth` (0.08 m) ramp in with run speed. Measured at run and sprint speed, the pelvis lowers about 14.5 and
17.2 cm, the knees bend about 71° (53° walking), the pelvis pitches 12.6° and 15.7° and the chest 29° and 39°. Unarmed
civilians keep 32% of the posture and 25% of the crouch by default (chest pitch 10° to 18°), or 100% when crouch-run is
selected (`Pose = Crouch-run` or `crouchDepth > 0.085`). Because a crouched pelvis is already 8 to 14.5 cm closer to the
floor, adding full upright-run heel kick-up (22 cm) in `poseLegs` lifted the ankle 39.4 cm and jackknifed the swing
thigh into the chest (80° hip flexion, 139° knee flexion). Scaling swing lift and heel-kick down with `m.crouch.x` and
compensating `unarmedHands` for the extra forward torso pitch brought crouch-run overall angle RMSE against
`buildCrouchRunReferenceCycle` from 9.5° to 6.0° (leg RMSE 11.8° to 5.5°, soldier leg RMSE 18.5° to 14.1°).

**Outbreak's sneak crouch (Z) is a separate spring, zero unless held.** `Survivor.stealth` in
`games/outbreak/src/survivor.ts` springs to 1 while `crouching` (k 260, critically damped) and adds a 0.3 m hip drop,
0.28 rad pelvis pitch and 0.34 rad chest lean on top of the profile's crouch-run terms; the sim halves move speed. At
0 every added term is `+ 0`, so standing, walking and running poses are unchanged. The low pose has not been measured
against mocap yet (still: `crouch` in `captures/outbreak-discovery/`).

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

**Make the backpedal flip continuous, then inertialize what is left.** Switching between forward and backpedal
changes the leg heading's goal. `strafeLegGoal` tapers both goals to zero around the switch (forward from 1.8 rad
of aim error, backpedal within 0.45 rad of its limit), so at the flip both legs already face the aim and the goal
barely moves. Any residue goes into `m.yawOffset`, which decays at `transitionHz` (6 Hz), so heading and its
velocity stay continuous (Bollo, GDC 2018). The flip uses hysteresis: forward to back above `BACK_ENTER = 2.35` rad
of aim error, back to forward below `BACK_EXIT = 2.1`. Outbreak's survivor used to flip instantly: its pelvis turned
at 1116°/s in an aim sweep; with the shared goal it peaks at 169°/s walking and 236°/s running.

**Anticipate starts.** On leaving rest the pelvis dips (`a.dip.v −= 0.14`), the body leans into the acceleration,
and the first step comes from the foot on the side of any sideways motion (the left foot when moving straight). The
stride clock starts with that foot at its swing boundary.

**Catch stops with the lagging centre.** On a hard stop the foot centre overshoots ahead of the root, swing
targets keep updating until 96% of the swing, and the feet plant ahead. A hard stop settles in at most two catch
steps.

**Redirect late swings on reversal.** A foot between 60% and 95% of its swing when the travel direction reverses
restarts at 25% toward a new target once, so it never plants behind the reversal. The restart rewrites `f.lift`
so the foot continues from where it is; restarting from the old lift point jumped it a quarter of the way to the
new target in one frame.

## Strafing

Strafing means travelling one way while the chest faces the aim. Measure it with
`games/blackout/scripts/animation/strafe.ts`, which sweeps travel 0° to 180° from aim at slow (0.8), walk (1.4),
jog and run (4.2 m/s) for the survivor, soldier and Outbreak's aimed survivor, plus aim sweeps and a circle strafe,
and compares them with mocap and authored references. Game strafes are fast (Blackout moves at 4.2 m/s, Outbreak at
3.4), so the run regime matters most.

**Turn the hips toward travel with speed; keep the chest on aim.** `strafeHipLimit` lets the leg heading turn
`sideStepTurn` (0.3 rad) from the aim at a stroll, rising to `strafeHipTurn` (0.95 rad) by 2 m/s. The old fixed
26° limit at a 90° strafe pointed the legs almost across the travel line, and the trailing leg could not keep up: a
run strafe took 369 steps/min against 239 running forward, with double catch steps. Now the hips sit 55° from aim
in a run strafe, the cadence matches forward running (239), steps run along travel (direction error 1.9° → 0.2°)
and the chest stays within 1° of aim.

**Side-step slowly, never cross.** Below `crossoverSpeed` (2.6 m/s) a sideways step widens the stance in the leg
frame to `(strafeGap + stepLength × |sin φ|) / 2`, so the follower closes to `strafeGap` (0.20 m) from the lead
and never passes it (`strafeFootOffset`; φ is travel relative to the legs, folded to ±90°). Side-step strides are
up to 45% shorter (`gaitAt(…, sideStep)`) so the open stance stays within reach. The lead boot opens toward travel by
`0.35 |φ|`, the follower by `0.08 |φ|` (`strafeFootOpen`). Mocap and the authored side-step agree: no crossing,
feet within 20 to 30 cm of each other at the closest.

**Cross over at a run.** Above about 1.9 m/s `cross` ramps in: each foot lands 10 cm off its side of the travel
line, so the trailing leg passes in front of the other, as in the authored crossover run. The boots split the
difference between hips and travel (`0.6 φ`). A crossover needs a travel line ahead of or behind the hips, so it
fades back to a side-step as travel nears 90° from the legs (`smooth(|cos|/0.7)`); otherwise the fold at ±90°,
where φ changes sign, swapped the feet across the line.

**Separate on the target, never per frame.** `strafeSeparate` pushes a landing target apart by `strafeGap` across
the legs for a side-step or 18 cm across the travel line for a crossover. Separating the moving foot every frame
fought the swing interpolation and made the feet jitter.

**Give both feet the same reach.** The old rule (lead foot 6% further, follower 32% shorter, after Overgrowth's
`HandleFootStance`) starved the follower at speed and was the main cause of the catch steps. With the hips turned
toward travel both feet step symmetrically.

**Backpedal blends in.** `backness` (0 to 1, from how far travel points behind the legs) shortens strides by up to
15%, lengthens swings by up to 12% and swaps heel strike for a small toe-down landing. The mocap backpedal lands
toe-first, about 30° toe-down, and rolls the heel down within 0.13 s; foot roll itself lives in `plantedFoot`.

Measured on main with the toe joints (before) and this pass (after):

| Case | Before | After | Reference |
| --- | --- | --- | --- |
| Run 90° cadence | 369 steps/min | 239 | 238 (authored crossover), 239 forward |
| Walk 90° cadence | 221 | 215 | 240 (authored side-step at 0.8 m/s), 127 forward |
| Walk 90° closest boot gap | 21 cm | 26 cm | 20 to 28 cm |
| Knee vs boot, worst angle (survivor / Outbreak run) | 22° / 24° | 8° / 8° | 4° to 7° (mocap) |
| Aim sweep, max pelvis turn (Blackout run / Outbreak walk) | 284 / 1116 °/s | 242 / 169 °/s | |
| Circle strafe, r = 3 m (walk / jog), step direction error | 23° / 32° | 6° / 12° | |
| Circle strafe (jog), cadence | 360 steps/min | 235 | 222 forward |

Planted slip stays at 0 and survivor-aim muzzle error at 0° in every case.

### WASD legs (Outbreak survivor, AR-95)

Kit after the co-op playtest: "better animation for those damn legs, especially strafing". Outbreak moves at an
instant 8-way 3.4 m/s (sprint 5.6, crouch 1.7) with the aim free, so the legs see snap reversals, flicks and slow
mouse turns that the steady sweeps above never do. Measure them with
`games/blackout/scripts/animation/survivor-legs.ts` (23 scripted WASD + mouse segments through the real `Survivor`,
or `--actor soldier|blackout-survivor` through Blackout's adapter; `--baseline <checkout>` adds a `before` pass,
`--video` a game-camera side-by-side). It reports per segment ground skate (ball travel while within 1.5 cm of the
floor), leg overstretch (shin end to boot gap), shin and boot intersections, knee pop, hip and chest twist, cadence
and step direction, with the time of the worst overstretch and closest shins.

**One contact solver.** The Outbreak survivor now runs `locomotion` + `poseLegs` like Blackout (Lab › Survivor
strafe › Legs: Shared rig, or Today for the old stride clock). Terrain is added per foot after posing on a flat
floor. Its own clock skated 58 to 64 cm per contact in a crouch, and an A/D reversal pulled a leg 98 cm off its boot.

**Rules learned:**

- **Side-steps keep the hips square, runs turn them.** 100STYLE side-walks (0.57 m/s) keep the pelvis within 5° of
  the chest and never cross, opening to about 52 cm. `sideStepTurn` is 0.2 rad (was 0.3) and the hip limit ramps over
  1.2 to 2.8 m/s; at 3.4 m/s the hips still turn 55° (`strafeHipTurn` 0.95). At 0.12 rad (and at
  `strafeHipTurn` 0.75) a run reversal scissors the feet across each other in the leg frame: shins touched in 11% of
  reversal frames. `strafeSettle` (seconds of steady travel before the hips commit) exists but defaults to 0: holding
  the hips square through quick A/D taps cost shin hits and saved almost no hip motion.
- **Cap the side-step opening** at 28 cm per foot and redirect a reversing swing from `u ≥ 0.45`; keep tracking the
  target to `u < 0.9` while reversing and ease late corrections when a landing would be out of reach.
- **Step the foot that is out of reach of its hip.** `hipReach` compares the planted boot with its hip at the current
  pelvis height (heel rise buys a foot length behind). With both feet down the farther foot steps first whatever the
  phase says; in flight only a sideways reach past a straight leg counts, so ordinary sprint strides keep their length.
- **Never aim a landing beyond reach** (0.46 m from where the body will be, plus 6 cm per m/s over 3.4), which caught
  the backpedal-to-forward flip in an aim sweep throwing the stride target 77 cm past the hip.
- **Pin the ball at toe-off.** The swing ankle was placed for the toe-off pitch but the boot relaxed to another, so the
  ball slid back about 11 cm along the floor; the ankle is now re-anchored to the pitch the boot takes.
- **Toe-first swings clear the floor.** Backward, sideways and on-the-spot swings keep the ball and toe 3 cm up until
  the last fifth of swing (forward swings 1.5 cm late in swing only); before, a back-diagonal toe dragged 22 cm.
- **Lift off from where the boot pivoted.** A planted boot turns with the hips on its locked ball while its contact
  point stays put; at lift-off the swing starts from the ankle point that pivot left (a standing flick jumped the
  boot 13 to 21 cm).
  On-the-spot steps lift the boot nearly flat (`relaxed` × 0.3 at gait 0) and rise at once.
- **`turnStep`** (0.8 rad, was a hard-coded 1.05) is the aim twist that makes a standing body step round.

Outbreak survivor, pistol raised, whole sequence (Today → shared rig):

| Metric | Today | Now |
| --- | --- | --- |
| Ground skate, worst contact | 64.4 cm | 5.7 cm |
| Leg overstretch, worst frame | 98.2 cm | 13.7 cm |
| Shins within 12 cm | 2.0% of frames | 1.2% |
| Knee pop, worst | 2439 °/s | 1556 °/s |
| Turn 360 / flick 180 skate | 47.5 / 21.8 cm | 0.4 / 2.3 cm |
| Crouch forward / strafe skate | 58 / 64 cm | 0 / 0 cm |
| R↔L reversals overstretch | 98.2 cm | 10.1 cm |

Blackout soldier on the same sequence: skate 21.7 → 8.5 cm, overstretch 17.2 → 11.5 cm, shins within 12 cm 1.2% →
1.0%, knee pop 1806 → 1257 °/s. Pose-diff walk leg RMSE 8.2° → 10.0° (survivor, the toe-off ball pin costs about 2°
of knee), run 13.1° → 12.8°; Outbreak walk 11.0° → 11.4° and run 13.2° → 13.3° now through the shared rig. Step
variation and L/R symmetry unchanged. strafe.ts at 1.4 m/s sideways: hips 49° → 30° from aim, cadence 215 → 257.

## Profiles

Presets live in `humanProfiles`. Spread one to tune an actor; never mutate the preset.

| Profile | Character | Notable values |
| --- | --- | --- |
| Soldier | default; crouch-run with rifle | `runPosture 0.34`, `crouchDepth 0.08`, `leanScale 1.25`, `headStability 0.8` |
| Survivor | soldier profile with `unarmed = true` | FK arm swing, upright walk, 32% of the run posture |
| Wizard | upright, narrow, staff in hand | `strideScale 0.85`, `runPosture 0.12`, `bobScale 0.7`, `handPose "staff"` |
| Zombie | uneven, lurching and dragging | `timingBias 0.28`, `footDrag 0.9`, `hipDrop 0.13`, `headStability 0.2`, `handPose "reach"`, `zombieVariant` (`auto`, `limper`, `dragger`, `reacher`, `lunger`) |

`timingBias` shifts one foot's phase and swing length; `footDrag` shortens and flattens the crippled foot's
swing, slows cadence (`157 -> 118 steps/min` at `0.95 m/s`, matching tired/injured mocap at `100-110 steps/min`),
and adds a limp to the pelvis. Tests bound both and keep the toe locks exact (`0.000 mm` slip).

Every profile shares the strafe values `sideStepTurn 0.2`, `strafeHipTurn 0.95`, `crossoverSpeed 2.6`,
`strafeGap 0.2`, `strafeSettle 0` and `turnStep 0.8` (Lab → Animation; Outbreak's aimed survivor has the strafe keys
in its Survivor strafe group).

### Zombie shamble

- **Clamp swing foot pitch against the floor before lifting the ankle.** When `footDrag = 0.9`, the dragged ankle is only
  1 cm above the ground while the shin tilts backward (`-37°`). Pitching the boot nose-down to follow the shin pushed the
  0.19 m toe 11 cm underground, and `poseLegs`'s floor-clearance guard (`if (low < 0) ankle[1] -= low`) levitated the
  dragged ankle to 11.8 cm (`89.9°` knee bend), erasing the drag. Clamping nose-down `footPitch` by the ankle's floor
  clearance (`-asin((ankleY - RIG.ankle) / 0.19)`) lets the toe scrape along the floor and cut dragged-foot lift from
  11.84 cm to 3.61 cm in Blackout (2.91 cm vs 11.02 cm good foot in Outbreak).
- **Drive reaching/hanging zombie arms by FK angles in horizontal heading space (`shambleHandsFK`).** Static
  `profileHands` targets solved with the rifle's `poseArms` held zombie arms frozen (`0.01°` swing in Outbreak, `3-4°`
  in Blackout) with asymmetric rifle elbow poles. `shambleHandsFK` + `poseUnarmedArms` drives asymmetric reaching and
  hanging waves in yaw-aligned horizontal space (so torso pitch/roll never shifts world shoulder flexion), cutting zombie
  arm angle RMSE against `buildShambleReferenceCycle` from 24.8° to 4.0° in Outbreak (overall RMSE 20.2° to 6.5°; against
  `walk_tired_001.bvh` mocap from 27.0° to 16.8°) and from 25.7° to 6.6° in Blackout (overall RMSE 22.0° to 9.5°).
- **Readability from top-down comes from stumble-and-catch torso lurch, shoulder cant, head lolling and variants.**
  Vertical bob is foreshortened from a 60° camera. `shambleTorsoModulation` adds a cyclic forward catch pitch (`Δ8.5°`),
  coronal shoulder cant (`Δ12.2°` to `15.0°`), shoulder twist and phase-lagged head lolling (attached at the neck),
  driven by `gait` (`1.0` at `0.95 m/s` rather than `speed / 4.2 = 0.22`). Seeded crowd zombies resolve across four
  variants (`limper`, `dragger`, `reacher`, `lunger`) and left/right crippled sides (`resolveDragFoot`) so a 100-zombie
  horde never moves in lockstep (100-zombie `bench-outbreak`: street p95 `18.6 ms`, interior p95 `19.6 ms`, realtime
  ratio `0.996` / `0.999`, CPU prep `1.0 ms` / `0.6 ms`).
- **Habits and reactions are standing overlays, not gait (AR-88, `src/zombies.ts`).** A zombie still on a habit site
  (knocking, stirring, over a bed, in a fence, slow-dancing) keeps the standing shamble and adds torso/head pitch and
  roll offsets plus hand goals given from the shoulder in the torso frame (forward, up, out), blended over the
  `shambleHandsFK` hands before the arm IK; heads turn and tilt toward a recent noise (a 0.12 s lag, fading over 2.5 s)
  and the near hand comes up for a 0.85 s torch flinch. Moving zombies are untouched: `reference-clips.ts` before and
  after gives the same Outbreak zombie numbers (vs 100STYLE Zombie 31.34°, Drag 23.32°, UAL Zombie 25.08°).
- **Per-zombie gait from the seed (`games/outbreak/src/behaviour/pose.ts`, AR-91).** Zombie behaviour's
  `BehaviourPoser` bends each zombie's shamble by its personality (`shared/behaviour/personality.ts`): cadence
  72–102 steps/min through a longer stride at the same speed, hunch around the 100STYLE zombie's ~9° trunk (the long
  dead hunch further, the fresh stand up), sideways lean, a seeded limp side, arms held out level, and feet that barely
  clear the ground on shufflers. Three things mattered against 100STYLE Zombie_FW at 0.79 m/s, measured with an average
  personality (`outbreakZombieAlive` in `reference-clips.ts`): the stride's foot-placement lead cap (`0.38 s`) had to
  scale with the stride, or the trailing foot ended 0.45 m behind the hips and the pelvis dipped 15 cm (knee 81°);
  hands had to aim outside the shoulders (`shoulderW + 0.05`), not inside; and the hunch had to be centred, because
  the shamble already pitches the trunk 17°. Result: overall **31.3° → 22.4°** (arm 41.5° → 24.0°, forearm pitch
  37.7° → ~13°, leg 17.8° → 20.2°), cadence **114 → 87** vs 86 steps/min, trunk 17° → 11.7° vs 9.2°, lift 10.7 → 8.6 vs
  7.3 cm. The arms-out pose moves further from the Quaternius clip (25.1° → 35.3°), whose arms hang. "Zombie behaviour:
  Today" or Walk from personality 0 draws the old shamble unchanged.

## Weapons

**Anchor the gun to a stabilised shoulder frame.** `build` in `anim.ts` builds a steady pelvis and torso from the
root, crouch, lean and dip, leaving out hip sway, pelvic drop, spine twist and most of the bob. The gun springs
toward a point off that frame's shoulder, and root translation and aim change are added to the spring 1:1 before
it steps. The first version chased a world-space point at 6 Hz, lagged 18 to 34 cm behind a running soldier and
vibrated at 30 Hz under 30-in-60 Hz stepping. Now the rifle sits about 0.26 m ahead of the crouched shoulders
with no velocity lag.

Rifle, shotgun and sniper scale the spring frequency (`*Ergonomics`). Recoil holds for 1 to 3 ticks before
recovering. Reload, gear and melee clips own the hands while they play.

**Carry equipped pistols in low ready and raise into a two-handed shoulder aim on fire.** Outbreak's survivor previously
ran `unarmedHands` whenever `profile` was `undefined` while `OutbreakCombatFX` glued a pistol box onto `right.hand`:
during firing, the arms kept swinging at the hips (`muzzleH = 67–74 cm`, `wristGap = 55.6–79.8 cm`, arm-to-aim error
`78.7°` walking and `87.5°` idle). `Survivor.draw` (`games/outbreak/src/survivor.ts`) now reuses the soldier's
stabilised shoulder weapon frame (`steadyPelvis`/`steadyTorso` without hip roll, spine twist, or 80% of vertical gait
bob, with 1:1 root displacement and `dAim` feed-forward into `gunPos` and `weaponYaw`) and `poseArms`:

- **Low ready (`aimWeight = 0`)**: when `equippedItem === "pistol"` and idle or moving without recent shots, the right
  hand holds the pistol ahead of the right ribcage (`fwd 0.28 m`, `up 1.13 m`, `side 0.165 m`, muzzle pitched `-27.5°`
  downward/forward) while the left arm guards or counter-swings with `unarmedHands` (low-ready walk arm RMSE `4.62°`).
- **Raise, two-handed aim, recoil and hold (`Survivor aim` Lab group)**: on fire (`fireCooldown` or snapshot `recoil`
  pulse), an underdamped spring (`ζ = 0.74`, `aimRaiseTime = 0.15 s` default) with an immediate upward launch impulse
  lifts the pistol with **0.0 mm anticipation dip** to 90% in `150 ms` and 95% in `167 ms` (`2.8%` settle) into a
  two-handed Weaver/isosceles grip at shoulder height (`fwd 0.375 m`, `up 1.35 m`, `side 0.045 m`, bladed chest
  `+13.5°` clamped to `±aimTwistLimit = 1.05 rad` relative to the lower-body heading). Muzzle-to-aim error is `0.00°`
  (`muzzleH = 136.0 cm` walk, `130.7 cm` run, `wristGap = 3.37 cm`, planted toe slip `< 3.6e-15 m`), cutting aimed arm
  angle RMSE from `64.08°` to `2.54°` in walk and from `46.83°` to `4.24°` in run. Each shot kicks `recPitch` (`+11.0°`
  peak at `33 ms`), `recBack` (`4.25 cm`), elbow flexion (`+9.6°` absorption) and `torsoKick` (`+1.8°`), recovering 90%
  in `100 ms`. The raised aim holds for `aimHoldTime` (`2.50 s` default, measured `2.53 s`) after the last shot before
  easing back to low ready over `0.40 s`.
- **Reload (`reloadRemaining > 0`)**: a keyframed `1.15 s` clip cants the pistol inward at chest height (`42.4°` roll),
  pitches the head down `16.0°`, reaches the left hand to the belt pouch (`1.68 cm` from `hipL`), carries a visible
  magazine box into the grip well (`3.22 cm`), racks the slide, and returns to the two-handed grip (also driven for
  co-op remote survivors from snapshot `reloading` and `recoil` state).
- **Top-down melee swings, downward finishers, and zombie knockdown/crawler/death states (`packages/kit/human-melee.ts`,
  `games/outbreak/src/survivor.ts`, `games/outbreak/src/zombies.ts`)**: `meleeTorsoModulation` and `poseMeleeArms` drive
  `windup` → `active` → `recovery` across `one-blunt` (`crowbar`, `pipe`, `hammer`), `one-blade` (`knife`, `machete`),
  and `two-heavy` (`bat`, `spiked-board`, `axe`, `fire-axe`) weapons while standing or walking (`crowbar` tip sweep
  `210.5°` 1L / `197.2°` 2L / `287.1°` 3H, torso twist `56.6°–101.5°`, `0.500 m` arm chord, `0.0e+0` planted toe slip).
  Contextual finishers on downed or crawling zombies either pitch the torso (`+0.38 rad`) and weapon (`-0.58 rad`) into
  a downward strike or lift and slam the right boot (`stompAnim`). Zombies pose deterministically across three stagger
  reactions (flinch back, spin-twist, knee-buckle), four death variants (fall forward, fall backward, spin crumple,
  collapse to knees), floor knockdown with recovery struggle, prone leg-severed `crawler` hauling (one-leg and
  torso-only via `BONE_SUBTREE_MASK`), and `limping` hip dip (`6.8 cm`).
- **Zombie strike lunge (`games/outbreak/src/zombie-strikes.ts`, `zombies.ts`)**: zombies had no attack pose, and the
  kit AI deals damage on the first frame a chaser is in reach, so a hit came from nowhere. `StrikeTracker` pairs each
  survivor's health drop with the nearest live zombie within `1.8 m` (as the sound director does, so co-op peers get
  it from snapshots) and `ZombieCrowdRenderer.strike(id)` plays a `0.42 s` lunge: a `70 ms` ease-out thrust, then a
  smoothstep return. The pelvis and hips move `12 cm` toward the target and drop `3 cm`, the torso pitches in
  `0.42 rad`, and the hand IK targets move `0.36 m` forward and `0.14 m` up (the lead hand fully, the other at 65%).
  Elbows end up `0.40 → 0.67 m` in front of the zombie (`tests/feel.test.ts`). The age advances with the hit-stopped
  draw `dt`, so the lunge freezes with the hit. Lab › Feel › Zombie strike lunge scales it (0 = off). It plays after the
  hit lands; a real wind-up would need the AI to delay damage (a difficulty change, not presentation).
- **Directional hit reactions (`packages/kit/avatar/hit-reaction.ts`, AR-90)**: the canned stagger picked one of three
  poses per zombie by seed, so a shot from behind rocked it the same way as one from the front, with a linear 0.35 s
  fade. `HitReactions` turns each blow (plan direction, rad/s strength, off-centre amount, head share, buckle) into
  seven underdamped springs layered on the procedural pose: trunk pitch and roll away from the blow (2.3 Hz, ζ 0.42, so
  it rocks back ~23% past rest before recovering), a shoulder twist when it lands off-centre, a head whip (3.6 Hz,
  ζ 0.34) and a knee buckle that drops the pelvis (2.1 Hz, ζ 0.62). Limits 0.62 rad trunk, 0.75 rad head, 0.2 m drop.
  Outbreak feeds it from replicated shots, swings, shoves, car hits and blasts (`src/impact/causes.ts`: a pistol round
  4.2 rad/s, a crowbar 6.2, a charged fire axe ~9) and keeps 35% of the canned pose for each zombie's own flavour
  (Lab › Physics › Canned stagger kept). With no reaction live the springs add exactly zero: the `reference-clips.ts`
  zombie cycles are byte-identical before and after.
- **Ragdoll deaths from the rig (`packages/kit/avatar/bone-ragdoll.ts`, AR-90)**: a Verlet ragdoll over the 15
  semantic bone frames (16 points: hips, shoulders, neck, crown, knees, ankles, balls, elbows, hands; a rigid
  hip-shoulder block, a neck that flops within 0.86–1.08 of its rest span, limbs at the `RIG` lengths, minimum spans
  that stop knees, elbows and feet folding flat). It binds each bone to its driver frame on the exact pose drawn on the
  frame of death, so the first ragdoll frame reproduces it (bind error < 1e-4 m), takes velocities from the previous
  frame (capped 7 m/s) plus the killing blow, and writes the same frames back for the figure's own renderer. Fixed
  1/120 s substeps (8 max per call), 6 passes, gravity 15 m/s², ground friction 0.955 kept per substep, sleeps after
  0.45 s still (7 s cap); a pistol kill settles in ~1.8 s, 0.46 m along the shot; a heavy axe 1.4 s, 1 m; a car at
  speed throws 3 m and tumbles. Seeded, no `Math.random`. Outbreak only starts one from a pose drawn last frame where
  the zombie now is; a death it never saw standing keeps the canned collapse.

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

## Reference clips

`games/blackout/scripts/animation/reference-clips.ts` pose-diffs our gaits against openly licensed clips at the
clip's own ground speed: 100STYLE mocap (CC BY 4.0; Neutral, Zombie, DragLeftLeg, Crouched and Swat walks) and
Quaternius UAL keyframed game clips (CC0; Walk, Jog, Sprint, Crouch walk, Zombie walk). `--bake` writes 32-sample
cycles to `games/blackout/src/dev/reference-clips.json` for the Characters page's **Reference** Lab group, which
walks a grey ghost of the chosen clip beside the selected actor (phase from the actor's travelled distance, off by
default). The strafe clips (100STYLE Neutral side-step walk and run, backward walk; `facing: "aim"`) are cut at two
lead-foot peaks along their own travel line and kept in the hips' frame, so their ghost faces the actor's aim; the
Characters station pairs them with the slow side-step, the run strafe and the strafe sweep. Never add Mixamo or Bandai Namco data there: Mixamo forbids redistribution and any ML use, and Bandai
Namco's set is non-commercial, so those stay runtime-fetched measurement references only.

What the first pass (2026-10-19, `8404f9ab`) showed, angle RMSE at matched speed:

| Ours vs reference | Overall | Biggest differences |
| --- | --- | --- |
| Outbreak zombie vs 100STYLE Zombie (0.79 m/s) | 31.3° | Shoulder flexion 58.9° (both zombie references hold the arms out level; ours hang and reach low), cadence 114 vs 86 steps/min |
| Outbreak zombie vs Quaternius zombie (0.73 m/s) | 25.1° | Shoulder 57.2°, trunk 17° vs 39° hunch, knee never straightens (34–83°) in the keyframed clip |
| Outbreak sneak vs 100STYLE Crouched (0.88 m/s) | 30.1° | Knee 63.5°: ours is a deep fixed squat (knee 90–116°) where the mocap bends 20–73°; our swing heel kicks up behind |
| Survivor walk vs 100STYLE Neutral (0.93 m/s) | 16.1° | Forearm and shoulder ~20–24°; our trunk pitch moves 0.3° per cycle vs 6.4° |
| Survivor run vs Quaternius jog / sprint | 20.7° / 27.1° | Trunk lean 9–12° vs 23° / 37° (game clips lean much harder) |

## Skinned people on the rig

`@arcade/kit/people` ([people.md](people.md)) poses a skinned MakeHuman mesh (game_engine skeleton) from the rig's
frames instead of drawing parts. It walks and runs with mocap and stands with the rig (below); the rig's own motion
and gait numbers are unchanged. What held up, measured with `bun scripts/people/measure.ts` and
`bun scripts/people/gait-metrics.ts`:

- **IK on the mesh's own bone lengths, not the rig's.** Copying rig rotations onto a skeleton with different thigh and
  shin lengths slides planted feet. Retargeting by positions (rig ball and ankle targets, two-bone IK with the mesh's
  lengths, pole from the rig knee) keeps a planted ball at 0 mm slip over a 6 s 1.4 m/s walk.
- **Ball target, heel pivot at strike.** The mesh's ball sits on the rig's ball while planted; during heel strike
  the target blends to the heel so the boot rolls over its heel instead of slapping flat.
- **Pelvis sink when a leg cannot reach.** Uneven ground or a different leg length leaves a straight leg short; the
  hips drop on a spring (140, ζ 0.85) by just the shortfall.
- **Terrain is a layer after the rig** (`terrain.ts`, after Outbreak's `sharedFootGround`): planted feet take the
  ground under the ball and pitch so the heel rests on it; swing feet arc over anything on the path (16 samples, 5 cm
  toe margin). Over a 30 cm log: worst sink 28 mm, planted float 52 mm where heel and ball straddle the log's edge
  (gap).
- **Boots on round logs.** Pitch the planted boot to the tangent from its ball over the ground under the mesh's own
  sole (the rig's longer foot finds log edges the boot never touches), hung off the rig's ball pivot so heel strike
  and heel rise do not slide the samples; at heel strike also clear the ground under the rig's heel point, since near
  a log's steep edge a centimetre of plan is a hand's height. Six bodies: sink 11–14 mm, planted float ≤ 4 mm
  (measured at heel and ball; a flat boot on a round log touches between them).
- **Standing weight shift.** Hips slide 3.5 cm over the loaded leg and roll 4° down on the free side, chest counter-rolls
  2.6°, hands ride with the shoulders; the leg IK unlocks the free knee by itself. Dwell 3–5 s per side, ~1 s across,
  faded in after ~1 s still and out within 0.25 s of any step.
- **Torch hand.** A wrist bend after the arm IK turns the barrel onto the beam (0° worst error while walking). The
  barrel lies diagonally in the palm (heel of the hand to the index knuckle) and each hand solves its own finger
  angles at load so every joint sits on the barrel's surface; one set of angles for all hands put PIP joints inside
  the barrel and the thumb 6–9 cm off it, because fingers differ in length and knuckle height.
- **Carry a torch low, thumb forward** (`torchCarry`). Held out at chest height, a fist aims its barrel up the
  forearm's side, so only a 55–66° wrist fold aims it ahead; carried by the hip with the thumb forward, the diagonal
  grip already points it forward and down (wrist 8–47° over every beam direction, searched for least bend).
- **Arms on the mesh's shoulder, never locked.** The MakeHuman arm is 10–13% shorter and its shoulder narrower than
  the rig's at leg scale, so absolute rig wrist targets locked the elbow straight 50–75% of a walk. Hang the rig's
  shoulder→wrist vector from the mesh's own shoulder scaled to its arm, then ease reach toward 97.5% (86% with a torch).
- **Mocap gait over the rig's on a realistic mesh.** Side by side on the same body (`scripts/people/walk-compare.sh`),
  the rig's walk reads as a crouched shuffle (stance knee stays bent, short stride, little heel–toe roll) and CMU's
  brisk walk reads as a person: straight stance leg at heel strike, heel-to-toe roll and push-off, longer stride, arms
  hanging close. 100STYLE (CC BY 4.0) tops out at 0.93 m/s walking and 1.59 m/s "running" in its steady windows, too
  slow for woods' 1.9 m/s walk and 3.4 m/s sprint; CMU 07_12 (≈2.0 m/s) and 09_11 (3.42 m/s) match them.
- **Lock the ball the mesh is pinned to.** A foot lock on the joint-map ball still slid ~5 mm a frame while a lifted
  heel blended flat: the rig pins the mesh ball at √(foot² + ankle²) along ankle→ball, and that line's length changes
  in a blend. Locking that point took the worst stance slip from 113 mm to under 10 mm.
- **Pole the knee ahead of the rig knee.** On a nearly straight mocap leg (heel strike, terminal stance) the mesh's
  hip→ankle chord can pass in front of the raw rig knee, and the IK flips the knee backward for a frame (18 cm). The
  pole sits 20 cm ahead along the thigh's forward axis.
- **Hand over between rig and cycle on the rig's terms.** While the rig leads, the cycle faces its aim (not the travel
  direction, which is reversed backpedalling) and follows its stride phase (the rig's left foot lands at phase 0, the
  clip's at its first plant). A planted foot takes its height from the gait that planted it, before the lock reads
  its ball. Otherwise starts whip the pelvis ~5° a frame and planted feet hover 4–8 cm mid-blend.
- **Level and trim the mocap plants.** One CMU foot sat toe-up 5 cm through its whole stance (marker placement); the
  bake levels each foot so its flat-stance ball is `RIG.ankle` below its ankle. A foot is planted while the ball the
  mesh is pinned to is down or the heel is down; heel up with that ball lifted is push-off on the toe.
- **No margin on a swinging sole's ground.** `terrainFeet` measured a swinging boot's pitch against its ground less
  1 cm, so flat ground read as an obstacle: every swinging boot tilted 17° toes-up and snapped flat the frame it
  planted (5–7 cm at the ankle). `scripts/people/gait-clip.sh` (idle, turn, walk off, curve, stop, backpedal) reports
  the worst frame-to-frame knee/foot jump: 7–10 cm through the hand-overs, a swinging foot's own speed.

## Body-motion invariants

`@arcade/kit/motion-check` checks the **displayed world-space joints**, after IK and retargeting. It is pure TypeScript:
`checkBodyMotion(frames, calibration)` returns joint, frame (zero-based), time (seconds at the end of the frame), rule,
space, measured value, threshold, unit, ratio and reason. `measureBodyMotion` exposes the same measurements for a
baseline or a debug display. It reuses `pose-diff`'s canonical joint IDs; the sweep uses its joint extractors and the
same production adapters as `gait-metrics`, `survivor-legs` and `scripts/people/gait-metrics`.

```sh
# Before and after every animation change; run from the repository root.
hivemind run --kind cargo --fetch captures/motion -- bun scripts/motion-check.ts --out captures/motion
# Narrow iteration, or compare a checkout (both checkouts need dependencies).
bun scripts/motion-check.ts --actor soldier,a-woods --fps 60 --baseline /path/to/before
# Reference calibration only. Until #428 lands, point at its checkout for the CMU loader/parser.
# Downloads the two hash-pinned CMU files into the existing fixture cache.
bun scripts/motion-check.ts --calibrate --calibrate-only --reference-root /path/to/people-real
# Render deterministic highlighted side/front strips and ¼-speed H.264 clips on a render worker.
hivemind run --kind render --fetch captures/motion -- uv run --with pillow python3 scripts/motion/render.py captures/motion
# Analytic checker tests, and the reviewed production regression ledger (no downloads).
bun test packages/kit/motion-check.test.ts games/blackout/tests/motion-invariants.test.ts
```

### What the rules measure

| Rule | Measurement |
| --- | --- |
| Pops | Every joint's displacement, velocity, acceleration and jerk, in world space and with pelvis translation subtracted. Relative space retains yaw; a turning or whipping limb must not disappear through coordinate rotation. |
| Bone length / width | Change from the first valid pose in each segment for limb links, hip width and shoulder width. This checks displayed joint separation, including a boot separating from its IK-clamped shin. |
| Hinges | Unsigned knee/elbow flexion and its rate; signed bend-plane reversal distance. Knee forward follows the boot, elbow backward follows the shoulder bar. Nearly straight limbs do not require normalizing a tiny bend-plane normal. |
| Twists | Wrapped pelvis/torso yaw rate and acceleration, from rigid-frame yaw when supplied, otherwise the hip/shoulder bars. Crossing ±π is not a pop. |
| Feet | Horizontal speed of the same planted sole point; sink/hover from terrain to the lowest sole surface; ankle, ball and toe speed at either contact edge. Contact labels come from the animation state, never inferred from the measured game's foot height. |
| Grip | Change in wrist-to-independent-prop-anchor distance while a grip is active. Release clears that grip's history. |
| Bad numbers | Non-finite joint, yaw, contact or grip coordinates, non-positive/non-finite dt, missing pelvis, or invalid speed. Invalid samples break derivative history. |

The input's `dt` is the **actual elapsed sample interval**, including a hitch, not the rig's internally clamped step.
Velocity/acceleration/jerk are order-1/2/3 divided differences, using the full elapsed stencil at irregular sample
intervals. There are no artificial zero derivatives at startup. `reset: true` starts new derivative, contact, bone and
grip history for an intentional spawn/teleport. Supply sole points separately from ankle bone origins; optional
`surfaceY` measures the lowest heel/ball surface without switching which point is tracked for slip.

### Thresholds and their evidence

`scripts/motion/calibration.json` stores each channel's measured maximum, its source take/window/clock, both source
SHA-256 hashes and the margin. Calibration is **CMU 07_12 walk, source frames 30–240, and 09_11 run, frames 2–165**,
using the existing `open-mocap.ts` loader, parser, orientation normalization and steady-window selector. The calibration
poses/resets at the beginning of the cgspeed BVHs are excluded explicitly. No procedural output enters calibration.
Each take is sampled at 30, 60 and 144 fps, with and without a 100 ms interval: **12 reference sweeps, 1,406 frames,
zero violations**. Linear resampling's small rigid-link residuals stay in the reference envelope.

Threshold = reference channel maximum × **1.10** × stature × speed factor^derivative order. Stature is measured leg
length / reference leg length (**0.84155 m**). Speed factor = max(1, locomotion speed / stature / reference median speed
**2.00827 m/s**); the fastest speed in a derivative's four-sample history is retained across a stop. Angular channels
omit stature, static geometric channels omit speed, and displacement multiplies the velocity allowance by dt.
The 10% margin is an explicit measurement-envelope policy, not a claimed anatomical constant. Left/right share the
larger reference bound. A 1 µm numerical floor prevents FK roundoff becoming a violation.

Representative limits at reference stature and speed (the JSON is authoritative):

| Channel | Limit |
| --- | --- |
| Pelvis-relative knee velocity / acceleration / jerk | 5.351 m/s · 661.5 m/s² · 116,450 m/s³ |
| Pelvis-relative wrist velocity / acceleration / jerk | 2.511 m/s · 235.9 m/s² · 62,214 m/s³ |
| Thigh / shin length drift | 0.546 / 0.767 mm |
| Upper arm / forearm length drift | 0.111 / 0.084 mm |
| Hip / shoulder width drift | 0.144 / 0.026 mm |
| Knee / elbow flexion | 135.0° / 142.4° |
| Reverse knee bend (projected distance) | 19.37 mm |
| Pelvis / torso yaw speed | 5.072 / 1.768 rad/s |
| Pelvis / torso yaw acceleration | 458.0 / 196.9 rad/s² |
| Planted point slip | 0.4875 m/s |
| Stance sink / hover | 12.63 / 31.74 mm |

CMU has no force-plate/contact labels here. Reference mid-stance uses independently low **and** slow ball markers
(each foot's lower quartiles); its stance-median marker height supplies the sole offset. This avoids training the
slip limit on a heel rocker or swinging foot. CMU's raw derivative noise makes acceleration/jerk limits conservative;
velocity and geometric failures remain the stronger pop signals. The same reference controls always pass, including
the hitch. No fixture offers a held prop, so grip uses the measured rigid-link residual (4.82 mm at reference stature),
not a claim of mocap grip evidence. The parser exposes one toe marker; toe-tip calibration is its rigid extension,
not independent toe-flexion evidence.

### Sweep, acceptance and regression ledger

The tape includes starts/stops, walk→run→sprint→run→walk, turns in place, backpedal, strafe, sudden reversals, Outbreak
crouch, downward torch aim while reading the Woods map, and a walk start after turning 180°. It runs Blackout survivor
and soldier, Outbreak survivor and zombie, and all **18 people cast/look combinations** through `People.drive` itself
(gait blend, terrain, weight shift and retargeting included). The optional remote pass feeds the production
`SnapshotBuffer` and `hermite2` into the survivor animator at 20 Hz snapshot rate and 100 ms interpolation delay.
Every clock also gets one 100 ms interval just after walk→run.

Coverage boundaries are in every report: shared avatars/people have no crouch button or jump/land pose; the Outbreak
adapter alone has a crouch input. No jump is synthesized. Woods' remote friends have no map-hand pose; only its
downward torch axis is covered, not the first-person sheet/HUD. Straight walk/run envelopes are candidate alerts
for armed poses and fast turns, not universal anatomical limits. Joint points cannot reveal axial bone rotation;
this tool checks bend planes and body yaw, not full elbow/knee rotational anatomy.

`bun scripts/motion/acceptance.ts /path/to/pre-fix` is the negative control on people-real's **33a5d629**: it must find
the reversed knee, turned-start yaw whip and hovering stance foot at the gait blend at all three frame rates.
The regression test uses `scripts/motion/baseline.json`, a separate ledger of current **per-joint/channel maxima**
over the production tape. It fails on a new channel, a non-finite sample or a worse maximum. Existing findings stay
in the report; they are not erased by widening CMU limits. Refresh the ledger only after reviewing a deliberate
animation change (`--write-baseline --actor ... --fps ...`) and record the reason here.

Reports rank by estimated visible travel rather than ratio to a nearly-zero numerical threshold. Each finding retains
the exact frame/time, raw units and source limit. `scripts/motion/render.py` draws those production joints with the
offending joint red, holds samples for their actual dt at ¼ speed, checks encoded frame counts and per-tile contrast,
and streams frames to ffmpeg without leaving raw frame dumps. It is a diagnostic line rig, not a shaded game capture.

The initial regression ledger is main **0a28cd80**, seven bodies (the four shared adapters plus `a-woods`, `d-office`
and `f-survivor`) at 60 fps, with/without the hitch: fourteen 30-second tapes. It records current defects so future
changes cannot silently worsen them; it is not an animation-quality approval. The full report additionally sweeps all
18 cast/look combinations at all three frame rates. `People.spawn` and `People.drive` run headlessly with only GPU
allocation stubbed, so each checkout initializes its own production state. Main before #428 uses its original
retargeting; the pinned people-real checkout uses its gait blend. Reports label and record these source revisions
separately and do not claim a post-fix comparison while #428 is open.

Initial sweep, 2026-10-22: **150 production tapes** (22 main bodies plus the pre-fix `a-woods` control, each at six
clocks, and six remote tapes on each revision). Main produced 23,292 deduplicated scenario/joint/rule candidates;
pre-fix plus its remote control produced 1,675. No non-finite channels were observed. Counts include different
derivatives of the same event and are not distinct bug counts. Review the highest visible travel first:

| Source / event | Measurement | CMU-scaled allowance |
| --- | --- | --- |
| Main Outbreak zombie, run→walk, 60 fps, t=8.0167 s | Left ankle contact-edge speed 106.07 m/s (1.768 m in one frame) | 2.339 m/s |
| Same zombie frame | Shin length drift 0.8203 m | 0.757 mm |
| Main soldier, turned stop, 144 fps, t=29.0069 s | Left ankle world acceleration 8,993.6 m/s² | 223.2 m/s² |
| Pre-fix people-real, start-walk, 60 fps, t=2.600 s | Reverse left knee projection 148.0 mm | 21.09 mm |
| Pre-fix people-real, turned start, 60 fps, t=27.050 s | Torso yaw 8.031 rad/s | 1.768 rad/s |
| Pre-fix people-real, walk→run, 60 fps, t=3.100 s | Right sole hover 127.8 mm | 34.57 mm |

All three pre-fix defects are also detected at 30 and 144 fps (nine acceptance cases). The zombie uses the same
1.4/4.2/6.3 m/s stress tape as the other bodies, beyond a normal shambler's speed: reproduce at gameplay speeds
before treating that extreme as an ordinary gameplay failure. Armed/reaching elbow reversals need pose review;
CMU locomotion envelopes alone do not prove an invalid arm pose. No animation changes accompany this checker.
Report, exact joint windows, highlighted strips and ¼-speed clips:
`~/code/home/artifacts/motion-invariants-2026-10-22/`.

## Known gaps

- **Run late-swing knee extension still leads mocap by ~8°.** Walk leg RMSE is now **8.07°** (hip 4.48°, knee 10.94°,
  ankle 8.78°; Outbreak walk **10.72°** with ankle 8.93°) and run leg RMSE is **12.96°** (hip 11.09°, knee 18.32°,
  ankle 9.48°; Outbreak run **13.15°** with knee 15.95°, ankle 13.72°); the remaining run knee error comes from late
  swing (`7/8`), where tapering the heel-tuck before `u = 0.92` for zero-speed contact extends the shin slightly earlier
  than the mocap runner.
- **Walk cadence is 126.6 steps/min vs. 112.5 in mocap:** the ball-of-foot (MTP) toe joint and terminal-stance heel rise
  lengthened 1.4 m/s walking steps from `0.580 m` (`144.6 steps/min`) to `0.665 m` (`126.6 steps/min`) at `pelvis.y = 0.819 m`
  with zero shin-to-ankle separation. Reaching `112.5 steps/min` (`0.75 m` steps at `1.4 m/s`, vs. mocap's `1.30 m/s`)
  would require either a deeper double-support pelvis dip (`< 0.79 m`) or 3-DOF pelvic list/obliquity that lowers the
  trailing hip joint independently of the stance hip.
- **Outbreak's zombies still step their own terrain-support contact loop** (`src/zombies.ts`); the survivor runs
  `locomotion` (Lab › Survivor strafe › Legs › Today keeps the old loop).
- **WASD leg gaps (survivor-legs.ts).** Shins still pass within a few cm for a frame or two when the hips swing
  through a transition (circle strafe into a sprint, a 90° cut at a sprint, quick reversals in Blackout); the worst
  overstretch left is 10 to 15 cm for a frame or two in those cuts, while the other boot is in the air and cannot take
  the weight. Side-steps at 1.4 m/s take 257 steps/min and keep the hips 30° off aim (100STYLE: about 5° at 0.57
  m/s). Knee pop peaks near 1500 °/s on diagonal switches, where the pelvis itself turns fast.
- **Strafe gaps.** Hips stay fairly square (20° to 24° from aim) in the 120° to 135° back-diagonal band, where the
  crossover fades into the backpedal; side-steps at 1.4 m/s take 215 steps/min (forward walk 127), because a step
  that cannot cross is short; Outbreak's aimed run at 90° turns its planted boots 17° from the pelvis (mocap 10° to
  13°). The Bandai Namco set has no true side-step or run-strafe clip (its walk-left/right are forward walks with the
  hips toward travel) and the free Quaternius UAL packs have no strafes; 100STYLE Neutral SW/SR/BW/BR (sha-pinned in
  `open-mocap.ts`) give slow side-walk, side-run and backward references, and the crossover reference is authored.
- **Procedural melee upper-body posing (`packages/kit/human-melee.ts`, `melee-poses.ts`).** Outbreak's 9 melee weapons
  map onto three upper-body classes (`one-blunt`, `one-blade`, `two-heavy`) that layer pelvis/chest yaw coil-and-whip
  plus two-bone IK arm arcs over the standing or moving lower body without slipping planted feet (`0.0 m` toe slip at
  `0–4.2 m/s`, `maxRightShoulderChordM = 0.500 m <= 0.53 m` chain limit):
  - `one-blunt` (`crowbar`, `pipe`, `hammer`): Combo 1 forehand sweeps `+120.0° → -90.5°` (`210.5°` arc, `1.236 m` tip
    reach, `56.6°` chest twist), Combo 2 backhand reverses `-97.2° → +100.0°` (`197.2°` arc), and Combo 3 / charged
    heavy steps through `+176.2° → -111.0°` (`287.1°` arc, `101.5°` chest twist) with the off-hand counterbalancing.
  - `one-blade` (`knife`, `machete`): diagonal slashes sweep `+116.8° → -86.7°` (`203.5°` arc, `0.942 m` knife / `1.195 m`
    machete reach, `49.5°` chest twist) and reverse `-91.9° → +97.2°` (`189.1°` arc) on Combo 2.
  - `two-heavy` (`bat`, `spiked-board`, `axe`, `fire-axe`): both wrists stay coupled to the handle (`10.7–11.4 cm`
    mean wrist gap) across a wide horizontal cleave (`+134.3° → -100.2°`, `234.6°` arc, `69.2°` chest twist) and a
    deep over-the-shoulder charged heavy (`+193.7° → -127.9°`, `321.6°` arc, `1.289–1.385 m` tip reach, `123.3°` chest
    twist).
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
