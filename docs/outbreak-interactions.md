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

Tests: `games/outbreak/tests/interactions-throwables.test.ts`, the bottle cases in `tests/verbs.test.ts`, and seat
parity for baseballs and bottles in `tests/coop-ledger-features.test.ts`.

## Teaching

The world prompt and training room belong to the onboarding pass (`docs/outbreak-onboarding.md`). The interactions
feature adds one in-world reminder line low over the survivor (`src/interactions/hint.ts`): with a throwable in hand,
the Mouse0 hold cap and "Throw · hold for distance", the ring filling as the throw winds up.

## Sounds wanted (audio owns `src/audio`)

Throws: a whoosh on release scaled by power; landing thud per item (baseball on grass/wood, brick, rock, can
clatter/roll); a bonk on a head hit; glass for a window broken by a throw (the `glass:*` store already plays
`glass.break` for bottles).
