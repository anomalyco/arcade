import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number | boolean) => ({ command: "scene.set-param", args: { key, value } })
const stage = (
  weapon: string,
  swing: "light" | "heavy" | "combo" | "knockdown" | "finisher" | "crawler" | "limp" = "light",
): StationCommand[] => [
  set("timeScale", 0),
  set("hour", 19.5),
  set("zoom", 28),
  { command: "melee.stage", args: { weapon, swing } },
]

const variants: StationVariant[] = [
  {
    id: "bat",
    group: "Weapon",
    label: "Baseball Bat",
    note: "Two-handed heavy wood club: wide 1.60 rad arc, 27 base dmg (3–4 body hits), high knockdown.",
    setup: stage("bat", "heavy"),
  },
  {
    id: "crowbar",
    group: "Weapon",
    label: "Crowbar",
    note: "One-handed steel prybar: 24 base dmg (4 body hits, 2–3 headshots), 45 durability, pries locked doors.",
    setup: stage("crowbar", "light"),
  },
  {
    id: "pipe",
    group: "Weapon",
    label: "Lead Pipe",
    note: "One-handed blunt pipe: 23 base dmg (4 body hits), 36 durability, reliable stagger in garages and warehouses.",
    setup: stage("pipe", "light"),
  },
  {
    id: "knife",
    group: "Weapon",
    label: "Kitchen Knife",
    note: "Fast one-handed blade: 18 base dmg (5–6 body hits, 2.25× headshot), quietest swing in diners and houses.",
    setup: stage("knife", "combo"),
  },
  {
    id: "machete",
    group: "Weapon",
    label: "Machete",
    note: "One-handed cleaving blade: 30 base dmg (3 body hits), 4.5 m noise, severs arms, legs, and heads.",
    setup: stage("machete", "light"),
  },
  {
    id: "axe",
    group: "Weapon",
    label: "Wood Axe",
    note: "Two-handed chopping axe: 34 base dmg (3 body hits), limb severing, and 50 structural door damage.",
    setup: stage("axe", "heavy"),
  },
  {
    id: "hammer",
    group: "Weapon",
    label: "Claw Hammer",
    note: "Compact one-handed hardware tool: 21 base dmg (4–5 body hits), 2.05 swings/s, 32 durability.",
    setup: stage("hammer", "light"),
  },
  {
    id: "spiked-board",
    group: "Weapon",
    label: "Spiked Board",
    note: "Crafted two-handed plank (1 plank, 2 scrap): 29 base dmg (3–4 body hits), punctured splatter, 20 durability.",
    setup: stage("spiked-board", "heavy"),
  },
  {
    id: "fire-axe",
    group: "Weapon",
    label: "Fire Axe",
    note: "Heavy two-handed breaching axe: 38 base dmg (3 body hits), 2.14 m reach, breaches doors in 2 swings.",
    setup: stage("fire-axe", "heavy"),
  },
  {
    id: "knockdown",
    group: "Wounded zombie",
    label: "Knockdown Posture",
    note: "Knocked-down zombie propped on one elbow at the survivor's feet with a subtle ground pulse and fading key cap (no text labels).",
    setup: stage("crowbar", "knockdown"),
  },
  {
    id: "finisher",
    group: "Wounded zombie",
    label: "Downed Finisher",
    note: "Contextual downward finisher strike on a downed zombie, crushing the skull and pooling crimson splatter.",
    setup: stage("crowbar", "finisher"),
  },
  {
    id: "crawler",
    group: "Wounded zombie",
    label: "Leg-Loss Crawlers",
    note: "One-leg and torso-only crawlers dragging themselves across the ground to grab the survivor's ankles.",
    setup: stage("machete", "crawler"),
  },
  {
    id: "limp",
    group: "Wounded zombie",
    label: "One-Arm & Limping",
    note: "Crippled one-arm and limping shamblers with asymmetric hip dip and reduced dragging speed.",
    setup: stage("crowbar", "limp"),
  },
]

export default defineStation({
  id: "outbreak-melee",
  title: "Outbreak melee weapons",
  summary:
    "Nine melee weapons across one-handed blunt, one-handed blade and two-handed heavy classes, with wind-up → active → recovery swing arcs, 2–3 swing combos, charged heavy attacks, stamina drain, durability and weapon-specific blood and impact sounds. Tunables are in the Melee group.",
  order: 118,
  prop: "figure",
  color: 0xd46a4e,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "bat",
  pickOne: true,
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-18" },
  metrics: [
    {
      label: "Weapon classes & swing arcs (one-blunt, one-blade, two-heavy)",
      value: "9 weapons · 138°–174° tip sweep",
      source: "games/blackout/scripts/animation/melee-poses.ts",
    },
    {
      label: "Melee SFX family (swing light/heavy, hit wood/metal/blade, break)",
      value: "6 ids · 17 variants (-18..-22 LUFS)",
      source: "packages/kit/audio/library.ts",
    },
  ],
  paths: [
    "games/outbreak/shared/combat.ts",
    "packages/kit/human-melee.ts",
    "games/outbreak/src/survivor.ts",
    "games/outbreak/src/combat-fx.ts",
  ],
  branches: ["melee*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
  layout: {
    left: [{ widget: "status" }, { widget: "metrics" }],
    dock: [{ widget: "variants" }],
  },
})
