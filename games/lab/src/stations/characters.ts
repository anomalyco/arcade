import type { StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const loops = [
  ["survivor-walk", "Survivor walk", "survivor", "action.walk"],
  ["survivor-run", "Survivor run", "survivor", "action.run"],
  ["soldier-run", "Soldier run", "soldier", "action.run"],
  ["zombie-shamble", "Zombie shamble", "outbreak-zombie", "action.walk"],
  ["blackout-zombie", "Blackout zombie", "zombie", "action.walk"],
  ["wizard-walk", "Wizard walk", "wizard", "action.walk"],
] as const

const strafes = [
  ["survivor-strafe", "Survivor circle strafe", "survivor", "circle", 3.4, "Circles while aiming at the centre: hips turn ~55° toward travel, chest holds the aim, legs cross over cleanly."],
  ["survivor-strafe-sweep", "Survivor strafe sweep", "survivor", "sweep", 3.4, "Aim turns once per lap, so travel-vs-aim sweeps forward → side → backpedal → side with no hip pop."],
  ["survivor-side-step", "Survivor slow side-step", "survivor", "circle", 0.8, "Slow circle: square hips, the lead foot opens and the follower closes beside it without crossing."],
  ["soldier-strafe", "Soldier circle strafe", "soldier", "circle", 4.2, "Rifle soldier at game speed (4.2 m/s) circling its target."],
] as const

export default defineStation({
  id: "characters",
  title: "Characters & animation",
  summary: "The shared human rig on the Characters page: walk, run, sprint, crouch-run and the zombie shamble, with pose-diff against mocap.",
  order: 80,
  prop: "figure",
  color: 0x4fc3d9,
  status: "review",
  statusNote: "R-3 waiting",
  demo: { kind: "page", url: "/arcade/blackout/characters.html#survivor" },
  defaultVariant: "survivor-walk",
  variants: [
    ...loops.map(([id, label, actor, action]): StationVariant => ({
      id,
      label,
      url: `/arcade/blackout/characters.html#${actor}`,
      setup: [{ command: action }],
    })),
    ...strafes.map(([id, label, actor, mode, speed, note]): StationVariant => ({
      id,
      label,
      note,
      url: `/arcade/blackout/characters.html#${actor}`,
      setup: [{ command: "action.strafe", args: { mode, speed } }],
    })),
  ],
  board: { feature: "AR-16" },
  metrics: [
    { label: "Survivor aimed walk / run arm RMSE vs reference", value: "64.1° → 2.54° / 46.8° → 4.24°", source: "games/blackout/scripts/animation/survivor-aim.ts" },
    { label: "Outbreak zombie shamble overall / arm RMSE", value: "20.2° → 6.5° / 24.8° → 4.0°", source: "games/blackout/scripts/animation/shamble-crouch.ts" },
    { label: "Run strafe 90° cadence (forward 239 steps/min)", value: "369 → 239 steps/min", source: "games/blackout/scripts/animation/strafe.ts" },
    { label: "Knee vs boot direction, worst strafe angle at a run (mocap 4–7°)", value: "23° → 8°", source: "games/blackout/scripts/animation/strafe.ts" },
    { label: "Outbreak aimed strafe sweep peak hip yaw rate (walk)", value: "1154 → 177 °/s", source: "games/blackout/scripts/animation/strafe.ts" },
  ],
  paths: ["packages/kit/human-locomotion.ts", "packages/kit/human-pose.ts", "packages/kit/rig.ts", "games/outbreak/src/survivor.ts", "docs/animation.md"],
  branches: ["strafe", "survivor-aim", "zombie-shamble", "run-realism", "locomotion-pass", "walk-audit"],
  links: [{ label: "Characters page", href: "/arcade/blackout/characters.html" }],
})
