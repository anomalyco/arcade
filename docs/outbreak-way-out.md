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
4. **The car.** It is too far to walk before night (the note and the map say so), and a tank does not go far: flat out
   a sedan burns its tank in about 1.9 km. The gas station pumps are dry, so the project is gas cans (garages and gas
   stations), poured in when you get in, 40% each; and a car you can start: keys from a house, a car battery from the
   hardware store, or hotwire one with the hardware store's toolbox (hold E, noisy). The goal line shows how far the
   tank goes beside the distance.
5. **The roadblocks.** Past the dead soldier the route is blocked, twice by default: a pile-up, a police roadblock or
   a chained gate across the road and both verges. People squeeze through a gap at one kerb; cars cannot, and ramming
   one only damages the car. Dynamite clears any of them, bolt cutters (a new rare part) open a gate, or drive round by
   the next road. The soldier's orders say how far on the first one is, and mark them all on the map.
6. **Signal.** At the destination, press E at the signal post, light a flare in the zone, or sound a car horn there.
   The beacon starts flashing and the siege begins.
7. **Final stand.** Waves of the dead come in from every side (4 every 14 s, one more every 3 waves, at most 30 alive,
   spawning 30 m out), on top of the night ramp. Hold the zone until it gets light.
8. **Escape.** At dawn everyone alive or down within 16 m of the crossroads goes. The card says "Escaped by ferry on
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
| Direction | Dead soldier with orders (and how far on the first roadblock is; marks them all on the map) | Verge 620 m along the route | E: Search |
| Confirmed | Two kinds of direction clue, or arriving within 60 m | | |

Every tier has more than one way in, so a run is never stuck: the police station and the two roadside clues always
exist, and arriving confirms on its own. Drawings come first (`src/way-out/drawings.ts`): the place in a few strokes,
the radio, the flyer, the torn map with its arrow and cross, the sign, the orders; a few words go under them
(`clueWords` in `clues.ts`).

## The car and the roadblocks

`shared/way-out/car.ts` (rules) and `roadblocks.ts` (where they are), on with Lab › Way Out › The car: "A project".

- **Fuel.** The vehicles subsystem asks `refuelRule()` how tanks fill (`shared/vehicles.ts`: Chem into an empty tank
  and free pumps, as before). The car project answers: a gas can (`fuel`, belt) per pour, `canFill` (40%) each, into
  any tank with room for a whole can, all you carry, when you get in or press the throttle; the pumps are dry (a driver
  stopped at a gas station is told so). Gas cans are the flamethrower's fuel too.
- **No car is ready.** Every parked car spawns with a dry tank and without its keys (or, if it already lacks one,
  without its battery), the sedan by the start included, through the vehicles' `spawnRule`; cars nobody has touched
  follow the rule when it is switched. Off, they spawn as before (the start sedan ready with 80%).
- **Keys.** A key from a house dresser or a car battery from the hardware store work as before. With a toolbox in
  your pack and no key, a car with no keys offers Hotwire (hold E, 6 s, heard 14 m off). Progress is in the store, so
  a teammate sees it; let go and it lapses.
- **Roadblocks.** `roadblocksOf(plan)` puts `roadblocks` (2) of them in the middle of road stretches between the
  soldier (+140 m) and 220 m short of the destination, at least 90 m apart, each a seeded pile-up (35%), police
  roadblock (25%) or chained gate (40%). Each spans 24 m across the road and verges and is added to the cars' solids;
  people are pushed out of all of it but a 1.2 m gap at one kerb, so on foot nobody is ever stuck. Any explosion on
  the noise bus within `blastReach` (3 m) of one clears it (dynamite: `shared/fire/`); bolt cutters (`bolt-cutters`,
  pack, 10% of hardware, 5% of garage and 6% of warehouse shelves) cut a gate's padlock (hold E, 4 s). The road grid
  means there is always a way round. They read at night by their own light: the police lamps blink red and blue, a
  pile-up smoulders. The dead are pushed out of them (and out of the destination's solids) after the crowd steps, so
  they slide along them and come through the gap as people do.

## Sound

`src/way-out/sounds.ts`, observed by the sound director from the `wayout` store alone, so a co-op client hears what
the room did. Library samples: paper for a clue, tinkering held while a car is hotwired and a click when it catches,
the cutters working at a padlock and the gate swinging open, metal coming down after a roadblock's blast (the blast
is the dynamite's own), the flare at the signal, a chime at the escape, a groan when the way out is lost. Hold and
event positions are in the store (`hx`, `hy`, `ex`, `ey`).

## Clock

The broadcast, the flyer and the orders give the deadline: the last evacuation leaves at the dawn after Night 5
("dawn, Day 6"). Nights are counted as the death and night-ramp features count them (a night begins when it gets
dark). After that dawn, if nobody escaped, the way out is gone ("The last ferry has gone") and the run goes on as
endless survival. Lab › Way Out › Missing it › "One late boat" instead gives one more, two nights later. The evac
comes at the first dawn after the signal; if nobody is in the zone then it leaves without them and they can signal
again the next night (before the deadline). "The evac comes: After a fixed hold" (Lab) uses a timer instead.

## State and co-op

Everything every seat sees is one shared ledger counters store, `wayout` (`state.ts`): the tier, each clue found, the
latest event and who caused it, nights, the deadline, the signal and siege, the escape (who, on which night, kills
and time), the roadblocks gone and seen, and the hotwire or cut in progress. It snapshots,
saves and reaches every client like any shared store, so the feature adds nothing to the
wire. Clue prompts, the signal post, the HUD, the map and the props all read it. The room's `runOver` is true once the
squad escaped, so Restart works from the escape card as from the run-over card. After the escape nobody moves, is
seen or is hurt while the card is up.

Anyone can drive and passengers can already shoot from a car (`shared/vehicles/index.ts`). Carrying a downed friend
to the car is a follow-up; the down are carried aboard if they are in the zone at dawn.

## Lab

Backquote › Way Out holds every value: On/Off, destination, distances, deadline, missing it, the broadcast's hours
and reach, note and flyer shares, sign and soldier distances, the evac radius, the stand rule and hold, and the siege
(wave size, growth, interval, cap, radius). The car rows: the car project, a gas can's fill, the hotwire hold and noise, how many
roadblocks, the cut hold and noise, how near a blast clears one. Actions: Reveal rumour/direction/confirmed, Teleport
to the destination, the road sign or the first roadblock, Give car parts, Start the final stand, Win now, Forget the
way out, and a Stage action per station view. Commands (offline):

```
arcade cmd wayout.reveal tier=3
arcade cmd wayout.teleport to=destination   # or signal, sign, soldier, police, roadblock
arcade cmd wayout.give                      # toolbox, car battery, bolt cutters, 3 gas cans, 2 dynamite
arcade cmd wayout.stand
arcade cmd wayout.signal
arcade cmd wayout.win
arcade cmd wayout.stage scene=final-stand   # radio, note, flyer, police-map, road-sign, soldier, car-repair, roadblock, destination, final-stand, escape-card
```

## Bots and difficulty

Bots ignore the goal: nothing it adds touches the town until someone finds a clue, the siege only spawns after a
signal at the destination, and bots do not drive (so dry pumps and gas cans do not touch them). `tests/difficulty-ramp.test.ts` passes unchanged. "Off" is checked against a sim without
the feature registered: identical `SimState` hashes.

## Planned

- A flat tyre as another car part; a key for each car in its owner's house (so far only a body on its own porch with its
  car in the drive carries the keys, AR-88, never at the start house); carrying a downed friend to the car.
- The dead's nav mesh does not know the destination or the roadblocks (they are pushed out, not routed round); the
  craft (boat, convoy, plane, helicopter) is not drawn arriving at dawn; recorded sounds for the horn and the craft.
