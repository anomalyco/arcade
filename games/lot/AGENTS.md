# Lot

- Unlisted first-person night exterior, `/arcade/lot/`. WebGPU through `@arcade/kit`, no Three.js runtime.
- `src/world.ts`: baked Ashwood exterior geometry and title camera. `src/shaders.ts`: lot materials, analytical wet reflections and flashlight. `src/settings.ts`: typed live Night presets, bound to LabPanel.
- WASD/arrow keys, pointer-lock mouse look, Shift sprint, F flashlight, Backquote Night panel. No audio.
- Original-source downloads and normalization: `bun run fetch-assets`. Attribution and exact scope in `public/CREDITS.md`; mirrored source licence metadata in `public/assets/source-metadata.json`.
- `bun run check`: TypeScript, focused geometry/import tests, production build. Assets are checked in, so checks do not fetch them.
- Comparison uses Ashwood's home drift at a fixed time, FOV `68°`, near `0.15`, and `1920×1080`. The source screenshot did not record its drift clock; `START` records our chosen time. `window.lot` exposes camera, settings and frame count for automation.
- `scripts/import-ashwood.ts <afterhours-project>` reads the source checkout without modifying it. Three.js is build-time only; exported native kit buffers and the DOM-free atlas painter live in `public/ashwood/`, with source hashes in `scene.json`.
- `scripts/capture.ts` runs headless and muted through HiveMind. `scripts/compare.py` records display-RGB error, linear luminance, hue, histograms and an 8×6 grid against the saved reference, plus side-by-side and difference images.
- Wet reflections are analytical emitter/sky reflections, not SSR. Flashlight is an unshadowed 3D cone. Static imported mesh adapter does not implement skins, animations, clearcoat or emissive maps.
