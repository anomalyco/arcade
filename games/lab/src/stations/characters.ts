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
  variants: loops.map(([id, label, actor, action]): StationVariant => ({
    id,
    label,
    url: `/arcade/blackout/characters.html#${actor}`,
    setup: [{ command: action }],
  })),
  board: { feature: "AR-16" },
  paths: ["packages/kit/human-locomotion.ts", "packages/kit/human-pose.ts", "packages/kit/rig.ts", "docs/animation.md"],
  branches: ["zombie-shamble", "run-realism", "locomotion-pass", "walk-audit"],
  links: [{ label: "Characters page", href: "/arcade/blackout/characters.html" }],
})
