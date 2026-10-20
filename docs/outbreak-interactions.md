# Outbreak world interactions (AR-96)

Kit, after the co-op playtest: "Also maybe like baseballs you can throw? The ability to drag items. Or board up
windows? More world interactions..."

Code: `games/outbreak/shared/interactions/` (rules, one shared feature `interactions`) and
`games/outbreak/src/interactions/` (drawing, hint, Lab, staging). Lab: Backquote › Interactions; every interaction is
on by default and its "Today (off)" is one setting away. Station: `outbreak-interactions` (`arcade station
outbreak-interactions`). Command: `arcade cmd interactions.stage scene=baseball|can|bottle|brick`.

## What was already there

Before AR-96 the world already had: doors (E open/close, hold E lock, keyed doors unlocked with a key or pried with a
crowbar, Shift+E peephole), windows (E peek or climb, hold E open/close), fence vaults, barricades (B nails one plank
on the door or window the prompt points at, three at most, reinforced with the toolbox recipe, re-nailed with a
crowbar, worn by the dead with the bowed/hanging plank look), containers (E search, Shift+E smash), closets (hide),
can tripwires (strung with Mouse0, disarmed and re-strung with E), abandoned cars (E smash a window, alarms), bottles
(Mouse0, a fixed 12 m throw that breaks into glass), noisemakers, road flares, the fire kit (flamethrower, dynamite,
firecrackers, molotov, flare gun, bear trap), Lights Out lamps, radios, searchable bodies, chained dogs (food), the
Way Out's parts, gas cans, hotwiring and roadblocks, the Recipe Board (C or E at a bench), downed survivors revived
with hold E, G drop and hold G bundle, and Q ping. AR-96 extends these rather than adding parallel versions.

## Throwables

Baseballs, bricks, rocks, tin cans and bottles. Bottles are the old item, now thrown the new way.

- **Found** lying about: 70% of houses (Lab › Throwable houses) have one, seeded from the town alone
  (`toss-sites.ts`): a brick, rock, baseball or can by the front door or in the yard, or a can, baseball or bottle on
  a floor beside a table or counter. They are `drop:v:yard:<building>` ground drops, picked up with E like any drop,
  put out once per house (one taken never comes back). Bottles are still in containers as before.
- **Throw**: hold Mouse0 with one in hand. The arc (beads) and a ring where it comes down are drawn while you wind
  up, and the ring turns red when the throw will hit one of the dead. Release to throw: a tap throws 30% of full range
  (Lab › Tap throw), a full wind-up (0.75 s) the whole of it. A press with nothing held (bots, a click inside one
  frame) throws at full strength.
- **Flight**: a long lob flies over the heads of the dead in the middle and can hit one only near either end, so a
  can lobbed over a crowd lands behind it. A throw stops at walls, shut doors, boarded windows and abandoned cars and
  falls back; on open ground it hops and rolls. A brick, rock or baseball goes through a shut, unboarded window,
  breaking it open (glass noise, glass on the floor); a can or bottle does not.
- **Hits**: damage and a stagger; a baseball to the head (the arc at head height) knocks one down for 1.6 s. The one
  hit turns toward where the throw came from. Anything landing against an abandoned car jolts it and sets its alarm
  off (a bottle breaking within 2.5 m, as before).
- **Noise** where it lands, which the dead hear and come to: bottles break loud (`glass`, progression's
  `bottleNoise`), cans clatter (`cans`, 11 m), the rest thud (`thud`, 6–8 m).
- **After**: a bottle shatters into the field verbs' `glass:*` store (it crunches underfoot and is swept after 90 s);
  anything else lies where it stopped as an ordinary ground drop (`drop:t:*`) to pick up and throw again.

| Item | Range | Damage | On a hit | Noise | Windows |
| --- | --- | --- | --- | --- | --- |
| Baseball | 20 m | 12 | bonk (knockdown 1.6 s) on the head, else stagger | thud 6 m | breaks |
| Brick | 11 m | 34 | stagger 0.9 s | thud 8 m | breaks |
| Rock | 15 m | 20 | stagger 0.7 s | thud 6 m | breaks |
| Tin can | 14 m | 3 | stagger 0.25 s | clatter 11 m | bounces off |
| Bottle | 12 m (`bottleRange`) | 8 | stagger 0.5 s | glass 15 m (`bottleNoise`) | shatters on it |

**Authority and co-op.** The wind-up is tracked per seat in the feature's state from `stepSurvivorMovement`, which
runs while predicting too, so a client's arc preview knows its own wind-up; only the room throws. Each throw is one
`toss:<k>` ledger store from a ring of 16 (start offset, impact offset, rest point, peak, flight time, outcome bits),
so every seat draws the same flight from `tossAt` with no new wire fields. The room lands each throw after its flight
(damage, window, noise) and leaves the drop after the roll. The only wire addition is the `thud` noise kind, appended
to the noise section's kind table. A false `fireHeld` does not survive the wire (flags carry only `true`), so a
release reads as `undefined` in the room; the wind-up treats both as released.

**Today.** Lab › Interactions › Throwables › Today (off): no throwables in the world and the bottle is the old instant
fixed-range throw (`progression.tossBottles`).

Tests: `games/outbreak/tests/interactions-throwables.test.ts`, `tests/interactions-drag.test.ts`, the bottle cases in `tests/verbs.test.ts`, and seat
parity for baseballs and bottles in `tests/coop-ledger-features.test.ts`.

## Drag and brace

Loose furniture: a chair or a dresser, and a mattress or a table, in most houses (up to two per house), on open floor
clear of the house's own furniture, walls and doorways, and 2 m clear in front of a closet so you can still get in
(`furniture.ts`, `furnitureSites`, seeded once per house as
`furn:<building>:<i>` ledger stores). The house's baked furniture stays put; these pieces are extra and drawn by the
interactions presenter (box-built, with a lying-down twin for when the dead have shoved one over).

- **E at a piece: Drag.** It goes square in front of you along your aim. You slow to the piece's share of walking
  pace (chair 0.85, mattress 0.75, table 0.7, dresser 0.55; Lab › Dragging speed) and cannot sprint. Other survivors
  bump into pieces; the one you drag does not block you. The piece is let go if you go down, die or get in a car.
- **E again: Set down,** where it is, or **Brace** when it is within 1.4 m of a door or window it can hold (a chair
  only wedges doors; tables, dressers and mattresses do either). Braced, it stands flush against the opening on your
  side, square to it, a door slams shut, and the crowd counts the opening as barricaded until the piece is gone:
  chair 70, mattress 110, table 150, dresser 240 hit points (Lab › Brace strength).
- **The dead bash** the planks off first, then the furniture (`PortalHolds.absorb`); at 0 it is shoved 0.7 m into the
  room and falls over, with a bang the dead hear. E on it again (Pull away / Drag) stands it up and takes hold.
- **Carrying a car battery** slows you to 0.85 of walking pace (Lab › Carrying a car battery; 1 is Today).

**The crowd's hook.** `OutbreakAISubsystem.portalHolds` (`shared/ai.ts`, `PortalHolds`): `held(id)` makes a door or
window count as one plank for navigation, hearing, open-door solids and bash targeting, and is part of the topology
digest; `absorb(id, damage)` takes bash damage once the planks are gone. The interactions feature installs it each
tick (`holdsFor`), keyed by braced store → portal id.

**Bots path round it.** `survivorObstacles` on shared features (`feature-registry.ts`): the interactions feature
lists every piece no one is dragging, and survivor bots add them to their local nav grid and steering blockers
(`BotWorldView.obstacles`), rebuilt when a piece is set down. Without it bots walked into chairs and stopped.

**Speed hook.** `movementScale` on shared features (`survivorMovementScale` in `feature-registry.ts`), applied to
walking speed in `stepSurvivor` and so predicted the same way on a co-op client.

## Hauling a downed teammate

A downed teammate's prompt is now `E Drag ◦Revive`: tap E takes them under the arms (`haul:<seat>` store) and they
trail 0.8 m behind you while you walk at 0.55 pace (Lab › Hauling speed); tap again (Let go) to put them down; hold E
still revives. The haul ends when either of you is gone, you go down or into a car, or they are back up or dead.
`toggleHaul` is called from the death feature's prompt (`shared/death/runtime.ts`).

## Boarding

Boarding up was already there (B nails one plank, up to three, at the door or window the prompt points at). Kit asked
for it again, so two rough edges are gone:

- **One B boards it up.** After a board goes up, the next starts on the same opening by itself, at its own noise,
  until there are three, the belt is out of planks or you walk off or sprint (which cancels a channel as before).
  With a crowbar in hand B still re-nails a damaged barricade and does not chain. `progression.chainBoards`, set from
  Lab › Interactions › Boarding › "One B boards it up" (Today: one board per press).
- **Hold E pries a board off** a boarded door or window, from either side: a 1.6 s channel (Lab › Verbs › Pry a board
  off, its noise 9 m), and the plank goes back in your belt. Before, a boarded door only said "Blocked by barricade"
  and you were shut in your own safehouse until the dead broke it. The tap is still refused, and its message now says
  "Boarded 2/3 · hold E to pry one off". A boarded window's tap (Peek) waits for the release, so the hold reaches the
  pry without peeking first. `shared/interactions/boards.ts` wraps the door and window handlers (`PRY_OFF`, the
  `pry` action with the crowbar glyph), and the ledger rule `unboard` does the work; `OutbreakAISubsystem.
  removeBarricadePlank` takes the plank and its share of the barricade's hit points. Lab › "Hold E pries a board off"
  (Today: boards stay).

## Teaching

The world prompt and training room belong to the onboarding pass (`docs/outbreak-onboarding.md`). The interactions
feature adds one in-world reminder line low over the survivor (`src/interactions/hint.ts`): with a throwable in hand,
the Mouse0 hold cap and "Throw · hold for distance", the ring filling as the throw winds up.

Boarding teaches itself in the door and window prompt: B Board up while there is room and a plank, and the Hold E
ring with the crowbar glyph (Pry off a board) once there is a board up.

Furniture and hauling use the world prompt (E with the `drag`, `set-down` and `brace` glyphs added to
`@arcade/kit/client/action-glyphs`), so they teach themselves where the prompt does.

## Sounds wanted (audio owns `src/audio`)

Dragging: a scrape loop while a `furn:*` store has `drag` and is moving; a thump when one braces (`br` 0→1); a crash
when one is shoved over (`down` 0→1). Throws: a whoosh on release scaled by power; landing thud per item (baseball on grass/wood, brick, rock, can
clatter/roll); a bonk on a head hit; glass for a window broken by a throw (the `glass:*` store already plays
`glass.break` for bottles).

## Clip

`bun scripts/interactions-clip.ts` (in `games/outbreak`; run it through `hivemind run --kind browser --fetch
captures/interactions-clip`) plays every staged scene with scripted input in headless, muted Chromium and writes JPEG
frames plus a readout of what each scene left behind (`SCENES=board,pry` for a subset). Each scene starts the survivor
on their feet at full health with empty hands and hangs Ash's front door back up if an earlier scene's dead tore it
off. Hauling is not in it: it needs a second seat.

## Considered and cut

- Pushing abandoned cars, or using one as a moving wall: the vehicles feature owns cars, and it is a bigger job.
- Curtains and blinds that block sight through a window: small, but the crowd's sight model has no hook for it yet.
- Kicking a door into the dead: doors and their breaches belong to AR-97.
- Throwing a chair or other furniture, and stacking several pieces against one opening: one braced piece per opening.
- Bots that throw, drag or pry on purpose: bots throw a bottle as before and path round furniture, nothing more.
