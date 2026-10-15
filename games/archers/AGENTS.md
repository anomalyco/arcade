# archers

- Unlisted prototype: side-view arena archery (TowerFall-like) in the Noir Silhouette look picked on board card
  AR-39 (decision D-24, option 2; concept in `~/code/home/artifacts/2026-10-15-arena-archers/`). The working name lives
  only in `GAME` (`shared/config.ts`); rename there.
- `shared/` is the deterministic 60 Hz sim: `world.ts` (platforming, arrows, catches, stomps, chests, rounds),
  `arena.ts` (wrapping tile maps), `nav.ts` + `bots.ts` (nav graph built by replaying real movement, bot brains),
  `tuning.ts`, `input.ts` (one byte of held buttons per archer per tick). All state is plain data in `SimState`
  (bot minds included) so rollback can `structuredClone` it; only + − × ÷ and sqrt touch it, never trig.
- `src/render/` is a game-side renderer built for side view (the kit's top-down Renderer doesn't fit): fog backdrop,
  static silhouette layers, instanced parts, 4× MSAA HDR plus a shaft-source target, half-res god rays from the
  tower window, screen-space silhouette rim, kit bloom, kit particles and the kit `noir_silhouette` look grade.
  HDR alpha is the colour-retention mask: fire, arrows, marks and scarves write it so the grade keeps their colour.
- `src/game/archer-pose.ts`: ground locomotion is kit `animate()` (unarmed) in a private rig-space lane; air, wall
  slide, ledge hang and dodge poses are built with the rig's IK and blended in; the bow arms layer on top. Read
  `docs/animation.md` and use the procedural-animation-iteration skill before changing poses.
- Camera is kit `SideCamera` (`packages/kit/client/side-camera.ts`).
- Controls (`src/game/controls.ts`): one keyboard player gets WASD/arrows with Space/J/Z jump, Shift/K/X shoot,
  E/L/C dodge. Enter splits the keyboard (left WASD+Space/Shift/E, right IJKL+M/Semicolon/O). Gamepads join with A.
- URL params (automation only): `?watch` (four bots), `&seed=N`, `&arena=cloister`, `&focus=a0&span=4` (close-up
  camera on one archer). `window.archers` is the client Game. Keys 1/2 switch arena locally.
- `bun run dev` runs Wrangler (:8792) and Vite (:5198). `bun run check` before pushing; pushing to `main` deploys
  https://anoma.ly/arcade/archers/.
- Captures: `bun scripts/capture.ts --query "watch&seed=3" --shots 2,5,9 --out captures/x` (or `--video 20`) against
  a built `dist`; run it through `hivemind run --kind browser`.
