# Lot

- Unlisted first-person night exterior, `/arcade/lot/`. WebGPU through `@arcade/kit`, no Three.js runtime.
- `src/world.ts`: deterministic layout and shared pine meshes. `src/shaders.ts`: lot materials, analytical wet reflections and flashlight. `src/settings.ts`: typed live Night presets, bound to LabPanel.
- WASD/arrow keys, pointer-lock mouse look, Shift sprint, F flashlight, Backquote Night panel. No audio.
- Original-source downloads and normalization: `bun run fetch-assets`. Attribution and exact scope in `public/CREDITS.md`; mirrored source licence metadata in `public/assets/source-metadata.json`.
- `bun run check`: TypeScript, focused geometry/import tests, production build. Assets are checked in, so checks do not fetch them.
- Match comparison camera at `[-26, 1.7, 114]`, yaw `-0.65`, pitch `0.1`, FOV `68°`. `window.lot` exposes camera, settings and frame count for automation.
- Wet reflections are analytical emitter/sky reflections, not SSR. Flashlight is an unshadowed 3D cone. Static imported mesh adapter does not implement skins, animations, clearcoat or emissive maps.
