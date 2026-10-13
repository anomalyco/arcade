# Getaway chassis

The Chassis lab group has four independent switches: Suspension springs, Per-wheel contact, Steer & spin wheels,
and Vehicle-specific feel. They default on. Turning all four off uses the original complete car meshes and the
original roll, pitch, kerb-hop and landing transforms. Shared simulation, protocol and server files are unchanged.

`games/getaway/src/game/chassis.ts` filters interpolated velocity over 85 ms and acceleration over 65 ms. Its exact
underdamped spring solution uses 14 rad/s and damping ratio 0.52 by default. Vehicle feel varies frequency from
12 to 16 rad/s and scales sway with mass; bikes lean inward. Disabling Suspension springs restores first-order
acceleration response even with Vehicle-specific feel enabled. Contact tilt still has its own spring.

Wheel contacts use the model's actual axle positions, the rounded sidewalk footprint and shared `rampSurface`.
Grounded body lift subtracts the existing centre-ramp height before applying the contact correction. In flight,
wheels follow the body's attitude; landing counters trigger one compression impulse. The wheel meshes reuse the
original tire geometry and add three spokes. Left/right meshes are instanced across axles and roof-number variants.
Spin precedes steer and bank, so a leaning bike's axle stays fixed through a revolution.

## Evidence

The silent headless Chromium run used Apple `metal-3` on the Mac Studio. A separate short Metal probe also loaded
the named Nexus preview successfully. The six seeded fixtures cover launch, braking, a corner, one-sided kerb
contact, a shared-simulation ramp landing and countersteer. All 432 off/on car poses matched exactly. The ramp run
reached 3.155 m and landed once. The fixture uses the real vehicle integrator with empty collision boxes to isolate
chassis motion; its road positions keep the corner and drift in the intersection.

The 1350×1300 sheet is `captures/preview/getaway-chassis-sheet.jpg`. The silent 720×1280 phone clip is
`captures/preview/getaway-chassis-phone.mp4`, with off above on, 14.4 seconds, H.264 Main/yuv420p, 5.05 MB.
The local preview is `http://getaway-chassis.localhost:1355/?solo&peaceful=1&seed=7&lab=1`.

Lamp attachment follow-up: `bodyPoint(car, { height, roll, pitch }, [x, y, z])` in `src/game/car-pose.ts` maps each
lamp through the body shader's rotation order. It returns a world-space `[x, y, z]`; `car` only needs `x`, `z`, `h`.
Head/tail/siren glow sprites and light origins share this helper. Spot direction follows two transformed points,
while ground-light pools remain on the road. The `--lamps` proof checks the submitted lamp positions against the
packed body instance pose, with a maximum 0.000007 m error over 288 braking/kerb frames. Cruiser and SWAT sirens
also passed 40-frame checks. Three helper tests cover rotation order, dive/roll and rigid lamp spacing.
`captures/preview/getaway-chassis-lamps-sheet.jpg` and `getaway-chassis-lamps-phone.mp4` show the close-ups;
the clip is 720×1280, 4.8 seconds and 1.75 MB. Generate them with `clip --lamps` and `chassis-media.py --lamps`.
`bun run check` passed 121 tests with 12 existing skips after this follow-up. Its added transform cost is unmeasured.

Reproduce from `games/getaway`:

```sh
bun scripts/prove-chassis.ts clip
bun scripts/prove-chassis.ts perf
bun scripts/prove-chassis.ts perf-wheels
python3 scripts/chassis-media.py  # Pillow and ffmpeg required
```

`--fixture` runs a bounded isolated Vite fixture for a remote proof worker. Raw frame states and captures go to
`captures/getaway-chassis/`. The media script verifies pose agreement before composing the off/on pairs.

Twelve chassis tests cover spring overshoot, large-dt stability, impulse response, terrain contacts, ramp pitch
without double-height, vehicle differences, snapshot filtering, wheel geometry, countersteer/lockup and fixed
wheel axes. These are presentation checks; Kit's live driving review is still pending.

## Cost

The benchmark places 28 cars from all seven specs near the camera. It alternates off/on order, discards one warmup
pair and keeps seven measured pairs of 20 rendered frames. CPU-only chassis batches run 1,000 frames per sample.
GPU times are a single first-pass-begin to last-pass-end hardware timestamp interval, never a sum of pass intervals.

| Measurement | Off median | On median | Median paired delta | Paired delta range |
|---|---:|---:|---:|---:|
| Chassis update, 28 cars | 0.022 ms | 0.085 ms | +0.063 ms | +0.061…+0.069 ms |
| Full scene CPU, all four switches | 0.360 ms | 0.485 ms | +0.115 ms | −0.015…+0.145 ms |
| Wheel-only full scene CPU | 0.440 ms | 0.470 ms | +0.050 ms | −0.040…+0.110 ms |
| Wheel-only GPU interval | 2.314 ms | 2.721 ms | +0.601 ms | −1.525…+1.329 ms |

GPU noise exceeds the apparent wheel cost, so the precise GPU overhead remains unresolved. The all-four GPU series
also crossed zero widely and does not establish a saving. Both raw series are retained in
`getaway-chassis-perf.json` and `getaway-chassis-perf-wheels.json`.

The wheel split adds 104 wheel instances for the 28 cars (four bikes have two wheels). Including 20 nearby parked
cars, model instances rise from 48 to 152. Submitted draws across all passes rise from 63 to 110, an extra 47 draws;
submitted instance executions rise from 1,033 to 1,345. No extra lighting, texture or shadow pass is added.
