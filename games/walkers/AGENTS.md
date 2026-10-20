# walkers

- Unlisted prototype: 2D physics creatures (biped, quadruped, inchworm) that learn to cross a room, get over low
  walls, climb steps or cross rough ground. Training runs live in the browser with OpenAI-style evolution strategies
  on Web Workers; the page also ships pre-trained policies from the headless Bun trainer to compare against.
- Canvas 2D side view, no WebGPU and no sound: it is a sim toy, so of the kit's feel defaults it uses only the
  `LabPanel` (all settings, `capture: "focus"` so the page's keys still work while it is open) and key caps.
- `shared/` is pure and runs unchanged in the page, its workers and Bun:
  - `physics.ts`: minimal sequential-impulse rigid bodies. Capsules, revolute joints (warm-started point constraint,
    speculative angle limits, direct torque motors), contacts against a terrain polyline (capsule ends vs segments,
    convex corners vs capsule cores). No body-body collision within a creature. Fixed 1/120 s substeps, 8 iterations.
  - `fmath.ts`: sin, cos, exp and tanh from IEEE-exact arithmetic only. Math.sin and friends differ in the last bit
    between V8, JavaScriptCore and SpiderMonkey and the sim is chaotic, so everything the sim and policy evaluate goes
    through these. That is what makes a Bun-trained policy replay bit-identically in Chrome or Safari. Never use
    Math.sin/cos/exp/tanh/atan2/pow in `shared/` sim or policy code; `+ - * /`, `Math.sqrt`, `abs`, `min`, `max`,
    `floor` and `round` are safe.
  - `creatures.ts` (morphologies as data), `tasks.ts` (terrain polylines), `episode.ts` (observation, control at
    60 Hz, reward, falls), `policy.ts` (MLP, tanh, flat Float64Array params), `es.ts` (antithetic sampling, centred
    ranks, Adam), `trainer.ts` (generation loop, history, best policy, `WorkerPool`, JSON policy format).
- Reward ≈ metres of forward torso travel + small upright bonus − effort; a fall (torso or thigh touching the ground,
  or too much tilt) ends the run with a penalty; crossing the goal ends it with a bonus per second left.
- Headless training: `bun scripts/train.ts --creature biped --task room --gens 2000 --workers 4 --out x.json`.
  `bun scripts/strip.ts x.json` draws a run as an onion-skin SVG (`resvg` turns it into a PNG) to check a gait
  without a browser. `bun scripts/pretrain.ts` regenerates every `src/pretrained/<creature>-<task>.json`; any change to
  physics, creatures, observations or reward needs it (the pretrained test checks each file replays to its exact
  recorded score).
- Measured on the Studio (Bun, 4 workers): the quadruped and inchworm cross the room in ~200 generations (~10 M sim
  steps, ~10 s); the biped learns to run across it in ~1200 generations (~50 M steps, ~30 s). The browser is a
  little slower per worker.
- URL params (automation only): `?creature=`, `?task=`, `?speed=`, `?ghosts=`, `?workers=`, `?seed=`,
  `?autostart=0`, `?compare=0`, `?panel=0`. `window.walkers` exposes settings, the trainer and history.
- `bun run check` (tsc, server tsc, tests, build); CI also smoke-loads the bundle. Pushing to `main` deploys
  https://anoma.ly/arcade/walkers/.
