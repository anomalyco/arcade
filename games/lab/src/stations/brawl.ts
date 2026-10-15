import type { StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/brawl/playground.html?nolab"

const roster = [
  ["bea", "Bea Buzzby (talk-show host)", "Mic Drop, a seeking bee swarm that smoke scatters, and a Standing Ovation blast."],
  ["presto", "The Great Presto (magician)", "A fan of cards, Switcheroo (trade places with whoever the card hits) and a decoy with a blink."],
  ["chef", "Chef Flambé (celebrity chef)", "Ladle swing, a lobbed pan that leaves a grease slick, and a fire burst that leaves smoke."],
  ["roxy", "Roxy Rollers (roller derby)", "Quick elbow, a Jam Dash through everyone that leaves ice, and an Ice Rink with a speed boost."],
  ["slab", "Big Slab (masked wrestler)", "Heavy chop, Body Slam (grab the nearest fighter, crate or barrel and throw it) and a Flying Elbow shockwave."],
  ["fern", "Granny Fern (gardener)", "Shears, Creeping Vines that root, and a lobbed Bramble Patch that slows and stings."],
] as const

const variants: StationVariant[] = [
  ...roster.map(([id, label, note]): StationVariant => ({
    id,
    label,
    note: `${note} Loops every ability in turn at two dummies and a few props.`,
    url: `${page}#gallery/${id}`,
    setup: [{ command: "brawl.scene", args: { scene: "gallery", character: id } }],
  })),
  {
    id: "props",
    label: "Prop playground",
    note: "Every prop on the ring with Big Slab throwing whatever is nearest. Click in and play: WASD, mouse, Q / E / Space.",
    url: `${page}#props/chef`,
    setup: [{ command: "brawl.scene", args: { scene: "props", character: "chef" } }],
  },
  {
    id: "bots-4",
    label: "4-bot round",
    note: "The game's own BotBrains using every ability, rounds back to back.",
    url: `${page}#bots/4`,
    setup: [{ command: "brawl.scene", args: { scene: "bots", bots: 4 } }],
  },
  {
    id: "bots-8",
    label: "8-bot round",
    note: "A full room of eight bots.",
    url: `${page}#bots/8`,
    setup: [{ command: "brawl.scene", args: { scene: "bots", bots: 8 } }],
  },
]

export default defineStation({
  id: "brawl",
  title: "Brawl: characters, abilities and props",
  summary:
    "Brawl's six parody heroes looping their abilities at dummies, the prop playground and bots rounds, on the production World, renderer and HUD. The Abilities knobs edit each character's cooldowns, wind-ups, damage and knockback live; Props tunes mass, friction and barrel blasts.",
  order: 135,
  prop: "figure",
  color: 0xff4f9a,
  status: "in-progress",
  demo: { kind: "page", url: `${page}#gallery/bea` },
  defaultVariant: "bea",
  variants,
  board: { feature: "AR-38" },
  metrics: [
    { label: "Roster", value: "6 characters, 18 abilities + a shared dodge", source: "games/brawl/shared/characters/" },
    { label: "Ability effect kinds in the kit", value: "11 (melee, projectile or lob, burst, zone, swarm, dash, status, decoy, swap, grab, blink)", source: "packages/kit/sim/abilities.ts" },
  ],
  paths: ["games/brawl/", "packages/kit/sim/abilities.ts", "packages/kit/sim/props.ts", "packages/kit/sim/boids.ts"],
  branches: ["brawl*"],
  links: [
    { label: "Brawl", href: "/arcade/brawl/" },
    { label: "Practice vs bots", href: "/arcade/brawl/?practice" },
  ],
  layout: {
    right: [{ widget: "controls", groups: ["Scene", "Abilities"], title: "Abilities" }],
    dock: [{ widget: "variants" }, { widget: "perf" }, { widget: "voice" }, { widget: "notes" }],
  },
})
