import type { StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const loops = [
  ["survivor-walk", "Survivor walk (MTP toe roll)", "survivor", "action.walk", true],
  ["survivor-run", "Survivor run (forefoot push-off)", "survivor", "action.run", true],
  ["before-rigid-boot", "Before (rigid boot walk)", "survivor", "action.walk", false],
  ["soldier-run", "Soldier run", "soldier", "action.run", true],
  ["zombie-shamble", "Zombie shamble", "outbreak-zombie", "action.walk", true],
  ["blackout-zombie", "Blackout zombie", "zombie", "action.walk", true],
  ["wizard-walk", "Wizard walk", "wizard", "action.walk", true],
] as const

const strafes = [
  ["survivor-strafe", "Survivor circle strafe", "survivor", "circle", 3.4, "Circles while aiming at the centre: hips turn ~55° toward travel, chest holds the aim, legs cross over cleanly."],
  ["survivor-strafe-sweep", "Survivor strafe sweep", "survivor", "sweep", 3.4, "Aim turns once per lap, so travel-vs-aim sweeps forward → side → backpedal → side with no hip pop."],
  ["survivor-side-step", "Survivor slow side-step", "survivor", "circle", 0.8, "Slow circle: square hips, the lead foot opens and the follower closes beside it without crossing."],
  ["soldier-strafe", "Soldier circle strafe", "soldier", "circle", 4.2, "Rifle soldier at game speed (4.2 m/s) circling its target."],
] as const

// Grey ghost beside the actor playing an openly licensed reference cycle (reference-clips.ts --bake).
const references = [
  ["ref-zombie-100style", "Zombie vs 100STYLE zombie", "outbreak-zombie", "action.walk", "style-zombie-walk", "100STYLE Zombie mocap (CC BY 4.0): arms held out level, slower 86 steps/min shamble."],
  ["ref-zombie-ual", "Zombie vs Quaternius zombie", "outbreak-zombie", "action.walk", "ual-zombie-walk", "Quaternius UAL2 keyframed zombie walk (CC0): deep 39° hunch, arms forward."],
  ["ref-survivor-walk", "Survivor walk vs 100STYLE", "survivor", "action.walk", "style-neutral-walk", "100STYLE Neutral walk mocap (CC BY 4.0) beside the procedural walk."],
  ["ref-survivor-jog", "Survivor run vs Quaternius jog", "survivor", "action.run", "ual-jog", "Quaternius UAL1 keyframed jog (CC0): 23° lean vs our 9–15°."],
] as const

// Strafe loops with a 100STYLE strafe ghost beside them (faces the aim, steps sideways or back).
const strafeReferences = [
  ["ref-side-step", "Side-step vs 100STYLE side-walk", "survivor", "circle", 0.8, "style-side-walk", "100STYLE Neutral side-step walk (CC BY 4.0, 0.65 m/s): hips within 5° of the chest, feet never cross, opening to about 52 cm."],
  ["ref-strafe-run", "Run strafe vs 100STYLE side-run", "survivor", "circle", 3.4, "style-side-run", "100STYLE Neutral side-step run (CC BY 4.0, 1.5 m/s, 176 steps/min) beside the 3.4 m/s game strafe, which turns the hips 55° and crosses over."],
  ["ref-backpedal", "Strafe sweep vs 100STYLE backward walk", "survivor", "sweep", 1.4, "style-back-walk", "100STYLE Neutral backward walk (CC BY 4.0, 0.68 m/s): toe-first landings, shorter steps."],
] as const

export default defineStation({
  id: "characters",
  title: "Characters & animation",
  summary: "The shared human rig on the Characters page: ball-of-foot (MTP) toe joint, heel-to-toe roll, longer walking stride, run, sprint, strafing, crouch-run and zombie shamble, with pose-diff against mocap.",
  order: 80,
  prop: "figure",
  color: 0x4fc3d9,
  status: "review",
  statusNote: "R-3 waiting",
  demo: { kind: "page", url: "/arcade/blackout/characters.html#survivor" },
  defaultVariant: "survivor-walk",
  // Each variant plays one actor's action, so Gait and Strafe are sections of one choice.
  pickOne: true,
  variants: [
    ...loops.map(([id, label, actor, action, toeJoint]): StationVariant => ({
      id,
      group: "Gait",
      label,
      note: toeJoint
        ? "Ball-of-foot (MTP) toe joint (RIG.foot = 0.125 m, RIG.toe = 0.065 m): heel-strike → foot-flat → heel-rise → toe-off roll with 0.0 mm planted ball slip."
        : "Previous rigid 0.19 m boot block without ball-of-foot bend (shorter 0.58 m steps at 144.6 steps/min).",
      url: `/arcade/blackout/characters.html#${actor}`,
      setup: [{ command: action }, { command: "character.toe-joint", args: { enabled: toeJoint } }],
    })),
    ...references.map(([id, label, actor, action, clip, note]): StationVariant => ({
      id,
      group: "Reference",
      label,
      note,
      url: `/arcade/blackout/characters.html#${actor}`,
      setup: [{ command: action }, { command: "character.reference", args: { clip } }],
    })),
    ...strafeReferences.map(([id, label, actor, mode, speed, clip, note]): StationVariant => ({
      id,
      group: "Reference",
      label,
      note,
      url: `/arcade/blackout/characters.html#${actor}`,
      setup: [{ command: "action.strafe", args: { mode, speed } }, { command: "character.reference", args: { clip } }],
    })),
    ...strafes.map(([id, label, actor, mode, speed, note]): StationVariant => ({
      id,
      group: "Strafe",
      label,
      note,
      url: `/arcade/blackout/characters.html#${actor}`,
      setup: [{ command: "action.strafe", args: { mode, speed } }, { command: "character.toe-joint", args: { enabled: true } }],
    })),
  ],
  board: { feature: "AR-16" },
  metrics: [
    { label: "Walk (1.4 m/s) cadence / step length / leg RMSE vs mocap", value: "144.6 → 126.6 spm / 0.580 → 0.665 m / 11.1° → 8.07°", source: "games/blackout/scripts/animation/pose-diff.ts" },
    { label: "Run (4.2 m/s) / Sprint (6.3 m/s) leg RMSE vs mocap", value: "15.8° → 12.96° (ankle 9.48°) / 21.6° → 18.76°", source: "games/blackout/scripts/animation/pose-diff.ts" },
    { label: "Outbreak walk / run leg RMSE & planted ball slip", value: "13.5° → 10.72° / 15.2° → 13.15° (0.0 mm slip)", source: "games/blackout/scripts/animation/pose-diff.ts" },
    { label: "Survivor aimed walk / run arm RMSE vs reference", value: "64.1° → 2.60° / 46.8° → 4.28°", source: "games/blackout/scripts/animation/survivor-aim.ts" },
    { label: "Outbreak zombie shamble overall / arm RMSE", value: "20.1° → 6.84° / 24.8° → 4.08°", source: "games/blackout/scripts/animation/shamble-crouch.ts" },
    { label: "Run strafe 90° cadence (forward 239 steps/min)", value: "369 → 239 steps/min", source: "games/blackout/scripts/animation/strafe.ts" },
    { label: "Knee vs boot direction, worst strafe angle at a run (mocap 4–7°)", value: "23° → 8°", source: "games/blackout/scripts/animation/strafe.ts" },
    { label: "Outbreak aimed strafe sweep peak hip yaw rate (walk)", value: "1116 → 169 °/s", source: "games/blackout/scripts/animation/strafe.ts" },
    { label: "Outbreak WASD legs: worst ground skate / leg overstretch (AR-95)", value: "64.4 → 5.7 cm / 98.2 → 13.7 cm", source: "games/blackout/scripts/animation/survivor-legs.ts" },
  ],
  paths: ["packages/kit/human-locomotion.ts", "packages/kit/human-pose.ts", "packages/kit/rig.ts", "games/outbreak/src/survivor.ts", "games/outbreak/src/zombies.ts", "docs/animation.md"],
  branches: ["strafe", "outbreak-strafe-legs", "toe-joints", "survivor-aim", "zombie-shamble", "run-realism", "locomotion-pass", "walk-audit"],
  links: [{ label: "Characters page", href: "/arcade/blackout/characters.html" }],
})
