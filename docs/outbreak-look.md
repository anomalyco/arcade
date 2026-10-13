# Outbreak look study, 2026-10-13

## Working baseline

Late-20th-century US small-town housing is an **assumption, not an approved era**. These are older,
modest wood-frame houses still occupied in the 1980s, rather than a reconstruction of one place.

- [Littleton's Cook Residence survey](https://www.littletonco.gov/files/sharedassets/public/v/1/building-amp-development/documents-building/historical-preservation/historic-resources/downtown-hist-bldg-surveys-1997/curtice-st/5540-s-curtice-st.pdf)
  records a 1913 vernacular wood-frame residence and porch alteration. It supports the older-house/altered-porch premise.
- [Washington DAHP's Ranch guide](https://dahp.wa.gov/historic-preservation/historic-buildings/architectural-style-guide/ranch)
  dates the type to 1945–1995 and links its illustrated survey. Its web page is unfinished; it does not establish our dimensions.
- [DAHP's Williamsburg Revival guide](https://dahp.wa.gov/historic-preservation/historic-buildings/architectural-style-guide/williamsburg-revival)
  documents side gables, chimneys, clapboard/brick/shingle cladding, wood sash and small covered stoops in older housing.
  Our shallow roof is an art-direction choice, not that style's steep roof.

Authored choices: 2.8 m walls, roughly 4.4 m roof ridges, 18 cm clapboards, charcoal asphalt-shingle finish,
muted ivory/sage siding, brick bases, painted wood trim, gutters/downpipes, and warm practical lamps.
Wear stays in small colour/roughness changes, grass patches and gravel edges. Existing 15 × 14 m house
footprints and road coordinates were retained for comparison; they are larger than the cottage references.

## Screenshot contract and targets

`games/outbreak/scripts/look-proof.ts` captures seed 7 at 1000 × 680, DPR 1, with no crop. It stages the same
short exploration route, positions, camera distances and times in both builds. Before is `cd77303`.

| View | Player x/z | Aim | Hour | Camera distance |
| --- | --- | --- | --- | --- |
| Street | 30 / 41 | −π/2 | 18 | 42 |
| Closed/open bedroom | 27.7 / 31 | −π/2 | 19 | 34 |
| Yard | 20 / 35 | −1.6 | 23 | 42 |

Before defects: opaque vision wedges obscured most scenery; roads had bright polished reflections; houses had
no roofs/porches; grass was flat; trees were stacked primitives; interior light and material detail were sparse.

Three image-edit targets use those real screenshots as inputs. The shared direction is warm porch/window light
against cool dusk, matte surfaces, shallow gables, layered planting, and readable peripheral scenery.
The generated targets are **not exact geometry contracts**: the street target added a deeper yard and parked car;
the interior target moved a partition. A corrective interior pass still changed the cutaway. Those layout changes
were rejected. The comparison retains the first targets and the actual unchanged footprints, so the mismatch is visible.

Private evidence directory: `~/code/home/artifacts/2026-10-13-outbreak-look/`.
Tracked review sheets: [before / target / after](assets/outbreak-look/comparison.jpg) and
[closed door](assets/outbreak-look/closed-comparison.jpg).
`comparison.jpg` is BEFORE / PAINTOVER TARGET / ACTUAL AFTER (1260 × 936); `closed-comparison.jpg` compares the
closed state. `before/` and `after/` contain the full-size real frames and capture metadata. Targets were generated,
but all after geometry, materials and illumination are procedural game output.

## Implementation and visibility

Main's shipped Blackout PR5 was reconciled into `@arcade/kit/gpu`, including its motion history and look variants.
Blackout's default WGSL variants remain equivalent after whitespace normalization. Exploration now occupies binding 8,
leaving binding 7 for motion. Its compatibility paths continue to re-export the shared engine.

Opt-in shared finishes cover turf, asphalt, concrete, gravel, timber, clapboard, brick, shingles and foliage.
Material antialiasing computes the footprint before divergent material branches/discards. The outdoor noise uses
four distinct lattice corners; the legacy noise is retained for Blackout. New material IDs are excluded from its
legacy dust vertex expansion. Outbreak uses the shared dense shadow kernel without a changing jitter pattern,
with reduced bloom, grain and chromatic fringing. These are shader options, not another renderer.

Outbreak owns house/yard generation and its palettes. It adds pitched roofs with occupancy cutaways, porches,
window reveals, gutters, chimneys, modest furniture, clustered tree crowns, shrubs, grass and drive gravel.
Terrain is a seeded metre-grid mesh with exact triangle-interpolated support queries. Paved surfaces and threshold
heights are included in the same support query; the survivor's planted feet and swing targets sample it.

Exterior scenery is lit independently of the eye cone. Static interior rooms are remembered when entered or seen
through a doorway/window; unseen rooms stay subdued. Explored rooms remain readable and become less saturated
outside the cone. **Room memory never grants actor visibility.** `Vision.visible` retains the occluded 110° cone,
2.5 m awareness and door/wall rules. There are no enemies in M1; later actors must be filtered by that query before
submitting their draw, not by the scenery texture.

The Lab exposes time, time scale, overcast, practical-light power, house seed, terrain relief, vision and shroud.
Generation edits preserve player position, clock and door states. Randomization selects from authored palettes.

## Cost

`perf/outbreak-look-paired.json`: one warmup pair plus seven alternating before/after pairs, 120 steps per run,
1000 × 680 on Apple M5 Max / Metal. Player poses match in every pair.

| Metric | Before | After |
| --- | --- | --- |
| Median queue-completed frame span | 2.5 ms | 9.5 ms |
| Range of run medians | 1.9–3.1 ms | 8.3–14.0 ms |
| Static world vertices | 37,014 | 299,238 |
| Sampled allocation bytes / step | 565,965 | 574,627 |

Paired median increase: **6.9 ms**, range 6.0–11.0 ms. This is a visual-quality cost, not a speedup.
Spans include CPU work and GPU queue completion, not hardware GPU timestamps or vsync-limited FPS.
Allocation figures are CDP 4 KiB samples including collected objects and the harness's state snapshots;
they are not exact game-update allocation counts. Higher-DPR and lower-end devices remain unmeasured.

## Remaining gaps

The targets have denser, more natural foliage, finer trim/weathering, richer small objects and more convincing
indirect/directional shadows. The implementation is still visibly procedural and simpler. Sun/moon lighting
shades surfaces but has no directional shadow map; practical lights have polar shadows. Furniture/vegetation are
still visual props. Overcast adjusts sky/direct balance rather than simulating rain. No parked car was added while
shared vehicles/FX integration is pending. The result needs Kit's visual review; target fidelity is not claimed.

## Reproduce

```sh
bun install --frozen-lockfile
sh games/outbreak/scripts/check-workspace.sh
hivemind run --fetch captures/outbreak-look -- bun games/outbreak/scripts/look-proof.ts
hivemind run --fetch captures/outbreak-m1 -- bun games/outbreak/scripts/prove.ts
git archive cd77303 games/outbreak packages/kit package.json bun.lock bunfig.toml \
  games/blackout/package.json games/getaway/package.json > games/outbreak/scripts/.baseline.tar
hivemind run --fetch captures/outbreak-look/cost/paired.json -- bun games/outbreak/scripts/look-cost.ts
python3 games/outbreak/scripts/look-sheet.py
```

Outbreak's 12 tests include mesh repeatability, packed-triangle versus support-height contacts, and strict actor LOS
after static-room discovery. Metal proof exercises actual F/WASD/Dvorak input, Lab input isolation, real regeneration
sliders and a second 720 × 900 viewport, with zero page/WebGPU errors. Getaway: 173 passed, 12 existing skips;
Blackout: 266 passed; shared Lab: 6 passed. All three builds, Worker dry-runs and production smoke gates passed.

The first GitHub Outbreak smoke failed on Linux canvas presentation, despite passing Metal. An isolated Linux
reproduction traced `Instance dropped` to the software compositor's missing WebGPU swapchain backing. The smoke
launcher now enables Vulkan/SwiftShader presentation on Linux; all three production smokes then passed there.
