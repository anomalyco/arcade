import type { StationCommand, StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const stage = (secret: string): StationCommand[] => [{ command: "secrets.stage", args: { secret } }]

// Notes say what the station shows, not what it means: the meaning is the player's to find (docs/outbreak-secrets.md).
const variants: StationVariant[] = [
  { id: "calendar", group: "Subtle", label: "Calendars", note: "Every calendar in town stopped on the same month, one day circled.", setup: stage("calendar") },
  { id: "clock", group: "Subtle", label: "Clocks", note: "Every clock in town stopped at the same time.", setup: stage("clock") },
  { id: "photo", group: "Subtle", label: "Family photos", note: "Family photos, some with a face scratched out.", setup: stage("photo") },
  { id: "chalk", group: "Subtle", label: "Chalk by the path", note: "A child's chalk drawing by a front path or on a driveway.", setup: stage("chalk") },
  { id: "chalk-late", group: "Subtle", label: "Chalk, later in the run", note: "The same drawing after the first nights.", setup: stage("chalk-late") },
  { id: "nod", group: "Subtle", label: "A moving box", note: "One house in four runs: a moving box someone never unpacked.", setup: stage("nod") },
  { id: "tallMan", group: "Strange", label: "At the edge of the light", note: "Seen once, at night, at the edge of a lamp's reach.", setup: stage("tallMan") },
  { id: "audience", group: "Strange", label: "The chairs", note: "One house's chairs, arranged.", setup: stage("audience") },
  { id: "litWindow", group: "Strange", label: "A lit window", note: "One window in town still lit at night.", setup: stage("litWindow") },
  { id: "footprints", group: "Strange", label: "Footprints", note: "Bare footprints from the road to one house's side wall.", setup: stage("footprints") },
  { id: "phone", group: "Strange", label: "A wall phone", note: "A wall phone in one house.", setup: stage("phone") },
  { id: "rockingChair", group: "Strange", label: "A porch rocker", note: "A rocking chair on one porch.", setup: stage("rockingChair") },
  { id: "cellar", group: "Hidden", label: "The padlocked hatch", note: "A floor hatch with a three-dial padlock in one house, a mast in the side yard.", setup: stage("cellar") },
  { id: "cellar-open", group: "Hidden", label: "The hatch, open", note: "The same hatch, opened.", setup: stage("cellar-open") },
  { id: "procession", group: "Rare events", label: "Down the road", note: "About 3% of runs, once, late at night.", setup: stage("procession") },
  { id: "visitor", group: "Rare events", label: "At the door", note: "About 4% of runs, once, at night.", setup: stage("visitor") },
  { id: "tally", group: "Cards", label: "The quiet tally", note: "Marks on the death and escape cards: secrets found this run and ever. No words.", setup: stage("tally") },
]

export default defineStation({
  id: "outbreak-secrets",
  title: "Outbreak: Secrets",
  summary:
    "Subtle details, strange sightings and one hidden chain, picked per run from the town's seed and the same for every co-op client. Nothing is explained. Tunables are in Backquote › Secrets (Today is off): per-secret toggles, a rarity scale and a force picker.",
  order: 133,
  prop: "panels",
  color: 0x8fb38a,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "calendar",
  pickOne: true,
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-85" },
  metrics: [{ label: "Secrets tests", value: "11 sim + 4 co-op", source: "games/outbreak/tests/secrets.test.ts" }],
  paths: ["games/outbreak/shared/secrets", "games/outbreak/src/secrets"],
  branches: ["outbreak-secrets*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
