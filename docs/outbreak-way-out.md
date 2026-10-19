# Outbreak: The Way Out

A goal you can win (AR-64). Kit: "you have to get to a place on the overworld, and therefore maybe you need the car to
get there because it's so far away. I guess it shouldn't be obvious how to get there at first, or even that it
exists. There should be clues in the world. Though of course once you've figured out that it's possible it should
still be difficult to get there."

Each town has one way out, far outside it. At first nothing says it exists. Clues in the world turn a rumour into a
direction and the direction into a place pinned on the map. Getting there is a drive of 1.5–3 km. At the place you
signal, then hold until dawn against the run's biggest horde. Whoever is in the evac zone at dawn escapes, and the run
is won. Lab › Way Out › "Off" is the game as it was: endless survival until everyone is dead.

Code: `games/outbreak/shared/way-out/` (rules), `games/outbreak/src/way-out/` (drawing, HUD, Lab). Tests:
`games/outbreak/tests/way-out.test.ts`. Lab station: `outbreak-way-out`.

## A winning run

1. **Rumour.** Something says there is a way out, and names the kind of place: a house radio left playing while a
   broadcast is on, a scrawled note on a table in some homes, or an evacuation flyer on a body you search. The goal
   line appears at the top of the screen: "A way out? The ferry. Find where. Last one leaves dawn, Day 6."
2. **Direction.** A torn map piece in a police station (one always stands a block south of town), the road sign 300 m
   out along the route, or the dead soldier 620 m out with his orders. The map shows a rough area ("The ferry?") and
   the goal line gives the bearing and the distance by road.
3. **Confirmed.** Two kinds of direction clue, or arriving. The place and the route are pinned on the map (N), the
   compass ring points at it with its distance, and a toast shows the place.
4. **The drive.** It is too far to walk before night (the note and the map say so). Today's cars work as they did;
   the car project and roadblocks on the route are the next slice (see "Planned").
5. **Signal.** At the destination, press E at the signal post, light a flare in the zone, or sound a car horn there.
   The beacon starts flashing and the siege begins.
6. **Final stand.** Waves of the dead come in from every side (4 every 14 s, one more every 3 waves, at most 30 alive,
   spawning 30 m out), on top of the night ramp. Hold the zone until it gets light.
7. **Escape.** At dawn everyone alive or down within 16 m of the crossroads goes. The card says "Escaped by ferry on
   Night 4", who made it out (3 of 4 survivors, each with their kills or what took them), day, nights, kills and time
   played, with Restart, New town (solo) and Lobby.

## The destination

`shared/way-out/plan.ts`: a pure function of the town's two seeds and the tunables, so the room, every client and the
Lab agree without sending it. Roads run on a 96 m grid through the middle of every block (`shared/world.ts`), so:

- the destination is a crossroads `(bx·96 + 44, by·96 + 44)`, between `minDistance` and `maxDistance` (1.5–3 km) by
  road from the town's crossroads at (44, 44);
- the route is an L along two roads: out along one, along the other to the destination. Which road first, and the
  quadrant, are seeded;
- the kind is seeded among harbour ferry, army checkpoint, airfield and dam (Lab › Way Out › Destination forces one);
- the road it arrives on names the open road in the soldier's orders.

The place is drawn on the crossroads (`src/way-out/props.ts`), the far road holding the ferry and its black water, the
barrier and watchtower, the runway and plane, or the dam wall, with three floodlights and a red beacon that light it
at night by their own light (Darkwood: colour only inside actual light). Its solid parts (`landmark.ts`) stop
survivors and cars. It is drawn from 110 m, so its lights read down the road before you arrive.

## Clues

| Tier | Clue | Where | How |
| --- | --- | --- | --- |
| Rumour | Radio broadcast | Any house radio left playing | Within 9 m while a broadcast is on (the first 45 min of every 2 h) |
| Rumour | Scrawled note | Table, dresser or nightstand in 14% of homes (fixed per house) | E: Read |
| Rumour | Evacuation flyer | 30% of bodies (fixed per body) | Search the body |
| Direction | Torn map piece | Last counter of every police station; block (0, 1) always has one | E: Take map |
| Direction | Road sign | Pavement 300 m along the route, mid-block | E: Read |
| Direction | Dead soldier with orders | Verge 620 m along the route | E: Search |
| Confirmed | Two kinds of direction clue, or arriving within 60 m | | |

Every tier has more than one way in, so a run is never stuck: the police station and the two roadside clues always
exist, and arriving confirms on its own. Drawings come first (`src/way-out/drawings.ts`): the place in a few strokes,
the radio, the flyer, the torn map with its arrow and cross, the sign, the orders; a few words go under them
(`clueWords` in `clues.ts`).

## Clock

The broadcast, the flyer and the orders give the deadline: the last evacuation leaves at the dawn after Night 5
("dawn, Day 6"). Nights are counted as the death and night-ramp features count them (a night begins when it gets
dark). After that dawn, if nobody escaped, the way out is gone ("The last ferry has gone") and the run goes on as
endless survival. Lab › Way Out › Missing it › "One late boat" instead gives one more, two nights later. The evac
comes at the first dawn after the signal; if nobody is in the zone then it leaves without them and they can signal
again the next night (before the deadline). "The evac comes: After a fixed hold" (Lab) uses a timer instead.

## State and co-op

Everything every seat sees is one shared ledger counters store, `wayout` (`state.ts`): the tier, each clue found, the
latest event and who caused it, nights, the deadline, the signal and siege, and the escape (who, on which night, kills
and time). It snapshots, saves and reaches every client like any shared store, so the feature adds nothing to the
wire. Clue prompts, the signal post, the HUD, the map and the props all read it. The room's `runOver` is true once the
squad escaped, so Restart works from the escape card as from the run-over card. After the escape nobody moves, is
seen or is hurt while the card is up.

Anyone can drive and passengers can already shoot from a car (`shared/vehicles/index.ts`). Carrying a downed friend
to the car is a follow-up; the down are carried aboard if they are in the zone at dawn.

## Lab

Backquote › Way Out holds every value: On/Off, destination, distances, deadline, missing it, the broadcast's hours
and reach, note and flyer shares, sign and soldier distances, the evac radius, the stand rule and hold, and the siege
(wave size, growth, interval, cap, radius). Actions: Reveal rumour/direction/confirmed, Teleport to the destination or
the road sign, Start the final stand, Win now, Forget the way out, and a Stage action per station view. Commands (offline):

```
arcade cmd wayout.reveal tier=3
arcade cmd wayout.teleport to=destination   # or signal, sign, soldier, police
arcade cmd wayout.stand
arcade cmd wayout.signal
arcade cmd wayout.win
arcade cmd wayout.stage scene=final-stand   # radio, note, flyer, police-map, road-sign, soldier, destination, final-stand, escape-card
```

## Bots and difficulty

Bots ignore the goal: nothing it adds touches the town until someone finds a clue, and the siege only spawns after a
signal at the destination. `tests/difficulty-ramp.test.ts` passes unchanged. "Off" is checked against a sim without
the feature registered: identical `SimState` hashes.

## Planned

- **The car as a project**: keys from the owner's house or a hotwire with a toolbox, a dead battery, and fuel only
  from gas cans (shared with the flamethrower); readable prompts with key caps.
- **Roadblocks** on the route: wreck pile-ups and a burnt-out police roadblock (dynamite), a chained gate (bolt cutters,
  a new rare item), or a detour; the soldier's orders say which way in is open.
- Sound for the clues, the signal and the escape; zombie pathing around the landmark's solids.
