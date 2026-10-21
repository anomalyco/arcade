# Night Shift ’87

- Unlisted first-person cubicle office at `/arcade/nightshift/`, rendered with `@arcade/kit`. Keep `noindex` and omit a landing panel.
- `src/world.ts` owns metre-scale procedural geometry, colliders and the wide/phone comparison cameras. Eye height is 1.65 m and vertical FOV is 68°.
- `src/shaders.ts` composes physical lighting, spot-map shadows, analytic blind gobos, procedural surface recipes and shared fog. Derivatives belong at fragment entry, before divergent material branches.
- `src/settings.ts` exposes lighting, air, movement, audio and handset travel through the shared Backquote panel.
- `shared/call.ts` owns ringing → pickup → call → hangup → ended. `src/audio.ts` synthesizes spatial bells, ballast hum and an indistinct placeholder voice. Dialogue is subtitled.
- Physical WASD/arrows move, mouse looks after a click, E answers/hangs up, F toggles the torch, M mutes. Audio starts only after a canvas click and is muted while unfocused.
- `bun run check` runs TypeScript, local import-cycle detection, focused tests and a production build. `bun run check:shaders` validates all three generated shaders with Naga.
- `scripts/capture.ts --input` runs headless and muted through HiveMind, captures the two cameras, and checks pickup/hangup, physical Dvorak movement, flashlight and panel ownership. Use `--fetch captures/nightshift` to retrieve its output.
- `scripts/compare.py` produces a two-view concept/capture sheet, 4× difference images, RGB MAE, linear luminance, hue, histograms and an 8×6 grid. The concepts and scene are not pixel-registered; metrics describe differences rather than perceptual similarity.
- Original geometry, procedural materials and synthesized sounds are credited in `public/CREDITS.md`.
