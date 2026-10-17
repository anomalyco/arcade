# Player body

`janitor.glb` — the player's own body (src/player/body.ts). Built by `scripts/player/build-body.ts` (Blender + MPFB 2):
a MakeHuman middle-aged man (base mesh and macro targets), skin `middleage_caucasian_male`, clothes
`male_casualsuit01` (re-tinted to a grey-green work shirt and charcoal work trousers), `shoes03` (re-tinted brown
leather work boots), hair `short02`, skinned to MPFB's `game_engine` skeleton with its bundled weights.

- MakeHuman base mesh, targets, rigs and weights (via MPFB 2.0.18): **CC0 1.0**.
  https://extensions.blender.org/add-ons/mpfb/ — the MPFB code is GPL-3.0, but its output (the generated mesh, rig and
  weights) is CC0 per the MakeHuman licence: http://www.makehumancommunity.org/content/license_explanation.html
- MakeHuman system assets (clothes, shoes, skin, hair): **CC0 1.0**, explicitly released in September 2020 (Data
  Collection AB, Joel Palmius, Jonas Hauquier). Pack: makehuman_system_assets_cc0.zip,
  https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/

No attribution is required. The animation is procedural (the arcade kit's human locomotion), no clips are shipped.
