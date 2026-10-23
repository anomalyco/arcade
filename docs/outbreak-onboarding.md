# Outbreak: practising in the lobby, and the training room

AR-89. Aiden, after playing: "I think the E stuff could be more clear, everything is E. I can't tell if I'm
opening/closing/boarding." Kit: "Yeah. Need a little training room to start in." Then: "Maybe a tutorial in the
loadout. While loading out you can train." The prompt half (verbs while new, the target outline, B in door and window
prompts, stamps) is in [outbreak-hud.md](outbreak-hud.md#prompt-clarity-ar-89); this page is where you learn to play.

## Practising in the lobby (default)

While the lobby is open (picking a survivor and kit, hosting, or waiting for a room to fill or start), you stand in
Ash, your own house, at dawn, in your own local session, and play. The lobby docks to the left as a panel over the
live world: the same cards, buttons and look, compact. Everything works with the kit you picked: walk, the flashlight
(F), doors (E, hold E to lock), peeking through a window, boarding the east window with B, searching the dresser and
taking what is in it, the throwable on the floor, the Attaché Case (Tab; the panel slides away while it is open), the
recipe board at the workbench, and a zombie chained to the porch rail to swing or shoot at. It comes back three
seconds after it goes down. Picking another kit in the panel swaps it in at once, a fresh kit as the run would
issue it. Hits sting at a quarter and never take you below 20 HP.

The same wordless hints as the training room (below) show one at a time over the thing to use or over you, but
nothing waits on them: there are no steps, no skip and no end. **Enter** is the only key the lobby keeps: Play Solo
on the start panel, or in a room Ready, then Start Night (host, or once everyone is ready), and Enter again un-readies
a guest. Every other key belongs to the game while you practise, so moving, E, B, F, Tab, R, C and the digits all do
what they do in the run, Esc only closes the bag or panel, and nothing you press while practising can leave a room by
accident. Buttons drop focus after a click so Space stays a vault.

Play Solo, or the room's run starting, drops you straight into the run; the practice session is thrown away.

- **Co-op**: each player practises alone in a local session while the lobby fills. Remote survivors are not drawn
  and nothing is sent: while the lobby is over the practice space `CoopView.net` reads null, so every feature, body,
  light and name tag treats the practice space as offline, and only the lobby plumbing (picks, ready, start, leave)
  reaches the room. Your kit pick still goes to the room as before. When the room's phase turns to running, the lobby
  closes and the room's session takes over (`CoopView.syncLobby`).
- **Never in a run**: the practice session is a separate `LocalSession` on the local seed (Ash is the same house on
  every seed), staged by `stageTraining(sim, state, true)`. The room's sim, bots and real runs never stage it, and no
  boards or items carry out of it.
- **Today** is one setting away: Lab › Onboarding › Practise in the lobby › Off restores the paused menu over a
  still frame (with the Training Room button and the menu keys 1–4, H, T, R, C, Esc).

## The training room (one setting away)

Lab › Onboarding › Guided room before a solo run: Off (default since the lobby practice replaced it), First solo
start, Every solo start. When on, Play Solo wakes you in Ash at dawn (06:06) on the day the outbreak reaches the
street. The dead broke in through the east window in the night. One hint shows at a time, as key caps and a glyph,
no words, over the thing to use (or over you for a skill); within reach the world prompt and its outline take over,
so the hint only leads you there.

| Beat | Hint | Done when |
| --- | --- | --- |
| Move | WASD over you | 1.5 m from the bed |
| Flashlight | F, bulb | the light is on |
| Search | E, search, over the dresser | the dresser is searched |
| Take | E, take-all | its planks or chemicals are carried (the chemicals fill in the bandage on the recipe board) |
| Case | Tab, over you | the Attaché Case is opened (AR-94; the client tells the guide with `noteCase()`, since the sim never sees it). With Lab › Inventory › Style on Today it is passed at once |
| Recipe board | E, gear, over the workbench | a bandage is made (a digit in the panel) |
| Hall door | E, door-open | the bedroom door is open |
| Shut it | E, door-close, once through | it is shut behind you |
| Crouch | hold Z, near the glass | crouched by the glass for 0.3 s |
| Board up | B, board-up, over the east window (back to the dresser without planks) | a board is up |
| Sprint | Shift while moving | 0.6 s of sprinting |
| Front door | E, door-open | it is open, or you are outside |
| The chained one | V, burst, over the zombie chained in the yard | it is dead |

Doing a place (search, the hall door, the window, the front door, the zombie) passes the beats before it, so nobody
is nagged back for a skipped recipe; moving, the light and sprinting are hinted whenever they are still undone.
Leaving the yard for the street (south of y 41.6, or 17 m from the house) cuts to black with the run's hour on it
(17:30) and starts the run in the same yard at dusk, with the boards you nailed still up. It takes two to three
minutes. Hold Esc (0.8 s, a ringed cap top right) to skip at any time. Unlike the practice space, the room starts you
with no planks of your own, so the dresser's planks are what you board with.

- **When**: with First solo start it runs once per browser (`localStorage["arcade.outbreak.training"] = "done"` once
  finished or skipped). The lobby's **Training Room** button (T) always runs it; it shows only with the lobby
  practice off. Links that skip the lobby (automation, `?seed`, `?bench`, `?room`) never train.
- **Co-op**: solo only; a room's run is the room's session.

## Shared rules and hooks

- `shared/onboarding/` is inert unless staged: it holds the dawn, culls every other zombie, keeps the chained one in
  reach of its rail (in practice, brings it back `PRACTICE_RESPAWN_SECONDS` after it goes down) and makes hits sting
  at a quarter, never below 20 HP. Nothing on the wire.
- **Hook**: `main.ts` asks the client registry for the next session (`OutbreakClientFeature.session`, with `coop` in
  its context) before the room's or the normal one. The onboarding feature returns the practice space while the
  lobby is open (and sets `OutbreakLobby.practice`, which docks the panel, unpauses the loop and hands the keys to the
  game), the training room when asked, and the run with the carried boards after it.

## Code and tools

`shared/onboarding/` (staging, chain and respawn, damage, leaving), `src/onboarding/` (`practice.ts` the practice
space's frame: kit swap, guide, hint; `state.ts` settings, persistence and the request; `beats.ts` the guide;
`hints.ts` hint, skip chip and fade; `stage.ts` beat staging; `session.ts`; `index.ts`). The lobby panel and its keys
are `src/lobby/lobby-ui.ts` and `src/lobby/keys.ts` (`lobbyKeyAction`). Commands: `arcade cmd onboarding.start`,
`onboarding.beat beat=board` (in the practice space when the lobby is open), `onboarding.skip`. Station:
`outbreak-onboarding` (lobby practice variants on `?lobby=1`, a variant per training beat, Clear vs Today prompts).
Harness: `state().practice` {beat, done, loadout, hint} and `state().onboarding`.

Proof: `bun scripts/lobby-practice-proof.ts` (via `hivemind run --kind browser`): a solo practice clip with real
clicks on the kit cards and real Tab and Enter, then two pages in one room on `wrangler dev` practising apart, readying
with Enter and dropping into the room's run (`--no-coop` skips that half). The training room's own proof is
`bun scripts/onboarding-proof.ts`.

Tests: `tests/training-room.test.ts` (staging, the chain, damage, a real run untouched, a scripted walk through every
beat to the street with the boards carried, places passing earlier beats, when it runs and persistence; the practice
space's kit, live kit swap, the chained one coming back, quiet hints, the session hook solo and in a room with nothing
leaking into the run, the room's sim never staged, and the lobby's keys with and without the practice space).
