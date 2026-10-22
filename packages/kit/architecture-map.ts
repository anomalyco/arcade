import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export const ARCHITECTURE_MAP_START = "<!-- ARCHITECTURE-MAP:START -->"
export const ARCHITECTURE_MAP_END = "<!-- ARCHITECTURE-MAP:END -->"

export const ARCHITECTURE_GAMES = [
  { id: "getaway", label: "Getaway", dirs: ["games/getaway"] },
  { id: "blackout", label: "Blackout", dirs: ["games/blackout"] },
  { id: "outbreak", label: "Outbreak", dirs: ["games/outbreak"] },
  { id: "carrier", label: "Carrier", dirs: ["games/carrier"] },
  { id: "lab", label: "Lab", dirs: ["games/lab", "packages/kit/lab"] },
  { id: "wings", label: "Wings", dirs: ["games/wings"] },
  { id: "brawl", label: "Brawl", dirs: ["games/brawl"] },
  { id: "archers", label: "Archers", dirs: ["games/archers"] },
] as const

export type ArchitectureGameId = (typeof ARCHITECTURE_GAMES)[number]["id"]

export interface ArchitectureMapRow {
  area: string
  description: string
  match: (spec: string) => boolean
}

const RENDERER_TRANSITIVE_SPECS = [
  "@arcade/kit/gpu/wgsl",
  "@arcade/kit/gpu/cull",
  "@arcade/kit/gpu/targets",
  "@arcade/kit/gpu/pass-graph",
  "@arcade/kit/gpu/motion",
  "@arcade/kit/gpu/motion-blur",
  "@arcade/kit/gpu/look-shaders",
  "@arcade/kit/gpu/lamp-grid",
  "@arcade/kit/gpu/volume-pass",
  "@arcade/kit/gpu/fog-scatter",
  "@arcade/kit/gpu/fog-blur",
  "@arcade/kit/gpu-perf",
  "@arcade/kit/textures",
  "@arcade/kit/textures/loader",
  "@arcade/kit/textures/manifest",
]

const LAB_PANEL_TRANSITIVE_SPECS = [
  "@arcade/knobs",
  "@arcade/kit/lab-knobs",
  "@arcade/kit/lab-navigation",
  "@arcade/kit/lab-tuning",
  "@arcade/kit/dev-control",
  "@arcade/kit/lab-commands",
]

export const ARCHITECTURE_MAP_ROWS: readonly ArchitectureMapRow[] = [
  {
    area: "`sim/rng`",
    description: "Seeded PRNG (`Rng`, `mulberry32`, `seedOf`, `hash2`, `hash3`)",
    match: (s) => s === "@arcade/kit/sim/rng",
  },
  {
    area: "`sim/geom`",
    description: "`RectGrid`, DDA `raycast`/`clearLine`, `pushOut`, `MinHeap`",
    match: (s) => s === "@arcade/kit/sim/geom",
  },
  {
    area: "`sim/obb`",
    description: "2D SAT manifold and Box2D 2-point block impulse solver",
    match: (s) => s === "@arcade/kit/sim/obb",
  },
  {
    area: "`sim/ai`",
    description: "Shared steering, sight checks, and tactical/zombie AI helpers",
    match: (s) => s === "@arcade/kit/sim/ai",
  },
  {
    area: "`sim/flow-field`",
    description: "Shared per-goal flow fields (`FlowFieldCache`) over `GridNav` flat grids or chunk tiles",
    match: (s) => s === "@arcade/kit/sim/flow-field",
  },
  {
    area: "`sim/ledger`",
    description: "Deterministic item store, containers, and crafting rule engine",
    match: (s) => s === "@arcade/kit/sim/ledger",
  },
  {
    area: "`sim/matchmaking`",
    description: "`SharedMatchmaker`, room codes, and player name sanitization",
    match: (s) => s === "@arcade/kit/sim/matchmaking",
  },
  {
    area: "`sim/move`",
    description: "Top-down circle body step with eased velocity and substepped push-out",
    match: (s) => s === "@arcade/kit/sim/move",
  },
  {
    area: "`sim/{abilities,props,boids}`",
    description: "Data-driven, server-authoritative abilities (casts, projectiles, swarms, zones, dashes, grabs), shoveable OBB props, and a presentation boids flock",
    match: (s) => s === "@arcade/kit/sim/abilities" || s === "@arcade/kit/sim/props" || s === "@arcade/kit/sim/boids",
  },
  {
    area: "`server/*`",
    description: "Room and Lobby Durable Objects (`RoomObject`, `LobbyObject`) and the room game Worker router",
    match: (s) => s.startsWith("@arcade/kit/server/"),
  },
  {
    area: "`net/*`",
    description: "Room seats/idle/tick core and client socket, binary framing, seat tokens, `JitterBuffer`, `SnapshotBuffer`, `Predictor`, `Smoother`",
    match: (s) => s.startsWith("@arcade/kit/net/"),
  },
  {
    area: "`gpu/wgsl`",
    description: "Typed WGSL structs (`wgslStruct`), slot specialization (`wgslSlot`), and snippet composition",
    match: (s) => s === "@arcade/kit/gpu/wgsl",
  },
  {
    area: "`gpu/mesh`",
    description: "24-byte packed vertex builder (`Mesh`, `packVerts`)",
    match: (s) => s === "@arcade/kit/gpu/mesh",
  },
  {
    area: "`gpu/{cull,targets,pass-graph,reactive}`",
    description: "Frustum/shadow-sweep culling, contiguous draw merging, `ScenePass` slots, MSAA/HDR targets, 5-level bloom, and the TAA reactive-mask contract",
    match: (s) =>
      s === "@arcade/kit/gpu/cull" ||
      s === "@arcade/kit/gpu/targets" ||
      s === "@arcade/kit/gpu/pass-graph" ||
      s === "@arcade/kit/gpu/reactive",
  },
  {
    area: "`gpu/{renderer,shaders,level}` & `limits`",
    description: "Polar shadows, cutaway chunks, 4x MSAA HDR, and 5-level bloom",
    match: (s) =>
      s === "@arcade/kit/gpu/renderer" ||
      s === "@arcade/kit/gpu/shaders" ||
      s === "@arcade/kit/gpu/level" ||
      s === "@arcade/kit/gpu/lamp-grid" ||
      s === "@arcade/kit/limits",
  },
  {
    area: "`gpu/{fog-scatter,volume-pass,fog-blur}`",
    description: "Analytic height fog, fog-sky skylight, equiangular lamp scattering and wet streaks, drifting fog bank, lit cloud deck and fog-depth blur; volume slots with depth, history, transmittance and depth-aware upsample",
    match: (s) => s === "@arcade/kit/gpu/fog-scatter" || s === "@arcade/kit/gpu/volume-pass" || s === "@arcade/kit/gpu/fog-blur",
  },
  {
    area: "`gpu/{boot,scene-frame}`",
    description: "WebGPU canvas boot, and frame inputs for small arenas: placed lights, box occluders, flat floor lighting",
    match: (s) => s === "@arcade/kit/gpu/boot" || s === "@arcade/kit/gpu/scene-frame" || s === "@arcade/kit/gpu/frame-parts",
  },
  {
    area: "`gpu/lights/{physical,beam,flicker,street}`",
    description: "Opt-in physical lights and surfaces (GGX, 3D spot cones, torch beam profile, sky reflections, specular AA), street lamps as lens emitters with roadway photometry, and stateless lamp flicker and failure",
    match: (s) => s === "@arcade/kit/gpu/lights/physical" || s === "@arcade/kit/gpu/lights/beam" || s === "@arcade/kit/gpu/lights/flicker" || s === "@arcade/kit/gpu/lights/street",
  },
  {
    area: "`gpu/shadows/spot-shadows`",
    description: "Perspective shadow maps for the few most important spot lights, re-rendered only when a slot changes",
    match: (s) => s === "@arcade/kit/gpu/shadows/spot-shadows",
  },
  {
    area: "`gpu/gi/plan-bounce`",
    description: "One bounce of the frame's lights in plan space: per-frame emission, mip chain and cone gather on a world-anchored grid, held by walls",
    match: (s) => s === "@arcade/kit/gpu/gi/plan-bounce",
  },
  {
    area: "`gpu/shadows/capsule-shadows`",
    description: "Analytic soft character shadows from rig bone capsules: contact occlusion and a contact-hardening shadow per light and the sun, grid-culled",
    match: (s) => s === "@arcade/kit/gpu/shadows/capsule-shadows",
  },
  {
    area: "`gpu/contact-shadows`",
    description: "Screen-space contact shadows volume slot: a short depth march toward the brightest lights at each pixel, with history",
    match: (s) => s === "@arcade/kit/gpu/contact-shadows",
  },
  {
    area: "`gpu/reflections/{ssr,surface,wet}`",
    description: "Screen-space reflections volume slot (Ashwood's march, streak blur and history), HDR-alpha roughness tag, and the shared wet/puddle surface term",
    match: (s) => s.startsWith("@arcade/kit/gpu/reflections/"),
  },
  {
    area: "`gpu/{motion,motion-blur,sprite-motion}`",
    description: "Depth-aware 8-tap shutter gather and actor/sprite velocity history",
    match: (s) =>
      s === "@arcade/kit/gpu/motion" ||
      s === "@arcade/kit/gpu/motion-blur" ||
      s === "@arcade/kit/gpu/sprite-motion",
  },
  {
    area: "`gpu/{surface-materials,foliage}` & `textures`",
    description: "Procedural surface recipes, 16-layer WebP array, foliage, and trample",
    match: (s) =>
      s === "@arcade/kit/gpu/surface-materials" ||
      s === "@arcade/kit/gpu/foliage" ||
      s === "@arcade/kit/gpu/foliage-looks" ||
      s === "@arcade/kit/textures" ||
      s.startsWith("@arcade/kit/textures/"),
  },
  {
    area: "`props/*`",
    description: "Generated furniture library: catalogue, `.prop` meshes, instanced batches, seeded room placement",
    match: (s) => s.startsWith("@arcade/kit/props/"),
  },
  {
    area: "`look` & `gpu/look-shaders`",
    description: "`LookSettings` presets and WGSL scene/post grading hooks",
    match: (s) =>
      s === "@arcade/kit/look" ||
      s === "@arcade/kit/gpu/look" ||
      s === "@arcade/kit/gpu/look-shaders",
  },
  {
    area: "`gpu/post/camcorder`",
    description: "Opt-in Camera filter final pass (iPhone, VHS, CRT TV, body cam) on `Renderer.setFinalPass`",
    match: (s) => s === "@arcade/kit/gpu/post/camcorder",
  },
  {
    area: "`gpu-perf`, `fx/frame-timer` & `quality`",
    description: "Rolling p50/p95/FPS `PerfSampler`, GPU pass timestamp telemetry and adaptive quality tiers (`GameQuality`)",
    match: (s) =>
      s === "@arcade/kit/gpu-perf" || s === "@arcade/kit/fx/frame-timer" || s === "@arcade/kit/quality" || s === "@arcade/kit/client/quality",
  },
  {
    area: "`fx/{particles,particle-renderer}`",
    description: "Fixed typed-array particle pool, `Emitter`, and billboard/spark/debris pass",
    match: (s) =>
      s === "@arcade/kit/fx" ||
      s === "@arcade/kit/fx/particles" ||
      s === "@arcade/kit/fx/particle-renderer",
  },
  {
    area: "`fx/{volume*,smoke-trail,tyre-renderer}`",
    description: "Flood-fill volumetric smoke and continuous ribbon tyre trails",
    match: (s) =>
      s === "@arcade/kit/fx/volume" ||
      s === "@arcade/kit/fx/volume-renderer" ||
      s === "@arcade/kit/fx/volume-settings" ||
      s === "@arcade/kit/fx/volume-shader" ||
      s === "@arcade/kit/fx/smoke-trail" ||
      s === "@arcade/kit/fx/tyre-renderer",
  },
  {
    area: "`fx/{explosion,projectile-trail,fire-water,splatter*}`",
    description: "Multi-stage explosions with trailing fragments and water splashes, fire/water jets, and surface blood decals",
    match: (s) =>
      s === "@arcade/kit/fx/explosion" ||
      s === "@arcade/kit/fx/projectile-trail" ||
      s === "@arcade/kit/fx/fire-water" ||
      s === "@arcade/kit/fx/fire-water-shader" ||
      s === "@arcade/kit/fx/splatter" ||
      s === "@arcade/kit/fx/splatter-renderer" ||
      s === "@arcade/kit/fx/splatter-surfaces",
  },
  {
    area: "`rig` & `human-*`",
    description: "Shared human skeleton, planted-foot gait, shamble, IK, detachment, pose-diff",
    match: (s) =>
      s === "@arcade/kit/rig" ||
      s.startsWith("@arcade/kit/human-") ||
      s === "@arcade/kit/shamble-crouch" ||
      s === "@arcade/kit/pose-diff",
  },
  {
    area: "`avatar/*`",
    description: "Top-down human avatar adapter: soldier, wizard, zombie and skeleton meshes, weapon clips, ragdolls (soldier and any 15-bone figure), hit-reaction springs",
    match: (s) => s.startsWith("@arcade/kit/avatar/"),
  },
  {
    area: "`vehicle/*`",
    description: "Presentation chassis pose, lamps, tyre emissions, and drivetrain/nitro synth",
    match: (s) => s.startsWith("@arcade/kit/vehicle/"),
  },
  {
    area: "`client/{controls,key-cap,action-glyphs,chat.css}`",
    description: "Physical `KeyboardEvent.code` bindings, QWERTY labels, key-cap UI, prompt action glyphs, and chat styling",
    match: (s) =>
      s === "@arcade/kit/client/controls" ||
      s === "@arcade/kit/client/key-cap" ||
      s === "@arcade/kit/client/action-glyphs" ||
      s === "@arcade/kit/client/chat.css",
  },
  {
    area: "`client/{input,camera,side-camera,smooth}` & `orbit-gestures`",
    description: "Top-down `Input`, `Camera` (trauma² shake, directional kick, `HitStop`), rig-agnostic `TraumaShake`, side-view `SideCamera`, and orbit/pan/zoom gestures",
    match: (s) =>
      s === "@arcade/kit/client/input" ||
      s === "@arcade/kit/client/camera" ||
      s === "@arcade/kit/client/side-camera" ||
      s === "@arcade/kit/client/smooth" ||
      s === "@arcade/kit/orbit-gestures",
  },
  {
    area: "`audio/*`",
    description: "Web Audio runtime, offline renderer, procedural synth, and `sfx-library`",
    match: (s) => s === "@arcade/kit/audio" || s.startsWith("@arcade/kit/audio/"),
  },
  {
    area: "`sky/*`",
    description: "Lazy catalogue stars, HDR night sky, textured Moon, astronomical clock and lunar illuminance",
    match: (s) => s.startsWith("@arcade/kit/sky/"),
  },
  {
    area: "`weather/*`",
    description: "Continuous-phase weather sim, wet-surface WGSL, and rain/snow/splash pass",
    match: (s) => s === "@arcade/kit/weather" || s.startsWith("@arcade/kit/weather/"),
  },
  {
    area: "`shell`",
    description: "The player-facing game shell: settings (volume, mute, quality, reduce motion, key labels), title and lobby, Escape menu, leave warning and loading ([game-shell.md](game-shell.md))",
    match: (s) => s === "@arcade/kit/shell" || s.startsWith("@arcade/kit/shell/"),
  },
  {
    area: "`lab-panel` & `@arcade/knobs`",
    description: "Backquote debug overlay and Lab Inspector drawn by `packages/knobs`",
    match: (s) =>
      s === "@arcade/kit/lab-panel" ||
      s === "@arcade/kit/lab-knobs" ||
      s === "@arcade/kit/lab-navigation" ||
      s === "@arcade/kit/lab-tuning" ||
      s === "@arcade/knobs",
  },
  {
    area: "`ramps` & `ramp-table`",
    description: "Gradient and curve settings kept as JSON text, baked into lookup tables for per-frame reads",
    match: (s) => s === "@arcade/kit/ramps" || s === "@arcade/kit/ramp-table",
  },
  {
    area: "`lab/*` & `compare`",
    description: "Lab workbench, sections, adapters, A/B compare, variation grid, and stations",
    match: (s) =>
      s.startsWith("@arcade/kit/lab/") ||
      s === "@arcade/kit/lab-url" ||
      s === "@arcade/kit/compare" ||
      s === "@arcade/kit/compare.css" ||
      s === "@arcade/kit/getaway-main-hook",
  },
  {
    area: "`dev-control`, `lab-commands` & `dev-hub`",
    description: "`LabCommandRegistry`, `/__arcade/control` bridge, `arcade` CLI, tours, and Dev Hub",
    match: (s) =>
      s === "@arcade/kit/dev-control" ||
      s.startsWith("@arcade/kit/dev-control/") ||
      s === "@arcade/kit/lab-commands" ||
      s === "@arcade/kit/dev-hub" ||
      s === "@arcade/kit/dev-hub.css" ||
      s.startsWith("@arcade/kit/dev-hub-"),
  },
]

function walkTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".wrangler") continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...walkTsFiles(full))
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      if (full.endsWith("/games/blackout/src/lab.ts") || full.endsWith("/games/getaway/src/lab.ts") || full.endsWith("/games/outbreak/src/lab.ts")) {
        continue
      }
      out.push(full)
    }
  }
  return out
}

function listRepoTsFiles(root: string, relDir: string): string[] {
  if (existsSync(join(root, ".git"))) {
    const res = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "--", relDir], {
      cwd: root,
      encoding: "utf8",
    })
    if (res.status === 0 && res.stdout) {
      return res.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.endsWith(".ts") && !line.endsWith(".test.ts"))
        .map((line) => resolve(root, line))
        .filter((full) => existsSync(full))
    }
  }
  return walkTsFiles(resolve(root, relDir))
}

export function collectGameSharedImports(repoRoot: string): Record<ArchitectureGameId, Set<string>> {
  const root = resolve(repoRoot)
  const kitRoot = resolve(root, "packages/kit")
  const result = {} as Record<ArchitectureGameId, Set<string>>

  for (const game of ARCHITECTURE_GAMES) {
    const specs = new Set<string>()
    for (const relDir of game.dirs) {
      for (const file of listRepoTsFiles(root, relDir)) {
        const src = readFileSync(file, "utf8")
        for (const match of src.matchAll(/from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g)) {
          const raw = match[1] ?? match[2]
          if (!raw) continue
          if (raw === "@arcade/knobs" || raw.startsWith("@arcade/knobs/")) {
            specs.add("@arcade/knobs")
          } else if (raw.startsWith("@arcade/kit")) {
            specs.add(raw.replace(/\/index$/, ""))
          } else if (raw.startsWith(".") && file.startsWith(kitRoot)) {
            const target = resolve(dirname(file), raw)
            if (target.startsWith(kitRoot)) {
              const sub = target
                .slice(kitRoot.length + 1)
                .replace(/\.ts$/, "")
                .replace(/\/index$/, "")
              specs.add(`@arcade/kit/${sub}`)
            }
          }
        }
      }
    }
    if (specs.has("@arcade/kit/gpu/renderer")) {
      for (const extra of RENDERER_TRANSITIVE_SPECS) specs.add(extra)
    }
    if (specs.has("@arcade/kit/lab-panel")) {
      for (const extra of LAB_PANEL_TRANSITIVE_SPECS) specs.add(extra)
    }
    result[game.id] = specs
  }

  return result
}

export function findUnclassifiedSharedImports(
  gameImports: Record<ArchitectureGameId, Set<string>>,
): string[] {
  const unclassified = new Set<string>()
  for (const specs of Object.values(gameImports)) {
    for (const spec of specs) {
      if (!ARCHITECTURE_MAP_ROWS.some((row) => row.match(spec))) {
        unclassified.add(spec)
      }
    }
  }
  return [...unclassified].sort()
}

export function buildArchitectureMapTable(repoRoot: string): string {
  const gameImports = collectGameSharedImports(repoRoot)
  const headers = [
    "Shared module (`@arcade/kit` / `@arcade/knobs`)",
    "Responsibility",
    ...ARCHITECTURE_GAMES.map((g) => g.label),
  ]
  const align = [":---", ":---", ...ARCHITECTURE_GAMES.map(() => ":---:")]
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${align.join(" | ")} |`,
  ]

  for (const row of ARCHITECTURE_MAP_ROWS) {
    const cells = ARCHITECTURE_GAMES.map((game) =>
      [...gameImports[game.id]].some((spec) => row.match(spec)) ? "Yes" : "—",
    )
    lines.push(`| ${row.area} | ${row.description} | ${cells.join(" | ")} |`)
  }

  return lines.join("\n")
}

export function replaceArchitectureMapBlock(markdown: string, table: string): string {
  const startIdx = markdown.indexOf(ARCHITECTURE_MAP_START)
  const endIdx = markdown.indexOf(ARCHITECTURE_MAP_END)
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `docs/architecture.md must contain ${ARCHITECTURE_MAP_START} and ${ARCHITECTURE_MAP_END} markers`,
    )
  }
  const before = markdown.slice(0, startIdx + ARCHITECTURE_MAP_START.length)
  const after = markdown.slice(endIdx)
  return `${before}\n\n${table}\n\n${after}`
}
