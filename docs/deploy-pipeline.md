# Deploying without interrupting unrelated games

A shared-code merge triggers every game's workflow. A Worker deployment resets that game's room Durable Objects
and disconnects its WebSockets, even when the merge was for a different game. Keep the broad checks, but deploy only
when the built output changed, and give occupied rooms up to 30 minutes to finish.

## 485 of 703 recent deployments rebuilt identical output

The audit covers successful workspace game workflows created from **2026-10-21 00:36:55 UTC through
2026-10-23 03:56:08 UTC** (about 51 hours). Of 763 successful runs, Carrier already skipped 60; the other 703
deployed. Rebuilding those deployments found **485 unchanged outputs (69.0%)**, 207 changed outputs and eleven
first-observed baselines. The first deployment of each game is unclassified because its predecessor is outside
the window. One still-running Outbreak workflow was excluded.

| Game | Deployments | Identical to preceding deployment | Changed | First baseline | Existing skips |
| --- | ---: | ---: | ---: | ---: | ---: |
| Archers | 71 | 55 | 15 | 1 | 0 |
| BARBARA | 17 | 3 | 13 | 1 | 0 |
| Blackout | 71 | 42 | 28 | 1 | 0 |
| Brawl | 71 | 38 | 32 | 1 | 0 |
| Carrier | 29 | 0 | 28 | 1 | 60 |
| Getaway | 71 | 55 | 15 | 1 | 0 |
| Lab | 88 | 45 | 42 | 1 | 0 |
| Lot | 67 | 22 | 44 | 1 | 0 |
| Night Shift | 70 | 25 | 44 | 1 | 0 |
| Outbreak | 77 | 35 | 41 | 1 | 0 |
| Walkers | 71 | 65 | 5 | 1 | 0 |
| **Total** | **703** | **485** | **207** | **11** | **60** |

Method: fetch Actions runs and logs through GitHub's REST API, identify actual `wrangler deploy` executions, then
replay each run's historical commit (118 revisions). Install its frozen lockfile, build its client and dry-run its
Worker, and compare SHA-256 hashes of file names and bytes in `dist/`, Worker output and `wrangler.jsonc` against
the preceding deployment of that game. Exclude only the fingerprint marker and Worker diagnostics, as the new
guard does. All 703 builds and dry-runs succeeded; every build's emitted asset filenames matched its CI log.
These are reproducible-build measurements, not downloaded historical Worker byte attestations.

Logs alone showed 493 deployments with no uploaded assets. That is not the skip count: Worker changes, deletions
and assets already in Cloudflare's cache can produce that message. The rebuilt full-output comparison is the
measurement used above. Evidence and replay script are saved at
`~/code/home/artifacts/2026-10-22-arcade-deploy-audit/` (`replay.json`, `audit.json`, `runs.json`, `replay.ts`).

## Checks still run before every deployment

All eleven workspace workflows retain frozen install, `bun run check` and production smoke. Their deploy step now
runs `bun ../../scripts/deploy-game.ts --no-build` from the game directory. Only `main` can deploy, including manual
workflow dispatches. Each game's existing workflow concurrency serializes its main deployments and lets GitHub
replace queued work with the latest pending run.

The script:

1. Bundles the Worker with `wrangler deploy --dry-run`.
2. SHA-256 hashes the built `dist/`, Worker bundle and `wrangler.jsonc`, with file names and lengths included.
   The fingerprint excludes its own `deploy.txt` and Wrangler's generated README and source maps. Client assets,
   added/deleted files, Worker-only changes, bindings, routes and migrations all affect the hash.
3. Compares the hash with `https://anoma.ly/arcade/<game>/deploy.txt`, using a unique query and a ten-second timeout.
   An exact match skips deployment immediately.
4. For a changed multiplayer game, queries `/api/stats`. A positive or unavailable player count waits one minute.
   Two empty samples fifteen seconds apart allow deployment. After thirty minutes, deployment proceeds regardless.
5. Runs `wrangler deploy`. The new fingerprint ships as an asset in the same version. There is no separate cache to
   advance on failure, no new credential, and no storage service to provision for fingerprints.

The workflow summary records the fingerprint, skip/deploy decision, and whether the room wait expired. The deploy
step has a forty-minute timeout, leaving time for the bounded wait and upload. `--dry` builds and fingerprints
without contacting production or deploying; `--no-build` reuses a checked build. Carrier's old script delegates to
the shared script; its legacy `--if-changed` argument is accepted, and equality checks are always enabled.

## Occupancy uses the existing public player count

Getaway, Blackout, Carrier, Brawl, Archers and BARBARA already expose aggregate player totals through their persisted
Lobby. These totals include private and full rooms. `games` counts joinable rooms and can be zero while people are
playing, so the deploy script reads only `players`. No room codes, seat tokens or saved game state are exposed.

Outbreak gains the same aggregate endpoint and a presence-only Lobby Durable Object. Its rooms report connected
sockets through the existing `RoomObject` change reporting and ten-second heartbeat. The new `v2` migration creates
the Lobby; the existing `OutbreakRoom` namespace stays in place. Room creation and matchmaking behavior stay in the
existing Outbreak UI.

This is an advisory occupancy check. A person can join after the last sample, a reporting outage can hide a room,
and the thirty-minute deadline can expire while people are playing. Grace-held seats in some games make the wait
conservative. Durable recovery is still needed for deployments, runtime restarts and network failures.

On the first rollout, games without a marker deploy once to establish it. Carrier's fingerprint format changes, so
it also deploys once. Outbreak's old Worker returns 404 for stats; its first rollout therefore waits the full thirty
minutes before adding presence tracking. A missing or malformed stats response never means "empty".

## Recovery requires per-game state adapters

BARBARA's PR #468 already put the reusable seat and client pieces in the kit:

- `net/seats.ts`: private seat credential checkpoints and restoration with the original grace deadline.
- `net/room-core.ts`: `checkpointSeats()` and `restoreSeats()`, which recreate empty input queues.
- `net/room-socket.ts`: `automaticReload`, capped at five same-room reloads with backoff. BARBARA opts in.

The remaining work is larger than a pipeline patch. BARBARA serializes its complete authoritative night, not merely
the wire snapshot. Other games hold different Maps, simulation clocks, RNGs, AI state, inventories, round state and
private identity mappings. Copying the serializer would silently discard some of that state.

Follow-up order:

1. Extract BARBARA's checkpoint scheduling into `@arcade/kit/net/checkpoint`: a version/build/room envelope, a game
   `capture`/`restore` adapter, two-second cadence plus seat changes, and write-failure backoff up to sixty seconds.
   Keep SQLite operations in `@arcade/kit/server`, and keep private checkpoints out of the client protocol.
2. Convert BARBARA to the helper first, preserving its existing restart proof. Reject corrupt, wrong-room or
   incompatible saves; clear stale input/event/delta queues; preserve grace expiry across repeated restarts.
3. Add one game at a time. Start with Brawl/Blackout's shared RoomCore, then Archers' world/tick/relay state. Outbreak
   needs its full simulation and ledger state. Carrier/Getaway need their custom core and identity adapters. Each
   game must restore a full authoritative join snapshot and reset client prediction/interpolation cursors.
4. Opt each client into capped same-room reload/rejoin only after its server recovery works. Some clients already
   reconnect sockets, but reconnecting into a fresh room does not recover the match.
5. Prove two clients retain identity and game state across a real workerd restart; test incompatible builds, corrupt
   saves, expired grace, repeated restart, failed storage writes, and no duplicate one-shot actions. Measure checkpoint
   size and write cost on a populated room before choosing its cadence.

## Cloudflare cannot keep an upgraded room alive automatically

Checked against Cloudflare's current documentation on 2026-10-22:

- [Gradual deployments with Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/)
  assign each object to one version. An object resets when that assignment changes. Gradual rollout can spread out
  the interruption, but it does not wait for a room to finish; moving to 100% eventually resets every upgraded room.
  Durable Object lifecycle migrations require `wrangler deploy` and cannot be rolled out gradually.
- [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) preserves
  connections through idle eviction, but code updates still disconnect WebSockets. Active simulation timers also
  prevent hibernation. Changing the socket API would not solve deployment interruptions.
- A later architectural improvement could put each game's room classes in a separate Worker and bind the web Worker
  to it through `script_name`. Then client-only updates would leave the room Worker untouched. That needs compatible
  protocols, a careful namespace transfer and a separate release path, so it follows recovery rather than this patch.
