# Shared surface splatter

The Splatter section runs in both game Labs. Blackout's gameplay panel also exposes the candidate under
Blood → Style, with Current as the default. Blood, ink, slime, oil and potion share the same solver and draw path.
Fire/water studies remain available in their existing section.

## Visual proof

- Matched 1000×720 captures use impact seed 19, room seed 7 and 75 fixed 60 Hz advances (1.25 seconds).
- Forty Lab frames cover two rooms, five targets (floor, wall, grazing wall, desk and glass), two zooms and both styles.
  Five further captures cover every material preset. Four frames show the same comparison through Blackout's HDR,
  lighting, bloom and final composite pipeline. These are current-versus-candidate comparisons in one build.
- Both styles receive the same position and planar direction; Current retains its old particle count, trajectory and
  floor-only behavior. The candidate additionally accepts height, vertical direction and inherited velocity.
- The cropped generated scene retains production wall, glass and desk specimens. The Lab substitutes a uniform tile
  or asphalt floor and uses neutral material shading. Blackout renderer captures retain the generated floor materials.
- Inspected sheet: `2026-10-13-lab-splatter.jpg` (1280×1260), relative to the local artifact root.
  The local preview archive also holds `lab-splatter-sheet.jpg`.

The candidate produces 32 deposits in the floor, wall and desk cases. The straight wall case has 32 wall-normal
deposits; the grazing case has 13. Glass catches all 32 drops and leaves zero deposits. Frame stepping advances
exactly 1/60 s while paused; quarter-speed playback advances 0.25 s for 60 input frames. Both Lab hosts passed Metal
smoke checks with no page or console errors. Source and capture hashes, samples and assertions are in `lab-splatter.json`.

## Whole-frame GPU cost

M2 Max, Apple Metal 3, headless Chromium, 1000×720. Each sample is Blackout's dependent GPU interval through its
offscreen final composite, not a sum of render passes. The display copy and CPU simulation are excluded. One warmup
round precedes nine measured rounds. Each round alternates style order and discards four settling frames before
retaining eight timings per style. The runner uses the upper middle sample as its batch median.

| Scene | Current total, ms | Candidate total, ms | Paired delta, ms | Delta MAD, ms |
| --- | ---: | ---: | ---: | ---: |
| Office | 1.551 | 1.491 | +0.050 | 0.078 |
| Downtown | 1.412 | 1.241 | +0.043 | 0.058 |

Total columns are medians of each style's batch medians. The delta is the median of within-round differences,
which can differ in sign from subtracting the two marginal medians. Noise exceeds both paired deltas. These data
do not establish a speedup or a tight incremental cost. The optional motion-MRT draw also completed without GPU
validation errors. The timing fixture is one settled impact, not maximum-budget spray or many concurrent sources.

## Boundaries

The receiver grid is built lazily for the first opt-in impact and discarded on a map change. That build and its CPU
cost are unmeasured. Static visible meshes supply sealed, absorbent, slick and blocking material classes. Dynamic
vehicles, actors and detached limbs are not receivers; a changed static scene requires rebuilding the system.
Glass blocks without staining. Point sweeps do not account for droplet radius. Dense receivers may exhaust the
12-triangle cap and truncate a deposit. The tint is unlit and matte; there are no scene reflections or wet highlights.

The simulation/upload pools allocate once; map indexing allocates at scene setup. Particle and decal storage each
cap at 256, and the user budget restricts recycling to at most that many slots. Deposits grow within their stored
receiver region, fade, and recycle. The most recent 128 event/limb ID pairs suppress duplicate cosmetic emissions.
Damage, limb detachment and networking are unchanged. `Game.cosmeticSplatter` accepts a stable limb ID plus world
position/direction/velocity for the animation agent; the animation-side detach call is pending.

## Checks and reproduction

Clean `git archive` export of `f24f6f2` plus this patch, frozen root install, then sequential checks on Studio:

- `bun run check:packages`: 11 tests passed.
- Blackout `bun run check`: 272 tests passed; client/server/script types and production build passed.
- Getaway `bun run check`: 184 tests passed, 12 existing skips; types and production build passed.
- Both `bunx --no-install wrangler deploy --dry-run` commands passed. No deployment was performed.
- Five shared tests cover tick-partition determinism, duplicate limb events, thin walls, furniture, glass,
  back-face normals, material response, grazing stretch, budget reduction, expiry and fixed storage.

From `games/blackout`, with the named Nexus Lab preview running:

```sh
LAB_URL=http://fx-kit-blackout.localhost:1355 hivemind run --kind browser --worker pro -- bun scripts/prove-splatter.ts
SPLATTER_QUICK=1 LAB_URL=http://fx-kit-playground.localhost:1355 hivemind run --kind browser --worker pro -- bun scripts/prove-splatter.ts
python3 scripts/splatter-sheet.py "${ARTIFACTS:-captures}/2026-10-13-lab-splatter.jpg"
```

The worker is pinned only because this proof connects to the Pro's named localhost preview. `SPLATTER_OUT` changes
the capture directory; `SPLATTER_ROOM=downtown` selects the quick smoke-check room. Full runs cover both rooms.
