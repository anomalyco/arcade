# Wizards

## Playable spells

Choose **Wizards** when creating a room or starting practice. The local fixture is
`http://wizards.localhost:1355/?sandbox=1&mode=wizards&seed=1&peaceful=1`.
It starts in the castle hall with passive dummies and the Frog Fountain staff.

- Move with WASD, arrows, or the existing Dvorak bindings. Shift sprints; V bonks for 18 damage.
- Left-click casts toward the cursor. Keys 1/2 or the wheel select Moon Ball / Necromancy.
  Quick taps are latched until the next tick; holding the button does not repeatedly cast.
- Both spells are ready on every spawn. The two HUD slots show selection, cooldown and when a spell's active cap is full.
- Backquote opens the shared Lab. **Spells** holds cooldowns, moon anticipation/speed/size/lifetime and skeleton stats.
  Only the host changes authoritative room tuning. Camera angle is client-local.

The click prototype has no scroll gate or rune interaction. The recognizer and its sampling tests remain in
`src/game/runes.ts` as isolated research.

Moon Ball forms for 0.18 seconds, travels at 2.3 m/s, captures players, furniture and skeletons, then pops at 3.2 seconds.
The pop deals 45 damage and flings its captives. Its cooldown is 0.85 seconds, with two active moons per caster and
eight per room. Necromancy has a 1.4-second cooldown and caps of three per caster and twelve per room. It raises a
45-health skeleton in 0.6 seconds, at least 2.5 m from the caster. Blocked or occupied placements are rejected without
consuming cooldown. The skeleton pursues the nearest living player, including its caster, winds up for 0.35 seconds,
hits for 18, and lasts twelve seconds. Bonking it interrupts the swing and draws its attention for four seconds.

`shared/sim/spells.ts` owns the fixed-tick simulation. Cast intents carry the spell ID and target. The legacy quality
field is accepted on the wire but ignored by these rules; all click casts have full power. The server controls cooldowns,
placement and entity limits. Snapshots carry cooldown deadlines, spell entities and moved furniture.
The client suppresses movement prediction while an authoritative moon orbit or fling carries its player.
`src/game/spell-fx.ts` reuses the polar-shadow light path and the human rig for skeletons.

From the repository root, run `hivemind run --kind browser --fetch captures/wizards-click -- bun games/blackout/scripts/prove-wizards-spells.ts`.
It starts an isolated loopback Vite fixture on the worker and uses muted headless Metal Chromium. `URL` selects an
existing preview; `OUT` overrides the output directory. It exercises quick taps, rapid clicks, independent cooldowns,
keys/wheel, Dvorak movement, active limits and Lab click isolation, then captures moon pickup/pop and a skeleton attacking
its caster. The output includes an eight-second hardware-encoded clip, gameplay stills and `proof.json`.
`manual` and `bench` parameters expose the automation clock and inspection handle; gameplay tuning uses the Lab.
Unit tests cover orbit math, spawn readiness, cooldowns/limits, placement, targeting/aggro, protocol validation and
deterministic replay. Two simulated room connections verify broadcast casts, ignored quality claims and host-only tuning.
A live two-browser room has not been exercised. Performance is unbenchmarked.

The click proof passed on Apple's `metal-3` adapter with zero browser errors. Blackout's full check passed 284 tests.
The 1100×800 captures and eight-second clip show the gameplay camera, with the rune-era capture retained for comparison.
The room is still a simple arena: materials and architecture remain much plainer than the great-hall concept, and the
skeleton's thin limbs need more shape work. The lower camera angle makes its skull and open ribs easier to see.

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
