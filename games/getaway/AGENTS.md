# getaway

- Run `bun run check` before pushing; pushing to `main` deploys https://anoma.ly/arcade/getaway/ (follow `../../docs/agent-state.md` for deploy and branch rules).
- WebGPU only runs in secure contexts: test via the deployed URL or `localhost`, never a bare LAN hostname.
- Design and rules live in `docs/design.md`. The simulation in `shared/` runs on both the Durable Object server and the client (solo mode and prediction); keep it deterministic and free of DOM or Worker APIs.
- Screenshots: use the Chrome on `apollo` (browser-control over SSH, real AMD GPU). Local headless Chromium only has SwiftShader.
- Cross-game techniques and lessons: `../../docs/game-notes.md`. Shared code plans: `../../docs/shared-code.md`.

## Game shell

- The title, lobby, Escape menu and Settings are the kit game shell (`@arcade/kit/shell`, [docs/game-shell.md](../../docs/game-shell.md)), set up in `src/main.ts`. The night-road backdrop and the live player count stay Getaway's (`titleArt` in `src/ui/lobby.ts`); the waiting room, chat and end card stay in the HUD. Shell colours are at the end of `src/style.css`.
- Deliberate changes when it moved onto the shell (Oct 22):
  - The title is the shell's: name, Quick join, Solo practice, Play with friends (Create game) and Join by code or
    invite link (`?r=`, upper-case codes; a pasted link works too), with Settings and mute in the corner. Rooms still
    need a name (`nameRequired`); solo plays as "Dax" without one.
  - Escape opens the menu (Resume, Settings, Leave room or Quit to title). Solo practice pauses behind it; a room keeps
    playing with the car idling. Leave reloads the page onto the title (the scene is built from the session's city).
    Escape still closes chat first.
  - Volume and mute moved from the Lab's Volume rows to Settings (Master, Effects, Ambience, Police radio; same
    `arcade.volume.getaway.v1` levels, the old `getaway.mute` read once). M mutes from the shell; the HUD's
    "M SOUND ON/OFF" hint stays. Quality is in Settings, not the Lab's View group, and uses the slow-frames policy.
  - Connection trouble also shows in the shell's reconnect pill; the HUD's room pill keeps its status dot.
  - Driving keys are ignored on the menu.
