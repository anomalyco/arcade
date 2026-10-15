# Outbreak Style Playground

Nine self-contained WebGPU presentation styles (`games/lab/src/styles/`) rendering the exact same authoritative Outbreak `SessionView` state on a deterministic 450-tick (`7.50 s` at `60 Hz`) single-room combat loop (`StylePlaygroundSim`).

Open the station in the Lab at `/arcade/lab/?station=styles` or run `bun run arcade station styles`:

- **One simulation, nine presentations**: `StylePlaygroundSim` steps a real `LocalSession` (`games/outbreak/shared/session.ts`) once per tick inside the cutaway Ash House room. One survivor fires at three shambling zombies (`spawn → approach → shots → stagger/hitFlash → death collapse → doorway breach wave → pistol reload → repeat`).
- **Minimal people on the shared rig**: `StyleMinimalPeople` (`games/lab/src/styles/minimal-people.ts`) drives four selectable character shapes (`blocky` chunky box figures, `capsule` pill/sphere figures, `pawn` boardgame tokens, and `rig` full Outbreak meshes) from the exact same `BonePose` frames solved by Outbreak's `Survivor` and `ZombieCrowdRenderer`.
- **3×3 synchronized Variation Grid**: Pressing `⊞ Grid` (open by default on the `Styles` station) renders all 9 styles in a 3×3 grid on one timeline, reusing the base room + MRT auxiliary G-buffer (`tNormalDepth`, `tAux`) across all 9 tiles (`1.6–1.8 ms` total wall time). Press `1`–`9` to focus any style full-screen, or `⇧1`–`⇧9` to switch station variants.
- **Per-style Knobs**: `pixelSize`, `palette`, `outlineWidth`, `dither`, `halftoneSize`, `rampSteps`, `fxPunch`, `pixelSnap`, and `peopleStyle` are bound through `LabPanel` / `@arcade/knobs` with deterministic `tuningSeed` randomization.

## Measured GPU Cost & Full-Outbreak Scaling Evaluation

Measured on Apple Silicon Metal (`1536×1024`, `dpr: 1`, `tick = 85` hero gunshot frame, `perf/style-playground.json`):

| # | Style | Module | Style Pass GPU (median ± MAD) | Scales to Full Outbreak? | What It Would Take / Why It Fails |
| --- | --- | --- | --- | --- | --- |
| 1 | **Tiny Pixel Art** | `tiny-pixel.ts` | `0.71 ± 0.00 ms` | **Scales** | Route the main scene pass to a true `96–160p` offscreen target (cutting fragment ALU by ~85%), snap camera pan to `1 / pixelSize` world increments, and draw HUD/key-caps at native resolution. |
| 2 | **Game Boy 1-Bit** | `one-bit.ts` | `0.33 ± 0.00 ms` | **Partial** | Works well inside lit rooms, but across a 96×96 m town with dense foliage and dark streets, 2–4 shade ordered Bayer dithering merges small loot items and distant zombies into background dither noise unless material classes use distinct hatch patterns and interactive props get 1-bit icon callouts. |
| 3 | **Comic Book Cel** | `comic-cel.ts` | `0.52 ± 0.00 ms` | **Scales** | Best candidate for a full-game stylized mode: bold India-ink depth/normal outlines and 3-step toon ramps make top-down silhouettes and sight cones immediately readable at 42 m gameplay zoom. Needs only the normal/depth edge pass in `Renderer` and world-projected starburst decals on `CombatShotEvent`. |
| 4 | **Papercraft Low-Poly** | `papercraft.ts` | `0.48 ± 0.01 ms` | **Scales** | Fits Outbreak's 24-byte procedural `Mesh.box` / `bevelBox` architecture naturally. Suppress high-frequency procedural surface noise, bake per-vertex crease AO into `v.color.a`, and add cut-paper drop shadows in the composite pass. |
| 5 | **Ink Sketch Hatch** | `ink-hatch.ts` | `0.55 ± 0.02 ms` | **Partial** | Fast on GPU and striking in stills, but screen-space hatch strokes swim ("shower-door effect") during fast top-down camera pans and invert day/night readability (dark night rooms become bright cream paper). Requires world-locked triplanar hatch UVs (`world.xz`, `world.y`). |
| 6 | **Watercolour Wash** | `watercolour.ts` | `0.68 ± 0.00 ms` | **Scales** | Extends the existing `Painterly` Kuwahara look in `@arcade/kit/gpu/look-shaders.ts` by adding wet-edge pigment-ring darkening (`colorGrad` cauliflower bleed) and world-locked cold-press cotton paper granulation. |
| 7 | **Tactical Breach** | `tactical-breach.ts` | `0.32 ± 0.00 ms` | **Scales** | Lowest-cost overlay (`0.32 ms`): the 1 m world floor grid, cyan player tile, amber zombie threat tiles, and shot trajectory telegraphs read directly from `SessionView` coordinates and could ship as a tactical HUD/visor toggle in full Outbreak. |
| 8 | **Hotline Neon** | `hotline-neon.ts` | `0.45 ± 0.00 ms` | **Scales** | Polar light pools and `Vision` sight cones naturally gate the neon floor grid and magenta/cyan edge rims, turning night combat into a high-contrast synthwave arcade mode with zero geometry changes. |
| 9 | **ASCII Terminal** | `ascii-terminal.ts` | `0.34 ± 0.00 ms` | **Fails** | Fun in a single close-up room (`54` rows of `5×7` glyph cells), but fails at full Outbreak gameplay zoom (`36–42 m` camera distance): a 5×7 character cell covers ~0.75 m of world space, making thin doors, window mullions, barricades, and diagonal aiming unreadable without a pure 2D tile-map camera. |
