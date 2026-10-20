# Outbreak: the training room

AR-89. Aiden, after playing: "I think the E stuff could be more clear, everything is E. I can't tell if I'm
opening/closing/boarding." Kit: "Yeah. Need a little training room to start in." The prompt half (verbs while new,
the target outline, B in door and window prompts, stamps) is in
[outbreak-hud.md](outbreak-hud.md#prompt-clarity-ar-89); this page is the room.

## The flow

The first solo start in a browser wakes you in Ash, your own house, at dawn (06:06) on the day the outbreak reaches the
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
| Crouch | hold Ctrl, near the glass | crouched by the glass for 0.3 s |
| Board up | B, board-up, over the east window (back to the dresser without planks) | a board is up |
| Sprint | Shift while moving | 0.6 s of sprinting |
| Front door | E, door-open | it is open, or you are outside |
| The chained one | V, burst, over the zombie chained in the yard | it is dead |

Doing a place (search, the hall door, the window, the front door, the zombie) passes the beats before it, so nobody
is nagged back for a skipped recipe; moving, the light and sprinting are hinted whenever they are still undone.
Leaving the yard for the street (south of y 41.6, or 17 m from the house) cuts to black with the run's hour on it
(17:30) and starts the run in the same yard at dusk, with the boards you nailed still up. It takes two to three
minutes. Hold Esc (0.8 s, a ringed cap top right) to skip at any time.

## Rules

- **When**: Play Solo from the lobby asks for it; it runs the first time in this browser
  (`localStorage["arcade.outbreak.training"] = "done"` once finished or skipped). The lobby's **Training Room**
  button (T) always runs it. Lab › Onboarding › Training room: First solo start (default), Every solo start, Off
  (Today). Links that skip the lobby (automation, `?seed`, `?bench`, `?room`) never train.
- **Co-op**: solo only. A co-op room never makes an offline session, so it never sees the room, and nothing is on
  the wire. Anyone can train from the lobby before hosting or joining.
- **Its own sim**: the room is a throwaway `LocalSession` on the run's seed (Ash is the same house on every seed),
  staged by `stageTraining` (`shared/onboarding/training.ts`): dawn held, the survivor beside the bed with no planks,
  the dresser stocked with two planks and two chemicals, one zombie on a 1.3 m chain at the porch rail. The shared
  feature `onboarding` is inert unless staged: it holds the hour, culls every other zombie, keeps the chained one in
  reach of its rail and makes hits sting at a quarter, never below 20 HP. Real runs, bots and rooms never stage it.
- **Hook**: `main.ts` asks the client registry for the offline session (`OutbreakClientFeature.session`); the
  onboarding feature returns the training room when asked, and the run with the carried boards after it.

## Code and tools

`shared/onboarding/` (staging, chain, damage, leaving), `src/onboarding/` (`state.ts` persistence and the request,
`beats.ts` the guide, `hints.ts` hint, skip chip and fade, `stage.ts` beat staging, `session.ts`, `index.ts`). The
lobby button is in `src/lobby/lobby-ui.ts`. Commands: `arcade cmd onboarding.start`, `onboarding.beat beat=board`,
`onboarding.skip`. Station: `outbreak-onboarding` (a variant per beat, and Clear vs Today prompts). Harness:
`state().onboarding` {training, beat, hint, done, completed}.

Tests: `tests/training-room.test.ts` (staging, the chain, damage, a real run untouched, a scripted walk through every
beat to the street with the boards carried, places passing earlier beats, when it runs and persistence).
