# Wizards

## Playable spells

Choose **Wizards** when creating a room or starting practice. The local fixture is
`http://wizards.localhost:1355/?sandbox=1&mode=wizards&seed=1&peaceful=1`.
It starts in the castle hall with passive dummies and the Frog Fountain staff.

- Move with WASD, arrows, or the existing Dvorak bindings. Left-click or V bonks for 18 damage.
- Approach a scroll on a table and press F. Stay nearby for two seconds to watch its rune, then the scroll burns.
- Hold right-click to draw on screen, then release to cast toward the stroke's centre. Movement remains available.
- Moon Ball is a circle followed by a stroke inward to a centre dot, all while holding right-click.
  Either direction and any starting point on the circle work.
- Necromancy is a downward zigzag ending in a leftward hook. Watch the scroll for the shape.
- Open the Lab with Backquote. **Spells → Show runes** displays practice hints; it defaults off.
  The same group holds spell speeds, sizes, lifetimes, skeleton stats, and recognition thresholds.
  Simulation tuning applies to the room host; the assist and recognition thresholds are local.

Each life starts without spells. Death drops one randomly selected known spell as a scroll.
The ordinary HUD lists learned spell names and icons. Other players can see a cast rune above its caster for 1.1 seconds.

Moon Ball grows as it drifts, captures players, furniture and skeletons, then pops after four seconds.
The pop deals 45 damage and flings its captives. A low-confidence moon is small, harmless and drifts sideways.
Necromancy raises a 60-health skeleton after a 1.5-second climb. It pursues the nearest living player, including its
caster, hits for 28, and lasts 20 seconds. Bonking it draws its attention for four seconds. A degraded skeleton crawls
and only pursues its caster. An unknown or unmatched rune fizzles.

`shared/sim/spells.ts` owns the fixed-tick simulation. Cast intents carry the recognized spell ID, quality and target;
the server validates the wire data, known spell and cooldown. Snapshots carry spell entities and moved furniture.
`src/game/runes.ts` uses 64 arc-length samples and normalized template distances, with circle start/direction variants.
The client suppresses movement prediction while an authoritative moon orbit or fling carries its player.
`src/game/spell-fx.ts` reuses the polar-shadow light path and the human rig for skeletons.

`OUT=<capture-directory> bun scripts/prove-wizards-spells.ts` runs real scripted mouse and keyboard input against the
Nexus preview using headless Metal Chromium. It reads both scrolls, draws runes, checks Dvorak movement during a stroke,
captures a dummy in a moon, verifies pop damage and caster pursuit, and checks a degraded cast.
`manual` and `bench` parameters expose the automation clock and inspection handle; gameplay tuning uses the Lab.
The inspected proof used Apple's `metal-3` adapter with no browser errors. Unit tests cover clean/noisy recognition,
orbit math, learning/drop/reset, nearest-target and aggro rules, degraded spells, protocol validation and deterministic replay.
Two simulated room connections verify server-side learning, broadcast casts, and host-only tuning. A live two-browser
room has not been exercised. Performance is unbenchmarked.

## Model study

Open the shared Lab with Backquote and enable **Wizards**. The switch replaces actor meshes and gives office floors a castle presentation. It is off by default; the simulation, map generation and weapon rules are unchanged.

- `anim.html?lab=1&only=a&zoom=7&side=125&elev=18`: walking staff carrier. Actors `b`, `d`, `e` show cyan, violet and green; `cast` studies the existing free-hand throw as a casting pose. `f` exercises death and ragdoll.
- `anim.html?lab=1&only=weapons&zoom=11&side=15&elev=18`: the three weapon props.
- `envlab.html?lab=1&fixture=room&x=8&y=5&zoom=30`: furniture fixture with torches, banners, bookshelves, table, benches and chandeliers.
- `?sandbox=1&lab=1&seed=1&peaceful=1`: playable office-layout castle.

The Frog Fountain staff, Thunder Lantern and Ice Saw replace rifle, shotgun and sniper models respectively. They have no spell mechanics. Team colours still come from the existing actor tint. Robes are matte; only eyes, gems and lantern cores glow. The original bones, IK, animation clips and ragdoll stay in use, with a one-handed hold for the staff.

`src/render/castle.ts` builds a presentation copy, retaining the source collision footprints and light IDs. Torches use the existing direct light, shadow, lamp-power and bounce paths. Flame power varies smoothly between 0.8 and 1.0. The room is a dev fixture, not a new map generator.

### Model proof

`OUT=<capture-directory> bun scripts/prove-wizards.ts` captures the viewers and sandbox using one headless Chromium process with Metal and muted audio, including a live off/on switch and a ragdoll frame. `URL` and `CHROME` can override the preview and browser executable. The script writes the adapter and any browser errors to `proof.json`. CPU/GPU cost has not been benchmarked.
