import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7"

const setupBotVariant = (opts: {
  preset: number
  count: number
  overlay?: boolean
  scene?: string
}): StationCommand[] => [
  { command: "scene.set-param", args: { key: "botEnabled", value: 1 } },
  { command: "scene.set-param", args: { key: "botSkillPreset", value: opts.preset } },
  { command: "scene.set-param", args: { key: "botCount", value: opts.count } },
  { command: "scene.set-param", args: { key: "botDebugOverlay", value: opts.overlay ?? true } },
  ...(opts.scene ? [{ command: "pacing.stage", args: { scene: opts.scene } }] : []),
]

const variants: StationVariant[] = [
  {
    id: "skilled-solo",
    label: "Skilled solo (perception & intent)",
    note: "Skilled bot (200 ms reaction, 0.055 rad aim error, 0.45 stamina reserve) looting Ash House, researching at the workbench, and kiting with the live perception & utility overlay.",
    setup: setupBotVariant({ preset: 2, count: 1, overlay: true, scene: "opening-calm" }),
  },
  {
    id: "novice-panic",
    label: "Novice under pressure (dusk)",
    note: "Novice bot (520 ms reaction, 0.24 rad aim error, 0.85 panic) encountering first dusk shamblers: slower target acquisition, container smashing, and early sprint drain.",
    setup: setupBotVariant({ preset: 0, count: 1, overlay: true, scene: "first-contact" }),
  },
  {
    id: "expert-night-kite",
    label: "Expert night kiting (22:30)",
    note: "Expert bot (110 ms reaction, 0.022 rad aim error, 0.86 ammo discipline) kiting a late-night horde, shoving close lungers, and breaking line of sight.",
    setup: setupBotVariant({ preset: 3, count: 1, overlay: true, scene: "late-night-horde" }),
  },
  {
    id: "coop-squad-4p",
    label: "4-player co-op bot squad",
    note: "Four Skilled survivor bots sharing container searches, workbench research, squad pings, and ammo/plank bundle drops against co-op scaled hordes.",
    setup: setupBotVariant({ preset: 2, count: 4, overlay: true, scene: "first-contact" }),
  },
  {
    id: "perfect-reference",
    label: "Perfect reference bot",
    note: "Zero reaction latency and zero aim error upper-bound bot for verifying maximum theoretical survival and fairness ceilings.",
    setup: setupBotVariant({ preset: 4, count: 1, overlay: true, scene: "late-night-horde" }),
  },
]

export default defineStation({
  id: "survivor-bots",
  title: "Outbreak survivor bots & difficulty tuner",
  summary:
    "Human-like survivor bots bounded by player line-of-sight (Vision), camera footprint, and attenuated audio, acting strictly through Command inputs. Includes Novice..Perfect skill presets, 1–4 co-op squad play, live perception/intent overlay, headless batch runner, and CMA-ES difficulty tuning.",
  order: 105,
  prop: "figure",
  color: 0x38bdf8,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: "skilled-solo",
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-27" },
  metrics: [
    {
      label: "Skill preset median survival (Balanced Curve, loss 4.85 vs Today 134.93)",
      value: "Novice 0.91n · Casual 1.71n · Skilled 2.85n · Expert 3.53n",
      source: "games/outbreak/shared/difficulty-tuner.ts",
    },
    {
      label: "Perception & action boundary",
      value: "100% Command-only inputs · Vision LOS + light + attenuated audio",
      source: "games/outbreak/tests/survivor-bot.test.ts",
    },
    {
      label: "Unfair spawns (in-view / behind-player)",
      value: "0 / 0 across all multi-seed bot batches",
      source: "games/outbreak/shared/bot-runner.ts",
    },
  ],
  paths: [
    "games/outbreak/shared/survivor-bot.ts",
    "games/outbreak/shared/bot-runner.ts",
    "games/outbreak/shared/difficulty-tuner.ts",
    "games/outbreak/src/bots-lab.ts",
    "games/outbreak/tests/survivor-bot.test.ts",
  ],
  branches: ["survivor-bots"],
  links: [
    { label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" },
    { label: "First-night pacing", href: "/arcade/lab/?station=first-night" },
  ],
  layout: {
    left: [{ widget: "status" }, { widget: "metrics" }],
    right: [{ widget: "links" }, { widget: "changes" }],
    dock: [{ widget: "variants" }, { widget: "voice" }, { widget: "notes" }],
  },
})
