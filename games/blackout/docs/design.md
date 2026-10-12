# Blackout: design

A top-down stealth deathmatch for 4–12 players in the browser. Dark maps, one hit kills, and you are invisible
unless you stand in light, run, or fire. Every sound you make is drawn as a ring that everyone sees. The art
direction is **A. Noir minimal** from `concept/` (near-black, white light pools, crisp white ripples, restrained team
colours). The concept mockups are AI-generated and were used as targets, not captures.

## Pacing

Slow and intense is the top priority. Every number below serves quiet tension and short, decisive violence.

- Movement has three stances. **Sneak** (C, held) is silent and slow (1.5 m/s). **Walk** (default, 2.8 m/s) leaves soft
  footstep rings. **Run** (Shift, 5.6 m/s) leaves loud rings and makes you visible for ~0.9 s after each stride.
- Weapons are slow and punishing. Every shot has a wind-up (pistol 0.2 s, shotgun 0.45 s, crossbow 0.7 s) before the
  bullet leaves, so committing to a shot matters. Ammo is scarce, and reloads make noise (except the crossbow).
- A round lasts up to 3 minutes. Each player has one life per round. The match is best-of-five rounds.
- Dead players spectate with no living positions. They see lamps, rings and flares, so they still feel the tension.
- After 50% of the round, lamps begin to fail (one every ~14 s, flickering first), so games resolve without frenzy.
- Kill feedback is restrained: a sharp ring, a 0.25 s freeze of the victim's frame, a feed line and a short killcam.
  No particles, no bounce, no score popups.
- Audio is sparse: a low room tone, distant rings, and a heartbeat that rises when an enemy ring lands close.

## Light, visibility and noise model

The shared rules live in `shared/` so the server (authority) and the client (rendering and prediction) use the same
numbers. The server alone decides who is visible.

**Light.** A lamp has a position, radius `r` (metres), power `p` and a colour. Its intensity at distance `d` is
`p · (1 − d/r)²` for `d < r`, and it is blocked by walls. A point is **lit** when the strongest unblocked light reaches
`LIT_THRESHOLD = 0.3`. Lamps can be shot out, EMP-ed (dimmed for 12 s), or fail on their own late in a round. Flares
are temporary lights: they arc in, land, ramp up over 0.4 s, hold for ~7 s and fade.

**Exposure.** A player is *exposed* when any of these hold:
- they are lit;
- they ran in the last 0.9 s;
- they fired in the last 1.2 s.

**Visibility.** Viewer `v` sees target `t` only if `v` is alive, `t` is alive and exposed, the distance is at most
34 m, and the segment from `v` to `t` is clear of walls and closed doors. Dead viewers see no players. Visibility does
not depend on team. Teammates are not revealed to each other.

**Noise (ripples).** Each noise source emits a ripple: origin, maximum radius `r`, kind and time. Ripples go to
every connected viewer, since the spec says everyone sees them. A ring expands to `r` over about 1 s. The radius tells
you how far the sound carries.

| Source                   | Ripple radius | Notes                                     |
| ------------------------ | ------------- | ----------------------------------------- |
| Sneak                    | none          | silent                                    |
| Walk footstep            | 8 m           | every 0.55 s; ×1.5 on grate or puddle     |
| Run footstep             | 18 m          | every 0.33 s; ×1.5 on grate or puddle     |
| Pistol (suppressed)      | 14 m          |                                           |
| Shotgun                  | 40 m          |                                           |
| Crossbow                 | none          | bolt thud on impact, 6 m                  |
| Reload (pistol/shotgun)  | 18 / 22 m     | clack at the start of the reload          |
| Lamp shot out            | 30 m          | jagged glass ring                         |
| Door slam                | 16 m          | opening is quiet: a 5 m creak             |
| Flare landing            | 6 m           |                                           |
| Decoy                    | 26 m          | three pings over 3 s                      |
| EMP                      | 14 m          | jagged                                    |
| Mine detonation          | 22 m          | jagged                                    |

## Rounds and modes

- **Lobby.** The host (first connected human) sets mode (`tdm` or `ffa`), rounds (3 or 5) and map, then starts. Bots fill
  the room to four players. A room is `/labs/blackout/?room=<code>`, with no accounts; a name is the only input.
- **Loadout** (8 s). Pick a primary weapon and two gadgets.
- **Live** (up to 180 s). The round ends when one team (or one player in FFA) has no one alive. Time running out is a
  draw.
- **Over** (5 s). Round result. Next round, or the match ends at the majority.
- **Match over** (14 s). Scoreboard, awards and XP. Then the lobby, with rematch.

Players who join mid-round spectate until the next loadout. Bots only live during a match.

## Loadouts

| Primary           | Mag / reserve | Wind-up | Range | Noise         |
| ----------------- | ------------- | ------- | ----- | ------------- |
| Suppressed pistol | 6 / 18        | 0.2 s   | 30 m  | 14 m ring     |
| Shotgun           | 2 / 8         | 0.45 s  | 10 m  | 40 m ring     |
| Crossbow          | 1 (retrieve)  | 0.7 s   | 36 m  | silent        |

Gadgets (pick two): **Flare** (×2, throw 9 m, lights 10 m for ~7 s), **Noise decoy** (×2, three 26 m pings),
**Light-breaker EMP** (×1, 9 m, dims lamps for 12 s), **Motion mine** (×2, arms in 1.2 s, detonates on any enemy within
1.6 m, 2 m kill radius, 22 m ring).

## Maps

Maps are TypeScript data in `shared/maps/`. Each has walls (rectangles that block light and movement), doors, lamps,
spawns, nav points for bots and noisy surfaces. Warehouse (44 × 30 m) is first. Office Tower FL 12, Rooftop (Rain) and
Industrial Yard are next.

## Progression

Local profile in `localStorage` (`blackout.profile`): XP and level, stats, and unlocks. Level 1 has the pistol and
the flare, decoy. Level 2 unlocks the shotgun, level 3 the crossbow, level 4 the EMP and level 5 the mine. XP comes from
participation, kills, round wins and awards. Per-match awards are computed on the server: **Ghost** (never seen),
**Lights Out** (lamps shot out), **Loudest** (most ripples), **Patience** (longest still time).

## Netcode

- The Worker routes `/labs/blackout/ws/<room>` to a `Room` Durable Object, one per room code.
- The DO runs `World` (from `shared/`) at 30 Hz. Each human sends one intent per tick (`seq`, movement, stance, aim,
  fire, reload, gadget, use). The server applies one queued intent per tick.
- **Visibility filtering.** For each viewer the server computes the visible set and sends only those players. Hidden
  players are never sent, not even as dimmed or ghosted positions. `shared/sim/view.ts` builds each snapshot. Tests
  check that hidden players stay out of it.
- Snapshots go out at 15 Hz with lamps, doors, flares, your own state and the visible players. Events (ripples, kills,
  lamp breaks, the killcam tracer) go out as they happen, each filtered by audience.
- Prediction: the client predicts its own movement with the shared `stepMove` and replays unacked intents on each
  snapshot. Other visible players are smoothed toward their last server position.
- Bots run on the server with the same perception as humans. They hear rings they could hear and see only what a
  viewer could see. They have no knowledge of the map beyond its nav points.

## WebGPU render pipeline

1. **Shadow compute.** For each light slot (lamps, flares, and the local eye), 720 rays are cast against the wall
   rectangles. Each stores the distance to the first occluder (`polar` buffer).
2. **Floor pass** (fullscreen). Procedural concrete with noise. Light is summed per pixel over all slots, with
   occlusion read from the polar buffer, and multiplied by the local eye mask (the local player's line of sight). A very
   faint ambient keeps the layout readable in the dark.
3. **Wall pass** (instanced quads, lit). Top faces take the light with a small bias so tops stay visible in pools.
4. **Glow pass** (additive). Lamp bulbs, flare bodies and light halos.
5. **Tracer pass** (additive): shot lines for the shooter and the killcam.
6. **Actor pass** (alpha). Visible players (lit by the same light sum, plus a rim so revealed players read in the dark),
   own mines, bolts and projectiles.
7. **Ripple pass** (additive). Crisp SDF rings with a thin bright edge.
8. **Composite.** Vignette, film grain and a slight cool grade.

The HUD is DOM: a minimap on a 2D canvas, a round timer and score, the kill feed, a visibility meter, a noise label,
ammo, gadget slots and a heartbeat pulse. Without WebGPU the page shows a clear message.
