# Barbara's car

`car.glb` is "Kiri '86 - Low poly model" (listed in Objaverse as "Japanese sedan '86 - Low poly model"), a generic
mid-80s Japanese saloon, by Daniel Zhabotinsky (https://sketchfab.com/DanielZhabotinsky):
https://sketchfab.com/3d-models/5c17c582ef9549798f694b660feea42a, licensed CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/). Fetched from the Objaverse dataset
(https://huggingface.co/datasets/allenai/objaverse, object licence "by" in its metadata); the source GLB's SHA-256 is
in `sources.json`. It stands in for STORY.md's blue 1993 Lexus ES: the closest licence-clean crisp, boxy, upright
Japanese saloon found.

What changed (`scripts/car/build-car.ts` and `build-car.py`, headless Blender):

- Scaled to 4.62 m, turned nose to −Z, tyres on y = 0; the engine, hood and trunk-lid insides and the badges removed.
- The driver's door cut onto its own hinge node and swung open 55°.
- Repainted dark metallic blue under a gloss clear coat, with a light generated film of dust, a few leaf stains, sill
  grime, wheel splash and streaks; a few fallen leaves added on the roof, hood and trunk; a pink donut box added on the
  passenger seat.
- Window glass replaced with a dark gloss; materials merged per kind, textures reduced to at most 1024² WebP, a
  decimated LOD1 added, meshopt-compressed.
