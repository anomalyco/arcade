# getaway

- Run `bun run check` before pushing; pushing to `main` deploys https://anoma.ly/arcade/getaway/ (follow `../../docs/agent-state.md` for deploy and branch rules).
- WebGPU only runs in secure contexts: test via the deployed URL or `localhost`, never a bare LAN hostname.
- Design and rules live in `docs/design.md`. The simulation in `shared/` runs on both the Durable Object server and the client (solo mode and prediction); keep it deterministic and free of DOM or Worker APIs.
- Screenshots: use the Chrome on `apollo` (browser-control over SSH, real AMD GPU). Local headless Chromium only has SwiftShader.
- Cross-game techniques and lessons: `../../docs/game-notes.md`. Shared code plans: `../../docs/shared-code.md`.
