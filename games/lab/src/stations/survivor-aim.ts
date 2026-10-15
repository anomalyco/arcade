import type { StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1&infiniteAmmo=1"
const set = (key: string, value: number | boolean | string) => ({ command: "scene.set-param", args: { key, value } })
const pose = { command: "player.pose", args: { x: 29.0, y: 41.2, aim: 0, clearZombiesRadius: 12 } }
const defaults = [
  set("zoom", 24),
  set("hour", 16.0),
  set("timeScale", 0),
  set("aimRaiseTime", 0.15),
  set("aimHoldTime", 2.5),
  set("aimRecoil", 1.0),
  set("aimTwistLimit", 1.05),
]

const variants: StationVariant[] = [
  {
    id: "aim-fire",
    label: "Two-handed shoulder aim",
    note: "Default. Raises in 0.15 s on fire, locks both hands on the grip at shoulder height (0.0° muzzle error) and holds for 2.5 s. Click to shoot or move with WASD.",
    setup: [...defaults, pose, { command: "survivor.aim-demo", args: { mode: "aim-fire" } }],
  },
  {
    id: "low-ready",
    label: "Equipped low ready",
    note: "Idle / walking carry: right hand holds pistol ahead of the right ribcage (-27.5° muzzle pitch), left arm counter-swings.",
    setup: [...defaults, pose, { command: "survivor.aim-demo", args: { mode: "low-ready" } }],
  },
  {
    id: "reload",
    label: "Reload (mag to grip)",
    note: "1.15 s reload clip driven by reloadRemaining: pistol cants 42° at chest height while the left hand seats a magazine from the belt pouch into the grip well.",
    setup: [...defaults, pose, { command: "survivor.aim-demo", args: { mode: "reload" } }],
  },
  {
    id: "snappy-hold",
    label: "Snappy raise + 3.5 s hold",
    note: "Lab tuning preset: 0.12 s raise, 3.5 s hold after last shot, 1.35× recoil kick.",
    setup: [
      ...defaults,
      set("aimRaiseTime", 0.12),
      set("aimHoldTime", 3.5),
      set("aimRecoil", 1.35),
      pose,
      { command: "survivor.aim-demo", args: { mode: "aim-fire" } },
    ],
  },
  {
    id: "before",
    label: "Before (unarmed swing)",
    note: "Previous behavior: arms keep swinging empty at the hips (78.7° error) while the pistol floats at waist height.",
    setup: [...defaults, pose, { command: "survivor.aim-demo", args: { mode: "before" } }],
  },
]

export default defineStation({
  id: "survivor-aim",
  title: "Survivor aim & pistol",
  summary:
    "Outbreak's survivor pistol ready state: low-ready carry while walking/running, 0.15 s raise to two-handed shoulder aim on fire, per-shot recoil, 2.5 s hold, and magazine-to-grip reload.",
  order: 115,
  prop: "figure",
  color: 0xf0a44c,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: "aim-fire",
  variants: variants.map(v => ({ ...v, url: page })),
  board: { feature: "AR-16" },
  metrics: [
    {
      label: "Muzzle-vs-aim error (Idle / Walk / Run / Strafe / Backpedal)",
      value: "78.7° → 0.00°",
      source: "games/blackout/scripts/animation/survivor-aim.ts",
    },
    {
      label: "Raise time (0→90% / 0→95%, 0 mm anticipation dip)",
      value: "150 ms / 167 ms (2.8% settle)",
      source: "games/blackout/scripts/animation/survivor-aim.ts",
    },
    {
      label: "Post-shot aim hold / ease-to-low-ready",
      value: "2.53 s hold / 0.40 s lower",
      source: "games/blackout/scripts/animation/survivor-aim.ts",
    },
    {
      label: "Single-shot recoil (climb / slide-back / elbow absorb / 90% rec)",
      value: "+11.0° / 4.25 cm / +9.6° / 100 ms",
      source: "games/blackout/scripts/animation/survivor-aim.ts",
    },
    {
      label: "Pose-diff arm angle RMSE (Aimed Walk / Aimed Run / Low Ready)",
      value: "64.1° → 2.54° / 46.8° → 4.24° / 31.4° → 4.62°",
      source: "games/blackout/scripts/animation/survivor-aim.ts",
    },
  ],
  paths: [
    "games/outbreak/src/survivor.ts",
    "games/outbreak/src/combat-fx.ts",
    "games/blackout/scripts/animation/survivor-aim.ts",
    "docs/animation.md",
  ],
  branches: ["survivor-aim"],
  links: [
    { label: "Play Outbreak", href: "/arcade/outbreak/?seed=7&infiniteAmmo=1" },
    { label: "Characters page", href: "/arcade/blackout/characters.html#survivor" },
  ],
})
