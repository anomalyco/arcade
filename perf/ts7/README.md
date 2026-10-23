# Bun TS7 typechecking, 2026-10-22

Measured through HiveMind on mini (M4 Pro), one compiler process at a time, two TS7 threads.
These are rough single cold/warm observations, not medians. Cold means no compiler build-info cache;
the OS file cache was not flushed. TS7 has no persistent incremental cache, so warm is a second invocation.

| App config | TS5 cold / warm | Bun TS7 cold / warm | Cold ratio |
| --- | --- | --- | --- |
| Getaway | 3.259 / 0.883 s | 0.198 / 0.193 s | 16.5× |
| Blackout | 3.513 / 0.849 s | 0.222 / 0.210 s | 15.8× |
| Lab | 6.090 / 1.821 s | 0.403 / 0.381 s | 15.1× |
| kit | 4.530 / 1.291 s | 0.295 / 0.285 s | 15.4× |

`before.json` records TS 5.9.3 under Node at main `51fd825c`, after the prerequisite merges.
`after.json` records successful TS7 runs, with affected configs rerun after rebasing onto `4c0529f4`
(including the fast-tests PR). Unaffected server configs retain their first successful measurement.
All 27 configs passed. Host load varied; raw load averages are in the JSON. The much older Pro
81/16, 87/20, 247/24 and 212/29-second numbers are a different machine/load baseline, not a TS7 speedup.
After the final rebase onto `3730a4e9`, the affected Barbara, Lab and root-script configs passed again
through the bounded wrapper (compiler-reported 0.367, 0.423 and 0.408 s respectively).

## Commands and versions

Generate the games' build IDs before checking. Baseline command per config:

```sh
node node_modules/typescript/bin/tsc --noEmit -p <config> --incremental --tsBuildInfoFile <fresh-cache> --pretty false
```

After command per config:

```sh
bun check --no-script --no-pretty --all --threads 2 -p <config>
```

The project wrapper takes the thread count from `HIVEMIND_CPUS`, floors fractions with minimum one,
defaults to two, and rejects invalid/nonpositive allocations. Workspace `typescript` is pinned to
`7.1.0-beta`; Bun 1.4.4 reports `process.versions.typescript` as **7.0.2**. The built-in checker does
not use the npm pin. Existing AST tooling uses `typescript-api` (`@typescript/typescript6@6.0.2`,
which resolves the legacy compiler API through its locked TypeScript 6 dependency).

Mini's HiveMind PATH selected Homebrew Bun 1.4.2. Measurements explicitly used
`/Users/administrator/.bun/bin/bun` (1.4.4). For package scripts, `bun run --bun typecheck`
kept nested Bun invocations on that executable; without `--bun`, the wrapper correctly rejected 1.4.2.
CI pins all 17 workflows to 1.4.4. Frozen install passed (0.031 s); the package wrapper passed (0.173 s).

## `bun test --check`

The targeted 14-test/102-assertion verification suite passed normally in 1.334 s and with
`--check --no-pretty --all --threads 2 --max-concurrency 4` in 1.283 s. These single runs under
different load do not establish a speed improvement. A temporary test containing `const value: string = 123`
failed with TS2322 before execution under both `bun test --check` and standalone `bun check`.

Recommendation: use `bun test --check` for targeted test development. Keep the fast tier's separate
full-project typechecks: test checking covers the selected tests and their imports, not every app,
server and proof-script entrypoint. Combining it with the existing project checks duplicates work.

## Compatibility and review notes

- Strict settings stay enabled. Fixes cover DOM `hidden` booleans, ArrayBuffer-backed encoder types,
  proof-only WebSocket buffers, WebGPU overload forwarding, Vite ambient types, and legacy AST imports.
- Knobs is pinned at upstream `18b2452` on the published `arcade-ts7-compat` branch, based exactly on
  the previously vendored revision. All 98 vendored source files match that commit byte-for-byte, with
  no extra files. The same fix is on knobs main as `b27b651`. Adopting main (`0.4.0-next.18`, including
  `tokens/`, `review/` and `@pierre/diffs`) needs a separate adoption pass.
- The browser-budget audit successfully loaded the legacy compiler API, then reported the existing
  missing budget import in `scripts/sky/woods-checkpoint.ts`. That source is unchanged by this migration.
- After restoring the minimal published knobs revision and rebasing onto main `6ba88792`, HiveMind
  passed all 27 configs and the 14 touched tests (102 assertions, 1.011 s). The review coordinator also
  reported `verify --all` passing 49/49 in 74 s, plus the Lab build and dry-run, on the reviewed revision.
