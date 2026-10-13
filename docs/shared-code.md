# Shared code

Code both games carry their own copy of, and what to extract. Extract something only when it is the same idea in
both games and has a current consumer in each. Game rules, maps, meshes and the look stay in the games.

## Where it goes

`packages/kit/`: plain TypeScript source, no build step. Games import it by relative path. Each game's tsconfig must
include it, and each game's workflow must also trigger on `packages/kit/**`, because a change there ships every game
that uses it.

## Candidates

Already shared: `packages/kit/compare.ts` / `compare.css` serve both comparison pages; `gpu-perf.ts` instruments
both GPU devices and their historical counterparts. `perf-overlay.ts` supplies the historical builds' readout.
`lab-panel.ts` supplies the current games' floating Lab shell, enable/disable rows, All On / All Off, and input isolation.
It also accepts numeric range controls (`min`, `max`, `step`), selects (`options` with numeric or string values),
and an `enabled(settings)` predicate. Groups containing sliders or selects get Copy JSON.
All On / All Off affect switches only and are hidden when there are none. Getaway's Lights group uses both types:
its Style select switches the live renderer, and its sliders are enabled for the Soft pool style.
Each game's `src/ui/debug-overlay.ts` declares its own effect settings and telemetry adapter. The panel opens for
`?perf=1` / `?lab=1`; the always-available `~ Lab` pill and Backquote toggle it.

In rough order of value against risk.

1. **Matchmaker and lobby Durable Object.** `server/matchmaking.ts` and `server/lobby.ts` are nearly identical across
   the games. Blackout's lobby persists room reports in storage; Getaway's keeps them in memory. Share the persistent one,
   with the "is this room open" rule and stale window as options.
2. **Room plumbing.** Throttled lobby reports with a heartbeat, idle kick with a countdown, the build-hash version
   handshake (only Blackout has it today), and seat bookkeeping. The game supplies the simulation and the snapshot.
3. **Seeded RNG.** Two mulberry32 implementations: a function in Getaway, a class in Blackout. Keep one.
4. **Keyboard input.** Layout-aware keys (`e.code` and `e.key`), release by keydown character, Cmd and blur release, and
   the receiver for multiplexed input from `compare.html`. Each game keeps its own bindings.
5. **Dev and proof tooling.** `scripts/dev.ts` (same apart from ports), the before/after capture and benchmark harness
   (`scripts/compare.ts` in both), the multiplayer benchmark, the perf readout and effect switches in the debug overlay,
   and the `?peaceful&seed` convention. One runner with a small scenario hook per game.
6. **Post-processing chain.** HDR target, MSAA resolve, five-level bloom, composite and grade, with cached views. Both
   renderers build the same chain. Getaway could also take Blackout's packed 24-byte vertex format.
7. **Session interface.** Local (solo, practice) and network sessions behind one interface, as both games already do.
8. **Camera feel.** Trauma-squared shake, punch and presentation-only hit-stop.
9. **Audio basics.** Unlock on first gesture, mute key.

Later, once both games use it: snapshot interpolation (Getaway `interp.ts`/`netcode.ts`, Blackout `smooth.ts`) differs
too much today.
