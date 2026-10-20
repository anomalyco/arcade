# Player body

`janitor.glb` — the player's own body (src/player/body.ts). Built by `scripts/player/build-body.ts` (Blender + MPFB 2):
a MakeHuman middle-aged man (base mesh and macro targets), skin `middleage_caucasian_male`, clothes
`male_casualsuit01` (re-tinted to a grey-green work shirt and charcoal work trousers), `shoes03` (re-tinted brown
leather work boots), hair `short02`, skinned to MPFB's `game_engine` skeleton with its bundled weights.

- MakeHuman base mesh, targets, rigs and weights (via MPFB 2.0.18): **CC0 1.0**.
  https://extensions.blender.org/add-ons/mpfb/ — the MPFB code is GPL-3.0, but its output (the generated mesh, rig and
  weights) is CC0 per the MakeHuman licence (§C assets CC0, §D output unrestricted):
  https://github.com/makehumancommunity/makehuman/blob/master/LICENSE.md
- MakeHuman system assets (clothes, shoes, skin, hair): **CC0 1.0**, explicitly released in September 2020 (Data
  Collection AB, Joel Palmius, Jonas Hauquier). Pack: makehuman_system_assets_cc0.zip,
  https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/

Motion capture baked into `janitor.glb` as the walking/idle loops (walk, walk_back, strafe_l, strafe_r, idle), cut and
transferred by `scripts/player/mocap.ts`:

- **100STYLE dataset**, "Neutral" style — Ian Mason, Sebastian Starke, Taku Komura, *Real-Time Style Modelling of
  Human Locomotion via Feature-Wise Transformations and Local Motion Phases*, 2022. **CC BY 4.0**
  (https://creativecommons.org/licenses/by/4.0/), https://zenodo.org/records/8127870. Attribution required: ship this
  credit with the game. Changes: cut into loops, retargeted, head/wrist motion reduced, arm roll re-derived.

Other animation clips baked into `janitor.glb` (retargeted onto the game_engine skeleton by `scripts/player/retarget.ts`):
jog, sprint, crouch_idle, crouch_walk, jump_start, jump_air, jump_land, interact, torch (fingers are posed at
runtime by src/player/hands.ts, not taken from any clip).

- Quaternius, **Universal Animation Library (Standard)**, March 2025: **CC0 1.0** (License.txt in the pack).
  https://quaternius.com/packs/universalanimationlibrary.html — fetched from a public mirror of the itch.io Standard
  zip (github.com/NafisRayan/Animate-Rigged-Humanoid-No-Blender, `UAL1_Standard.glb`).

The MakeHuman and Quaternius parts need no attribution; 100STYLE (CC BY 4.0) does.
