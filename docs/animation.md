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
means the walk and run reference clips that `common.ts` downloads on first use.

## Code map

| File | What it owns |
| --- | --- |
| `packages/kit/human-locomotion.ts` | `gaitAt` (stride, duty, run blend), `locomotion` (stride clock, step release, swing, pelvis springs, arm springs), `stanceFootRoll`, `plantedFoot` (ball lock and heel-to-toe roll), `plantedToe`, `pelvisPoint` |
| `packages/kit/human-pose.ts` | `poseLegs` (leg IK, swing ankle and toe bend), `unarmedHands` (FK arm angles), `poseUnarmedArms` (arm IK pole), `poseArms` (armed hands) |
| `packages/kit/human-profile.ts` | `humanProfiles` presets and their Lab controls (`zombieVariant`) |
| `packages/kit/shamble-crouch.ts` | `buildShambleReferenceCycle`, `buildCrouchRunReferenceCycle`, `extractAsymmetricBvhCycle`, `shambleHandsFK`, `shambleTorsoModulation`, zombie variants (`limper`, `dragger`, `reacher`, `lunger`) |
| `packages/kit/rig.ts` | `RIG` link lengths (`thigh`, `shin`, `ankle`, `foot`, `toe`, `heel`), `ik`, frames and springs |
| `games/blackout/src/game/anim.ts` | `animate`/`build`: pelvis pitch, torso and head, weapon frame, action clips |
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

Every profile shares the strafe values `sideStepTurn 0.3`, `strafeHipTurn 0.95`, `crossoverSpeed 2.6` and
`strafeGap 0.2` (Lab → Animation; Outbreak's aimed survivor has the same keys in its Survivor strafe group).

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
- **Outbreak's survivor and zombies share `gaitAt` for cadence and duty (`127` / `239` steps/min)** and lock swing
  targets at `u >= 0.75`, but still step their own terrain-support contact loop (`Survivor.draw`, `src/zombies.ts`)
  rather than calling `locomotion` directly.
- **Strafe gaps.** Hips stay fairly square (20° to 24° from aim) in the 120° to 135° back-diagonal band, where the
  crossover fades into the backpedal; side-steps at 1.4 m/s take 215 steps/min (forward walk 127), because a step
  that cannot cross is short; Outbreak's aimed run at 90° turns its planted boots 17° from the pelvis (mocap 10° to
  13°). The Bandai Namco set has no true side-step or run-strafe clip (its walk-left/right are forward walks with the
  hips toward travel), so the side-step and crossover references are authored.
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
