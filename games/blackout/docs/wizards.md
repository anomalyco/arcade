# Wizard model study

Open the shared Lab with Backquote and enable **Wizards**. The switch replaces actor meshes and gives office floors a castle presentation. It is off by default; the simulation, map generation and weapon rules are unchanged.

- `anim.html?lab=1&only=a&zoom=7&side=125&elev=18`: walking staff carrier. Actors `b`, `d`, `e` show cyan, violet and green; `cast` studies the existing free-hand throw as a casting pose. `f` exercises death and ragdoll.
- `anim.html?lab=1&only=weapons&zoom=11&side=15&elev=18`: the three weapon props.
- `envlab.html?lab=1&fixture=room&x=8&y=5&zoom=30`: furniture fixture with torches, banners, bookshelves, table, benches and chandeliers.
- `?sandbox=1&lab=1&seed=1&peaceful=1`: playable office-layout castle.

The Frog Fountain staff, Thunder Lantern and Ice Saw replace rifle, shotgun and sniper models respectively. They have no spell mechanics. Team colours still come from the existing actor tint. Robes are matte; only eyes, gems and lantern cores glow. The original bones, IK, animation clips and ragdoll stay in use, with a one-handed hold for the staff.

`src/render/castle.ts` builds a presentation copy, retaining the source collision footprints and light IDs. Torches use the existing direct light, shadow, lamp-power and bounce paths. Flame power varies smoothly between 0.8 and 1.0. The room is a dev fixture, not a new map generator.

## Proof

`OUT=<capture-directory> bun scripts/prove-wizards.ts` captures the viewers and sandbox using one headless Chromium process with Metal and muted audio, including a live off/on switch and a ragdoll frame. `URL` and `CHROME` can override the preview and browser executable. The script writes the adapter and any browser errors to `proof.json`. CPU/GPU cost has not been benchmarked.
