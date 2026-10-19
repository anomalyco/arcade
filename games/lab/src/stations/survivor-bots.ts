import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7"

const setupBotVariant = (opts: {
  preset: number
  count: number
  overlay?: boolean
  scene?: string
  /** A Discovery › Stage scene (a D-19 verb set up in front of the survivor) to hand to the bot. */
  verb?: string
}): StationCommand[] => [
  { command: "scene.set-param", args: { key: "botEnabled", value: 1 } },
  { command: "scene.set-param", args: { key: "botSkillPreset", value: opts.preset } },
  { command: "scene.set-param", args: { key: "botCount", value: opts.count } },
  { command: "scene.set-param", args: { key: "botDebugOverlay", value: opts.overlay ?? true } },
  ...(opts.scene ? [{ command: "pacing.stage", args: { scene: opts.scene } }] : []),
  // After the pacing scene, so a calm town is reset around the bot before the verb is set up in front of it.
  ...(opts.verb ? [{ command: "discovery.stage", args: { scene: opts.verb } }] : []),
]

const variants: StationVariant[] = [
  {
    id: "skilled-solo",
    group: "Skill",
    label: "Skilled solo (perception & intent)",
    note: "Skilled bot (200 ms reaction, 0.055 rad aim error, 0.45 stamina reserve) looting Ash House, making things at the workbench, and kiting with the live perception & utility overlay.",
    setup: setupBotVariant({ preset: 2, count: 1, overlay: true, scene: "opening-calm" }),
  },
  {
    id: "novice-panic",
    group: "Skill",
    label: "Novice under pressure (dusk)",
    note: "Novice bot (520 ms reaction, 0.24 rad aim error, 0.85 panic) encountering first dusk shamblers: slower target acquisition, container smashing, and early sprint drain.",
    setup: setupBotVariant({ preset: 0, count: 1, overlay: true, scene: "first-contact" }),
  },
  {
    id: "expert-night-kite",
    group: "Skill",
    label: "Expert night kiting (22:30)",
    note: "Expert bot (110 ms reaction, 0.022 rad aim error, 0.86 ammo discipline) kiting a late-night horde, shoving close lungers, and breaking line of sight.",
    setup: setupBotVariant({ preset: 3, count: 1, overlay: true, scene: "late-night-horde" }),
  },
  {
    id: "coop-squad-4p",
    group: "Skill",
    label: "4-player co-op bot squad",
    note: "Four Skilled survivor bots sharing container searches, the workbench, squad pings, and ammo/plank bundle drops against co-op scaled hordes.",
    setup: setupBotVariant({ preset: 2, count: 4, overlay: true, scene: "first-contact" }),
  },
  {
    id: "perfect-reference",
    group: "Skill",
    label: "Perfect reference bot",
    note: "Zero reaction latency and zero aim error upper-bound bot for verifying maximum theoretical survival and fairness ceilings.",
    setup: setupBotVariant({ preset: 4, count: 1, overlay: true, scene: "late-night-horde" }),
  },
  {
    id: "verb-tripwire",
    group: "Verb",
    label: "Bot disarms a tripwire",
    note: "The pharmacy's cans in front of a Skilled bot. It crouches up to the line, works it loose without a rattle, keeps the cans and learns the tripwire.",
    setup: setupBotVariant({ preset: 2, count: 1, overlay: true, scene: "opening-calm", verb: "tripwire" }),
  },
  {
    id: "verb-closet",
    group: "Verb",
    label: "Bot hiding in a closet",
    note: "A Casual bot in a bedroom closet at night. It watches the room through the doors and steps out once nothing has been near for a few seconds.",
    setup: setupBotVariant({ preset: 1, count: 1, overlay: true, scene: "opening-calm", verb: "closet" }),
  },
  {
    id: "verb-repair",
    group: "Verb",
    label: "Bot re-nails a barricade",
    note: "A worn barricade and a crowbar. A Skilled bot takes the crowbar in hand and re-nails the boards to full instead of adding planks.",
    setup: setupBotVariant({ preset: 2, count: 1, overlay: true, scene: "opening-calm", verb: "repair" }),
  },
  {
    id: "verb-glass",
    group: "Verb",
    label: "Bot crouches over glass",
    note: "Bottles broken in a line from the pharmacy door. A Skilled bot crouches over the glass so its steps do not crunch, and over the cans at the door.",
    setup: setupBotVariant({ preset: 2, count: 1, overlay: true, scene: "opening-calm", verb: "lured" }),
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
  pickOne: true,
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-27" },
  metrics: [
    {
      label: "Shipped D-22 Balanced Curve, median survival with the D-18 dusk opening (total loss 40.80 vs 75.50 before D-22)",
      value: "Novice 0.47n · Casual 1.64n · Skilled 3.73n · Expert 3.87n",
      source: "games/outbreak/shared/difficulty-tuner.ts",
    },
    {
      label: "Pacing loss before → after D-22 (8 seeds × 5 skills)",
      value: "18.50 → 15.97 · survival-curve loss 56.41 → 12.90",
      source: "games/outbreak/scripts/run-bot-tuning.ts",
    },
    {
      label: "Pure step(state, inputs, dt) -> state & N-rollout branching",
      value: "Bit-exact SimState snapshot / fork / hash / diff · 100% Command-only inputs",
      source: "games/outbreak/tests/survivor-bot.test.ts",
    },
    {
      label: "L4D Pacing & Fairness (peaks/night · warned deaths · unfair spawns)",
      value: "1.4–3.1 peaks/n · 25–89s relax windows · 100% warned deaths · 0/0 unfair spawns",
      source: "games/outbreak/shared/bot-runner.ts",
    },
  ],
  paths: [
    "games/outbreak/shared/survivor-bot.ts",
    "games/outbreak/shared/bot-runner.ts",
    "games/outbreak/shared/difficulty-tuner.ts",
    "games/outbreak/src/bots-lab.ts",
    "games/outbreak/tests/survivor-bot.test.ts",
    "games/outbreak/tests/bot-verbs.test.ts",
  ],
  branches: ["survivor-bots", "balanced-difficulty", "bot-verbs"],
  links: [
    { label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" },
    { label: "First-night pacing", href: "/arcade/lab/?station=first-night" },
  ],
  layout: {
    left: [{ widget: "status" }, { widget: "metrics" }],
    dock: [{ widget: "variants" }],
  },
})
