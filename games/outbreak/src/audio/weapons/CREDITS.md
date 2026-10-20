# Weapon sound credits (AR-102)

Every `wpn.*` sound is synthesized at run time by `dsp.ts` in this folder (noise, resonant modes, pitch-falling
sines, discrete echoes and decaying noise tails, seeded per take). No recording, sample pack or generated audio file
is used, so there is nothing to license and nothing a stream can be flagged for.

Played alongside them, unchanged, from the shared library (`packages/kit/audio/library-files.ts` lists each file's
source and licence; all are the project's licensed ElevenLabs SFX generations or the project's own files):

- `melee.hit.metal`: the ringing bell kept for heavy, head and finishing hits with metal tools.
- `zombie.hit`: under the synthesized flesh impact, at half level.
- Every Today sound named as a `fallback` (`gun.pistol.shot`, `gun.casing`, `impact.bullet.*`, `melee.*`, `flare.*`,
  `bomb.explode`…), which plays only while the layered sound is still baking or when the Lab is set to Today.
