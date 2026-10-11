# Salvo — design

Salvo is a side-view artillery game for 2–12 players with **no turns**. Every player aims at the same time during a short countdown. Then every shot fires at once, and the volley plays out together. You join from a shared link with just a name.

## Rules

- **Match:** a series of battles (3, 5 or 7, picked by the host). Free-for-all or two teams. Empty slots are filled by bots.
- **Battle:** a new procedurally generated map with seeded spawns. Each battle is a series of volleys and ends when one team (or no one) is left alive.
- **Volley:**
  1. **Aim phase (8 s).** Set angle and power with the mouse or keyboard, pick a weapon, and spend move fuel to reposition (A/D). Lock in with SPACE. The phase ends early when every living human has locked.
  2. **Resolve.** Every shot is simulated together on the server and played back on every client. Mid-air shells collide and detonate. Destroyed units explode.
- **Mind games:** while aiming you see other players' ghost arcs, but only the first ~30% of each. That's enough to read intent but not the landing point.
- **Wind** follows a seeded random walk between volleys. It pushes every projectile.
- **Damage:** explosions use radial falloff. Falling more than about 26 px causes fall damage. Falling terrain chunks crush units they land on. Units die if they drop off the map or under the hazard.
- **Sudden death:** from volley 6 of a battle, a glowing hazard rises from the bottom each volley and kills anything below it, so battles stay short.

## Weapons

The full set matches the concept sheets (`weapons-1-sheet.png`, `weapons-2-projectiles.png`).

| Weapon | Behavior | Signature |
| --- | --- | --- |
| Shell | Standard HE round, unlimited ammo | White core, orange fireball, shockwave ring, debris |
| Cluster | Splits at the apex into 6 bomblets | A spread of magenta pops |
| MIRV | 3 warheads released at the apex | Violet triple impact |
| Drill | Bores a tunnel for about 3 s, then detonates | Cyan sparks along the tunnel |
| Napalm | A burning pool that flows downhill and damages each tick | Orange flames |
| Gravity well | A vortex that pulls in shells and units, carves a cavity, then implodes | Violet imploding ring |
| Builder | Raises a rock wall | Green rising grid |
| Airstrike | 4 bombs in a line from above | Yellow streaks, a row of craters |
| Bouncer | Ricochets 3 times, then detonates | Mint |
| Bunker buster | Penetrates deep, then a heavy delayed blast | Deep red |
| Shield | Fires nothing; projects a 40 HP barrier for this volley | Hex bubble |
| Teleport | Fires a beacon; your unit moves to where it lands | White beam |

## Power-ups (crates)

Crates parachute in at procedural positions between volleys. **You claim a crate by shooting it**, so crates turn into a race. Possible contents:

- credits
- weapon ammo
- shield
- damage boost (x1.5 for your next volley)
- repair
- targeting lens (a longer aim preview)
- fuel

## Progression

- **Within a match:** you earn credits for damage (about 1 per HP), kills (150), surviving a battle (100) and winning a battle (250). You spend them in the between-battle **armory** on weapon ammo and upgrades (armor plating, fuel tank, targeting lens, damage boost, repair kit). The scoreboard tracks kills, damage, wins and credits.
- **Nothing to unlock.** Every unit class and every weapon is available from the start. The browser only remembers your name and last unit.
- **Unit classes** come from the lineup concept. Each has different HP, fuel and launch power, plus a passive:

| Class | Passive |
| --- | --- |
| Mortar Crawler | Starts each battle shielded |
| Wheeled Howitzer | Extra cluster round |
| Rocket Buggy | Double fuel |
| Rail Cannon | Higher muzzle velocity |
| Hover Drone | No fall damage |
| Missile Walker | Climbs steep slopes |
| Siege Tank | +20% damage, less fuel |
| Mast Catapult | Half wind effect |

## Procedural content

Nothing is baked or hand-placed:

- **Terrain:** seeded per battle. It has several biome profiles (rolling hills, central canyon with a rock bridge, mesas, overhangs) built from layered noise, plus caverns and tunnels. Spawn shelves are flattened so spawns are fair.
- **Spawns, wind and crate drops** are all seeded.
- **Movement** is rule- and physics-based. Units walk along the surface, climb small steps, refuse slopes that are too steep, and burn fuel. They also slide down steep slopes and fall when the ground under them is removed.
- **Collapse:** after carving, a flood fill finds terrain that is no longer attached to the ground. Those pieces become falling chunks that land and crush units.
- **Backdrop:** pine lines, mid ridges, mist bands and rock strata are generated per battle seed on top of the one generated far-sky plate (`art/bg-far.png`).

## Netcode

- One **Room Durable Object** per room (`/labs/salvo/ws/:room`). It holds the authoritative `Match` state machine from `src/sim/match.ts`: lobby → aim → resolve → … → shop → … → over.
- Clients send intents: `aim`, `move`, `lock`, `buy`, `ready` and `start`. The server validates them.
- At the end of the aim phase the server runs the deterministic volley simulation (`src/sim/volley.ts`, fixed 1/120 s steps, seeded RNG, integer-free but order-stable) once. It broadcasts the shots, the full event timeline, the projectile paths, and the before and after state (both including the packed terrain mask) along with a state hash.
- Clients **play back** the timeline: they interpolate projectiles along the sampled paths and replay terrain events onto their local mask exactly (`src/sim/replay.ts`). Then they snap to the authoritative `after` state, so a client can never desync for more than one volley.
- Ghost aims are relayed at most once every 100 ms.
- Players who join mid-battle spectate until the next battle. Reconnecting with the same `pid` rejoins the same player.
- **Solo play** runs the same `Match` in the browser (`createLocal()`), so bots and offline play use exactly the same rules.

## Render pipeline (Canvas2D)

The layers, from back to front:

1. Far plate (the generated image), with slow parallax.
2. Procedural mid ridges, pines and mist bands, with medium parallax.
3. Terrain canvas: built from the mask using a graphite gradient with strata texture and noise, an edge pass for the cool rim light, and faint inner contours. Dirty-rect rebuilds keep it fast during carving.
4. Units, chevrons and crates.
5. Additive glow layer: trajectory arcs, projectiles, explosions, shockwaves, debris and fire.
6. Floating damage numbers and the hazard glow.
7. DOM HUD overlay (the aim HUD, shop, lobby and results), separate from the canvas.

The camera fits the 1200×640 world to the viewport and frames live action during resolve. Juice comes from screen shake, hit-stop and slow motion on multi-hits and kills, and flashes.
