# walkers

- Unlisted prototype: 2D physics creatures (human, biped, quadruped, inchworm) that learn to cross a room, get over low
  walls, climb steps, cross rough ground, run a seeded obstacle course, or (the quadruped) pull off a heist: in through
  a vent, past lasers and a camera, grab the gem, out the exit. The page opens on the heist. Training runs live in the browser with OpenAI-style evolution strategies
  on Web Workers; the page also ships pre-trained policies from the headless Bun trainer to compare against.
- Canvas 2D side view, no WebGPU and no sound: it is a sim toy, so of the kit's feel defaults it uses only the
  `LabPanel` (all settings, `capture: "focus"` so the page's keys still work while it is open) and key caps.
- `shared/` is pure and runs unchanged in the page, its workers and Bun:
  - `physics.ts` (SIM_VERSION 2): sequential-impulse rigid bodies. Capsules and (slightly rounded) boxes; static
    one-sided segments (the floor polyline plus solid blocks such as ceilings and vents); kinematic bodies on a sine
    drive (moving platforms); revolute joints, also pinned to the world (seesaws). Contacts are vertex-vs-shape
    (capsule ends and box corners against segments and other bodies, static corners against bodies), warm-started by
    feature key, speculative, with per-body friction (geometric mean). Penetration and joint drift are fixed by split
    impulses (pseudo-velocities that never feed back into velocity). Motors are PD velocity motors with a torque and
    speed limit: the policy sets a target angle; passive "spring" joints (ankles, tail) use the same motor with a
    fixed target. Bodies of one creature never collide with each other. Fixed 1/120 s substeps, 12 velocity and 4
    position iterations. Motor gain matters: kp 14 with 10 iterations self-oscillated (the standing quadruped crept
    backwards 0.37 m in 15 s, paws skating at 0.5 m/s); kp 8 with 12 iterations stands dead still for a minute.
  - `fmath.ts`: sin, cos, exp and tanh from IEEE-exact arithmetic only. Math.sin and friends differ in the last bit
    between V8, JavaScriptCore and SpiderMonkey and the sim is chaotic, so everything the sim and policy evaluate goes
    through these. That is what makes a Bun-trained policy replay bit-identically in Chrome or Safari. Never use
    Math.sin/cos/exp/tanh/atan2/pow in `shared/` sim or policy code; `+ - * /`, `Math.sqrt`, `abs`, `min`, `max`,
    `floor` and `round` are safe.
  - `creatures.ts` (morphologies as data; the quadruped has chest and hips on an actuated spine, a head on a springy
    neck that carries the gem and ducks under beams (it was a spring until the head kept bobbing into the high beam), a springy tail, and thigh/shin/paw legs with springy ankles and grippy paws),
    `level.ts` (rooms, the seeded course, the heist vault by curriculum stage), `tasks.ts` (task ids and `Env`, the
    level settings a saved policy keeps), `hazards.ts` (beams, cameras, beam contact), `episode.ts` (observation incl.
    whiskers, control at 60 Hz, reward, falls, alarms), `policy.ts` (MLP, tanh, flat Float64Array params), `es.ts` (antithetic sampling, centred
    ranks, Adam), `trainer.ts` (generation loop, history, best policy, `WorkerPool`, JSON policy format).
- Reward ≈ metres of forward torso travel (worth up to 15% more when upright) − effort; a fall (torso or thigh touching the ground,
  or too much tilt) ends the run with a penalty; crossing the goal ends it with a bonus per second left.
- Heist: progress past the gem only counts once it is carried, grabbing it pays 2, the exit needs it and pays 8 / (1 +
  alarms). An alarm is a beam broken (or a camera seeing the torso or head) for 3 control steps in a row: −2 each, plus −4 per
  body-second inside a beam or cone (ramping in from 4 cm off a beam), at most −3 a run. Alarms don't end the run (`maxAlarms` knob).
  What didn't work: an upright bonus per second (v1's; standing still in front of a wall or beam beat walking into
  it, so the v2 quadruped never got over the first 14 cm wall with any seed); ending the run on a trip (the population stood in front of the first beam for 2000 generations,
  since standing still beat walking into it); a solid pedestal (everyone stopped at it; it now stands behind the plane);
  a small floor step in the vault (stalled the population at 15 m); an uncapped in-beam penalty (one fallen
  creature lying in a beam scored −300, and the population kept away from the first beam); alarms on the first frame
  of contact (a back paw flicking through the trip wire for a frame cost the escape, and in 4000+ generations ES
  never held a clean gait under its own noise).
- Heist observation (unified for every task, zero when absent): 7 terrain whiskers and 5 laser whiskers from the
  head, goal dx/dy (gem, then the exit), carrying and plate flags, and the nearest timed hazard (distance, on/off,
  phase as sin/cos, seconds to the next flip). Curriculum: stage 0 walk-through, 1 a trip wire to jump and a high beam
  to duck, 2 a pulsing beam, 3 a sweeping beam and a panning camera, 4 a pressure plate that kills a laser grid. The
  trainer moves up a stage after two generations in a row where the mean policy, or a sixth of the population,
  escapes with no alarm.
- Headless training: `bun scripts/train.ts --creature biped --task room --gens 2000 --workers 4 --out x.json`.
  `bun scripts/strip.ts x.json` draws a run as an onion-skin SVG (`resvg` turns it into a PNG) to check a gait
  without a browser. `bun scripts/pretrain.ts` regenerates every `src/pretrained/<creature>-<task>.json`; any change to
  physics, creatures, observations or reward needs it (the pretrained test checks each file replays to its exact
  recorded score).
- Measured on the Studio (Bun, nice'd, 2–4 workers on a machine at load 30–70, so slow): pre-trained runs took
  3.5–9 min each (biped ~1500–2300 generations / 45–95 M steps; quadruped ~700–950 / 33–48 M; worm ~500–950 /
  22–49 M; the obstacle course 7–13 min, 60–80 M). The quadruped crosses the room in ~75–100 generations (~5 M
  steps). V1 numbers (before physics v2) were
  ~3x faster per step: the v2 quadruped has 16 bodies and runs 12 iterations.
- Heist (measured): from scratch under the final rules the curriculum reaches stage 1 in ~40 generations and stage 2
  in ~400 (~30 M steps, 3.5 min on 6 workers), then the population stalls there: single runs escape clean (fitness
  38.7) but the mean policy keeps ~2 alarms, and in this chaotic sim a step of lr 0.01 flips a clean mean policy to
  falling. The shipped pro thief (`quadruped-heist.json`, stage 4, clean, out in 10.7 s) came out of 8 resumed runs
  while the vault and its rules were being fixed: ~50 min and ~420 M sim steps in all, with the last stage started by
  hand from the best clean stage-3 run.
- Training runs in `shared/train-worker.ts` (a coordinator worker that owns the Trainer and nested eval workers);
  `src/remote-trainer.ts` is the page's proxy. The page only pulls a population when it is about to show one.
- URL params (automation only): `?creature=`, `?task=`, `?speed=`, `?ghosts=`, `?workers=`, `?seed=`, `?course=`,
  `?stage=`, `?curriculum=0`, `?lasers=` (laser speed), `?autostart=0`, `?compare=0`, `?panel=0`. `window.walkers` exposes settings, the trainer and history.
- `bun run check` (tsc, server tsc, tests, build); CI also smoke-loads the bundle. Pushing to `main` deploys
  https://anoma.ly/arcade/walkers/.
- Default tests replay every committed pretrained policy and require bit-identical fitness, distance, duration,
  outcome and alarm count. The human policy is still balance-only. Physics stability windows are three seconds
  (all three flailing seeds remain). Full checks are opt-in, from the repository root:
  - Training improvement and seeded training replay: `HIVEMIND_PIN_FALLBACK_S=3600 hivemind run --kind cargo --worker pro -- bun run --cwd games/walkers test:training`.
  - Original 60-second standing and 30-second × three-seed flailing checks: `HIVEMIND_PIN_FALLBACK_S=3600 hivemind run --kind cargo --worker pro -- bun run --cwd games/walkers test:soak`.

## Human thief

- Human is the default; quadruped remains selectable with its original vault and exact v2 policies.
- `shared/human.ts`: sagittal 1.75 m / 75 kg, Winter mass fractions (head .081, trunk .497 split into chest .32 +
  pelvis .177, upper arms .028 each, combined forearm+hand .022, thighs .10, shins .0465, feet .0145).
  Segment lengths/COMs are rounded approximations; combined forearm/hand is one link. Thirteen capsule bodies,
  eleven muscles plus passive neck. Heel and toe are the two foot-capsule endpoints, not independent toe bones.
- Optional human-only force–velocity motor envelope: shortening reduces available torque to 20% at the speed
  limit, eccentric resistance allows 130%. This is a muscle-like approximation, not a calibrated Hill muscle model.
  Smoothed PD targets are learned, with phase sin/cos and a learned pace input, plus authored ankle/hip balance
  feedback and counter-swing target offsets. No body teleportation, root forces, contact locks or baked animation.
  An initial sinusoidal leg-cycle prior failed; it is not used. Stage zero rewards survival (+.5/s) to bootstrap
  balance; later stages remove it so standing in front of a beam is not rewarded.
- `shared/realism.ts`: loaded heel/toe contacts are normal support. Hand tips/knees may support only with the chest
  lowered in a marked beam/vent zone. Head/chest/pelvis contact is a fall. Illegal support, sliding, excessive lean,
  same-side hops, flight outside a low beam, extreme stride/cadence and mechanical work cost fitness. The Realism
  knob switches to loose scoring; anatomical/muscle limits and head/torso ground falls remain. HUD shows penalties
  and measured gait; chart red ticks mark generations with illegal-contact runs.
- Human vault starts with a 5 m walk-and-hand-grab lesson, then introduces low/high beams, a crawl vent and timed
  beam, sweeper/camera, and plate/grid. Gem grabs use the hand tip (16 cm reach), not head proximity. The gem follows
  that hand; it is a collectible, not an independently simulated rigid body/load.
- `scripts/human-metrics.ts <policy.json> [report.json]` measures debounced landings (cadence, same-foot stride),
  stance duty, loaded-contact tangential slip and absolute mechanical work / (mass × gravity × net distance).
  CoT is undefined below .5 m forward travel; it is not metabolic cost. These measure actual physics, not phase.
- Train only on Pro through HiveMind, 4–6 workers; record failed runs as well as successful ones. Do not call a
  stage-zero policy a completed heist. Curriculum saves each passed stage before moving up.
- One muted headless replay capture: `scripts/capture.ts --replay-only --creature human` against the built game;
  it checks that browser fitness matches the saved headless score. Upload to AR-104 only, never Slack.
- **Training result (Oct20): incomplete.** Three Pro runs, six workers, **24m16s** actual training. The shipped
  human policy balances for30s with .056m drift, no illegal contacts, .9994 duty and .000773m/s slip. It has taken
  no steps; cadence, stride length and CoT are undefined. It has not learned walking, duck/crawl/vault, timed waiting,
  plate pressing, hand pickup or escape. UI says **Balance only**. Two attempts to start the8s walking fine-tune
  were capacity-gated for30min each. The trained quadruped remains the completed heist option.

## Game shell

- The title, Escape menu and Settings are the kit game shell (`@arcade/kit/shell`, [docs/game-shell.md](../../docs/game-shell.md)), set up in `src/main.ts`; shell colours are in `index.html`. Walkers is silent, so it passes `channels: []`: no Sound section, mute button or M key. Every training knob stays in the Lab panel.
- Deliberate changes when it moved onto the shell (Oct 22):
  - The page opens on a WALKERS title card (Watch them learn) over the live sim; training still starts behind it.
  - Escape opens the menu (Resume, Settings, Quit to title). It freezes playback and holds training; Resume picks
    both up where they were. Quit to title lets the sim train on behind the title.
  - Settings has a Playback section (speed, show pre-trained, slow motion on near misses), mirrored in the Lab panel,
    plus the shared Reduce camera motion and Key labels. Walkers has no camera shake, so Reduce camera motion
    changes nothing here.
  - Space, R, B and P are ignored on the title and the menu.
  - After 30 s of watching, closing the tab asks first (the trained brain is lost unless saved).
