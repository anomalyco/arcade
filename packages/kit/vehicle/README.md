# Vehicle presentation

Getaway and Blackout use these modules for suspension, wheel contacts, lamps, tyre emissions and procedural sound. The package reads interpolated views and never writes a game's simulation state.

Import the source subpaths through the workspace package, for example `@arcade/kit/vehicle/chassis` or
`@arcade/kit/vehicle/audio/synth`. Install dependencies once at the repository root with `bun install --frozen-lockfile`.

## Adapt the view and renderer

`types.ts` defines the input contracts. Positions use metres, velocity uses metres per second, mass uses tonnes, and angles use radians. World Y is up; local Z is forward and X is right. Heading zero faces +Z. `VehicleSpec` supplies dimensions, drivetrain, power, lamp mounts and optional authored wheel positions. `Controls` carries throttle, brake, steer, handbrake and boost.

- `Chassis` accepts wheel hubs and a ground-height callback. Its contacts contain wheel position, spin and orientation; its springs contain body roll, pitch and lift.
- `bodyPoint` transforms attachments with the same roll/pitch/yaw order as the body. Pass the complete rendered height, including ground and springs.
- `drawLamps` writes through `SpriteSink` and `LightSink`. Pass the camera eye and ground-height callback so glows follow the body while pools stay on the ground. `LightSettings` and `lightControls` expose the shipped values in the shared Lab.
- `VehicleEmissions` consumes one persistent `EmissionState` per vehicle. Its terrain callback returns whether the tyre can emit on the current surface. Assign a `SkidSink`, call `update` once per frame, then `car` once per vehicle. The same per-wheel slip drives heat, smoke and skids. Its `pops` counter lets the game schedule the corresponding audio event.
- `DriverVoice` takes an `AudioBus` with a context, scheduling clock, dry output and reverb send. The game owns unlock, mute, attenuation and voice selection. `Gearbox`, `EngineVoice`, `Transients` and `NitroGate` are also available separately. The context may be an `OfflineAudioContext`.

Getaway's adapters remain at its existing import paths. They supply the city kerb/ramp profile and lawn mask. Blackout's `src/game/vehicle-presentation.ts` converts its +X-forward meshes, heading convention and kilograms. It converts the full rotation basis before submitting instances, so combined banking and pitch keep lamps on the body. Blackout's collision terrain is flat; its decorative kerbs do not introduce new driveable heights.

Each game keeps its own vehicle meshes, material palette, gameplay physics, sirens, damage smoke and wrecks. Blackout retains its horn, door, starter and crash recordings. Its audio adapter limits detailed vehicle voices to four and applies distance filtering outside the shared voice.

## Render the packed effects

`Fx.emit` and `VehicleEmissions.emit` write 12 floats per sprite:

```
x y z size | red green blue alpha | kind rotation stretch extra
```

Kinds used here are 0 (glow), 4 (skid), 6 (spark), 10 (wisp), 13 (attached flame), 14 (beam), 15 (lens), 16 (flare), 17 (brake streak), 18 (soft beam), and 19 (road pool). Blackout reserves kinds 32–51 and subtracts 32 when calling the binding-free helpers in `sprites.ts`. Both games use `SmokeRenderer` for the same noise-lit, advected billows in one shadowless draw. The renderer accepts the game's common shader declarations, spotlight attenuation and depth format; Getaway's defaults preserve its shipped shader math.

Smoke storage is fixed at 768 samples; skid storage is fixed at 1,600 segments. Distance emission rejects teleports, carries fractional distance and tops up stationary burnouts by time. Wheels retain their histories while inactive to avoid connecting skids across grass or resets. Launch slip and pops are presentation proxies because neither game's simulation supplies wheel torque or gearbox telemetry.

The shipped Getaway smoke trail lives here pending consolidation with the parallel FX package. Preserve this implementation's spacing, lifetime, heat and advection when moving the trail; the older connected-smoke study has different values.

## Verify changes

Both games' `bun run check` includes the package tests. Those tests cover spring time partitioning, wheel contact, flight and teleport reset, body transforms, gearbox hysteresis, tyre audio and slip-to-smoke behavior. Blackout also checks that its instance transform matches `bodyPoint`.

With the Nexus previews running, use:

```sh
bun scripts/prove-vehicle-kit.mjs getaway before
bun scripts/prove-vehicle-kit.mjs getaway after
bun scripts/prove-vehicle-kit.mjs blackout before
bun scripts/prove-vehicle-kit.mjs blackout after
```

The baseline uses exact module bodies from `8dff834`. The proof checks Apple Metal, captures fixed-frame stills and reports pixel-file hashes. Getaway also renders the same six-second chase through both versions' offline audio graphs and reports WAV hashes and clipping. Real-time audio contexts are blocked. Outputs default to the ignored `captures/vehicle-kit/` directory; `OUT`, `URL` and `BASE_REF` override automation inputs.
