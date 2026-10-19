# Licensing audit before pushing `afterhours` to the public repo

Audited on 2026-10-18. The range is `origin/main..afterhours` (36 commits). `github.com/anomalyco/arcade` is
**public** (confirmed with `gh repo view`), so every blob in every one of these commits becomes publicly
redistributable, including files that were later deleted or replaced. This is not legal advice.

Method: I listed every path added in any commit of the range (`git log --diff-filter=A --name-only`, 1,275 paths, deleted
files included) and checked every non-code file. I verified licences against the source or licence text wherever
possible:

- All 31 Sketchfab models: both the Objaverse 1.0 metadata (the source of our files) and the live Sketchfab API.
- All 36 Poly Haven assets and 12 ambientCG assets, through their APIs.
- 100STYLE, through the Zenodo API.
- Special Elite, through google/fonts `METADATA.pb`.
- The CMU mocap FAQ, the Quaternius UAL page and the MakeHuman `LICENSE.md`.
- The ElevenLabs Terms, ElevenAPI Terms and ElevenCreative Terms, all last updated 2026-10-09.
- The Adobe terms, as already researched in `mixamo-licensing.md`.

## Summary

| Verdict | Assets |
| --- | --- |
| **Must purge from history** | Mixamo characters and clips (`public/models/characters/*.glb`). **All ElevenLabs audio files** (`audio-lab/sfx/**/*.mp3`, `audio-lab/sfx-raw/**/*.mp3`, `public/sfx/**/*.ogg`): 724 files, about 63 MB of blobs including the GLBs. |
| Purge recommended (conservative) | `roster.json` (two copies). It holds Mixamo-derived per-frame root paths and per-clip metadata. |
| OK to publish, with a fix to the credits | `office_chair.glb` (licence mislabelled), `SpecialElite-hud.woff2` (Apache-2.0 text missing), `basis_transcoder.*` (Apache-2.0 text missing) |
| OK to publish as is | Everything else: Poly Haven and ambientCG CC0 textures (KTX2 and the deleted JPGs), Poly Haven CC0 models, the other 30 Sketchfab CC BY models (attribution present), MakeHuman, UAL, 100STYLE and CMU bodies, AI concept art, AI document images, document atlas, generated noise |

Not committed anywhere in the range, as confirmed in the blob list:

- No `.fbx` files.
- Nothing under `mixamo-src/` or `captures/` (both are gitignored).
- No `.blend`, `.bvh`, `.amc` or `.zip` files.
- No 100STYLE or CMU source mocap; only baked clips inside the GLBs.

## The new finding: ElevenLabs forbids publishing the sound files themselves

The ElevenLabs Sound Effects terms are stricter than Mixamo's, and they are explicit. ElevenAPI Terms §1.2 pulls the
service-specific terms into API use, and `audio-lab/lib/eleven.ts` calls `api.elevenlabs.io/v1/sound-generation`.
ElevenCreative Terms, Exhibit 4 (Sound Effects), §2 "Use of Output" (<https://elevenlabs.io/creative-terms>, last
updated 09 October 2026) says:

> You may use, reproduce, modify, distribute, publicly perform, and display Output, including by incorporating it into
> films, trailers, advertising, video, games, applications, and other productions [...] and for commercial purposes
> only where your plan permits commercial use. **You may exercise those rights only in respect of Output combined with
> other material, and you may not [...] distribute [...] Output, or any part of it, on a standalone basis, or make
> Output available as isolated audio files or samples, or as part of any sound, sample, effects, or music library or
> other collection of sounds.**

- `audio-lab/sfx/` (407 mp3, 201 of them under `_previous/`) and `audio-lab/sfx-raw/` (205 mp3) are literally a
  categorised "collection of sounds" stored as isolated audio files. Publishing them is **clearly not allowed**.
- `public/sfx/` (112 Opus `.ogg` files cut from the picks) are served as part of the game, which is allowed. Committed
  to a public repo, though, each one can be downloaded on its own, which matches "isolated audio files". This is
  the same grey-leaning-no position as the Mixamo GLBs, but the wording here is plainer, so treat it as **not
  allowed**.
- Ownership is not the problem: ToS §4(c)(ii) says you retain rights in Output. The problem is the use restriction
  above. No attribution is required.
- Plan: commercial use needs a paid plan (ToS §1(c)). The manifest records 54,117 credits spent, which is more than
  the free tier allows, so the account is almost certainly paid. Confirm which account the `ELEVEN_LABS_API_KEY` belongs to.
  `origin/main:docs/sfx-library.md` records "ElevenLabs commercial sound-generation license (Anomaly)".
- **Already on the public `main` branch (outside this range):** `games/getaway/public/sfx/` has 65 ElevenLabs mp3
  files that are already public. The same clause applies to them, so flag this to the repo owner separately.

Fix: handle the audio exactly like the Mixamo plan in `mixamo-licensing.md`, option (b). Keep the takes and the shipped
`.ogg` files in private storage (for example a private R2 bucket), fetch them at build time in CI with a secret, and
commit only `audio-lab/sfx/manifest.json` (prompts and metadata, which are fine), `src/audio/sfx-manifest.ts` and the
scripts. Without the files the game must still boot, silently. Today `scripts/audio-build.ts` reads
`audio-lab/sfx/<cat>/<v>.mp3`, so it would also need the private fetch.

## Asset table

"Attribution" means whether a credit is required, and whether it is present in the repository.

### Models and characters

| Asset (paths under `games/afterhours/`) | Source | Licence (verified) | OK to publish in a public repo | Attribution |
| --- | --- | --- | --- | --- |
| `public/models/characters/{remy,louise,james,megan,kate}.glb` (Mixamo stock characters, converted) | Adobe Mixamo | Adobe General Terms §3.6 Content Files; Mixamo Additional Terms (AI/ML ban) | **No.** No standalone distribution; see `mixamo-licensing.md` | Not required. A notice is still recommended wherever the files are stored |
| `public/models/characters/anims.glb`: 40 Mixamo clips baked onto Remy's skeleton; three versions in history (9624260b, 2b24cce9, 5f1ef2f4) | Adobe Mixamo | Same | **No** | Same |
| `public/models/characters/roster.json` and `src/playerb/roster.json` (identical; 82 KB) | Derived from the Mixamo files by `scripts/playerb/mixamo.py`: mesh and bone stats, and per-clip timing, speeds, foot contacts and **per-frame root x/z/yaw paths** (`root` arrays of 29–192 frames) for one-shots, mantles and vaults | Derived data from Adobe Content Files | Grey, low risk. It is measurement data, not a reusable animation, but it is a "derivation" of the clips | n/a |
| `public/models/player/janitor.glb` (6 versions) | MakeHuman via MPFB 2.0.18 (mesh, rig, weights, clothes, skin, hair); Quaternius UAL1 Standard (jog, sprint, crouch, jump, interact, torch); 100STYLE "Neutral" (walk, back, strafes, idle, run, jog_back, jog_l, jog_r) | MakeHuman assets **CC0 1.0** (makehuman `LICENSE.md` §C/§D); UAL **CC0** (quaternius.com pack page); 100STYLE **CC BY 4.0** (Zenodo 8127870 metadata: `cc-by-4.0`) | Yes | 100STYLE credit required and present in `public/models/player/CREDITS.md`. The others need none. The MakeHuman URL there is an outdated page; point it to the current `LICENSE.md` |
| `public/models/playerb/janitor_b.glb` (2 versions) | MakeHuman/MPFB (CC0); UAL (CC0); CMU mocap takes 07_01, 07_12, 16_02, 16_35, 127_06, 143_39, 143_40; Carry_* poses authored in `carry.py` | CC0; CMU: "may be copied, modified, or redistributed without permission" (mocap.cs.cmu.edu FAQ) | Yes | CMU credit is requested, not required. It is present in `public/models/playerb/CREDITS.md` |
| `src/playerb/clips.json` | CMU take numbers, frame ranges and measured speeds | CMU (free) | Yes | Covered by the playerb CREDITS |
| 30 Sketchfab models via the Objaverse 1.0 mirror: `car_wagon`, `car_sedan`, `car_sedan_b`, `car_pickup`, `van`, `box_truck`, `dumpster`, `bench`, `traffic_cone`, `pallet`, `filing_cabinet`, `filing_cabinet_open`, `crt_terminal`, `telephone`, `glassware`, `vending_machine`, `water_cooler`, `radiator`, `space_heater`, `coat_rack`, `drinking_fountain`, `desk_fan`, `fire_extinguisher`, `urinal`, `toilet`, `lavatory`, `tp_holder`, `towel_dispenser`, `waste_basket`, `hand_dryer` (`.glb`) | Sketchfab authors listed in `public/models/CREDITS.md` | **CC BY 4.0**. Each UID was checked in the Objaverse metadata (`license: by`) and on the live Sketchfab API (`by`). Note: `tp_holder` is titled "CC0 - …" but is licensed CC BY, so treat it as CC BY | Yes | Required. Present: title, author, link, licence and "modified" lines in `public/models/CREDITS.md`, which is copied into `dist/` and served. The six car titles are the authors' current Sketchfab titles; Objaverse has older names. Both are acceptable |
| `public/models/office_chair.glb` | "Office Chair" by nokillnando, Sketchfab `b228a29f…`, via Objaverse | **Mismatch.** Objaverse 1.0 metadata, the copy we downloaded: **CC BY-SA 4.0**. Live Sketchfab today: CC BY 4.0 | Yes, with the right notice | Required. **CREDITS says CC BY 4.0, which is wrong for the copy we used.** Fix below |
| 31 Poly Haven models (`covered_car`, `fire_hydrant`, `trash_can`, `drum_steel`, `drum_hazard`, `crate_wood`, `milk_crate`, `cardboard_box`, `utility_box`, `utility_box_b`, `ac_unit`, `security_light`, `tyre`, `trashbag`, `hand_truck`, `office_desk`, `stack_chair`, `television`, `metal_rack`, `steel_shelves`, `chemistry_set`, `microscope`, `wall_clock`, `desk_lamp`, `lab_stool`, `lounge_chair`, `wet_floor_sign`, `fluorescent_light`, `security_camera`) | polyhaven.com. Every slug was resolved through `api.polyhaven.com/info` | **CC0 1.0** (polyhaven.com/license) | Yes | Not required; sources are listed |
| `public/models/manifest.json`, `public/models/documents/manifest.json` | Generated | n/a | Yes | n/a |

### Textures, documents and images

| Asset | Source | Licence (verified) | OK to publish | Attribution |
| --- | --- | --- | --- | --- |
| `public/textures/*/albedo.ktx2`, `surface.ktx2` (19 sets) | Poly Haven: `asphalt_02`, `worn_asphalt`, `forrest_ground_01`, `withered_grass`, `wood_textured_concrete`, `concrete_floor_worn_001`, `rough_wood`. ambientCG: `Gravel022`, `Ground072`, `Ground048`, `Concrete033`, `Bark014`, `PaintedMetal001`, `Metal032`, `Metal046B`, `OfficeCeiling001`, `Terrazzo019S`, `Plaster001`, `SurfaceImperfections003`. All IDs were resolved through the APIs | **CC0 1.0** (polyhaven.com/license, docs.ambientcg.com/license) | Yes | Not required; listed in `public/textures/CREDITS.md` |
| `public/textures/*/{color,arm,normal}.jpg` (57 files, added in 7aa24726, deleted in c5918210, still in history) | Same sources. `fetch-textures.ts` at 7aa24726 has the same ID table | CC0 1.0 | Yes | Not required |
| `public/textures/noise.bin` | Generated by `scripts/fetch-textures.ts` | Own | Yes | n/a |
| `public/textures/basis/basis_transcoder.{js,wasm}` | Byte-identical copy of `three/examples/jsm/libs/basis` (Binomial Basis Universal) | **Apache-2.0** | Yes | Apache §4(a) requires a copy of the licence when redistributing. **No licence text is committed next to it** |
| `public/models/documents/{base,normal,orm}.ktx2` (document atlas, two versions of `base`) | Rendered by `scripts/build-documents.ts`: invented text, fonts rendered into the image, AI images | Fonts: Apache-2.0 and OFL-1.1, which allow rendered output; no font files are shipped. Images: AI-generated | Yes | Not required; listed in `documents/CREDITS.md` |
| `scripts/documents/images/{bowling,cat,polaroid-corridor,polaroid-dish}.jpg` | AI-generated for the project (per `documents/CREDITS.md`). Inspected: generic clip art and photos, no logos | Model output, owned by the user; no third-party content | Yes | n/a |
| `concept/*.png` (41 images) | AI-generated concept art (the tool isn't recorded). Inspected as a contact sheet: no brands or logos; generic "DINER", "VACANCY" and "EXIT" signs only | Model output | Yes | n/a. Optionally note "AI-generated concept art" in `BRIEF.md` |

### Fonts and audio

| Asset | Source | Licence (verified) | OK to publish | Attribution |
| --- | --- | --- | --- | --- |
| `public/fonts/SpecialElite-hud.woff2` | Special Elite by Astigmatic (Brian J. Bonislawsky), google/fonts `apache/specialelite`, subset with pyftsubset | **Apache-2.0** (`METADATA.pb`: `license: "APACHE2"`, "Copyright (c) 2010 by Brian J. Bonislawsky DBA Astigmatic (AOETI)") | Yes | §4(a) requires a copy of the licence, and §4(b) requires a notice of modification. The README covers the modification, but **the licence text is missing**. The repo precedent is `games/wings/public/fonts/OFL-*.txt` |
| `audio-lab/sfx/**/*.mp3` (407 files, including `_previous/`) and `audio-lab/sfx-raw/**/*.mp3` (205 files) | ElevenLabs `eleven_text_to_sound_v2`, generated through the API | ElevenCreative Terms Ex. 4 §2 (quoted above) | **No.** This is a collection of isolated sound files | Not required |
| `audio-lab/sfx/manifest.json`, `picks-*.json`, `ship-outdoor-night.json` | Prompts, metadata and picks | Own | Yes | n/a |
| `public/sfx/**/*.ogg` (112 files) | Cut and encoded from the ElevenLabs picks by `scripts/audio-build.ts` | ElevenCreative Terms Ex. 4 §2 | **No** as committed files; serving them in the game is fine | Not required |

### Code and miscellaneous

| Asset | Source | Licence (verified) | OK to publish | Attribution |
| --- | --- | --- | --- | --- |
| `bench/wasm/src/lib.rs`, `Cargo.lock` | Own code (the lockfile only lists crates; no vendored code) | Own | Yes | n/a |
| `scripts/playerb/mixamo.py`, `characters.ts`, `compare-page.ts`, `CLIPS.md`, `docs/mixamo-licensing.md` | Own code and docs that process or describe Mixamo files; they contain no Mixamo data | Own | Yes | n/a |
| `scripts/playerb/__pycache__/*.pyc` (4), `.tmp/mont.py` | Build junk | Own | Yes. Remove anyway (hygiene, not licensing) | n/a |

Renders and captures: none are committed (`captures/` is gitignored and absent from the blob list). Renders of
Mixamo characters would be fine anyway.

## Paths that must be purged from history before the push

All of these paths are under `games/afterhours/`, and every version in `origin/main..afterhours` must go.

**Mixamo (Adobe §3.6, no standalone distribution):**

```
games/afterhours/public/models/characters/remy.glb
games/afterhours/public/models/characters/louise.glb
games/afterhours/public/models/characters/james.glb
games/afterhours/public/models/characters/megan.glb
games/afterhours/public/models/characters/kate.glb
games/afterhours/public/models/characters/anims.glb
```

**ElevenLabs (ElevenCreative Ex. 4 §2, no isolated audio files or sound collections):**

```
games/afterhours/audio-lab/sfx/**/*.mp3        (407 files, including audio-lab/sfx/_previous/**)
games/afterhours/audio-lab/sfx-raw/**          (205 mp3 files)
games/afterhours/public/sfx/**/*.ogg           (112 files)
```

Keep `games/afterhours/audio-lab/sfx/manifest.json`.

**Recommended (conservative, Mixamo-derived metadata):**

```
games/afterhours/public/models/characters/roster.json
games/afterhours/src/playerb/roster.json
```

Remove these too if the goal is "no Mixamo derivations in the public repo". The runtime needs them, so they should
move into the same private bundle as the GLBs.

**Hygiene (optional):**

```
games/afterhours/scripts/playerb/__pycache__/
games/afterhours/.tmp/
```

The commits are unpushed, so rewriting only the range is cheap. For example, in a fresh clone:

```sh
git filter-repo --refs origin/main..afterhours --invert-paths \
  --path games/afterhours/public/models/characters/ \
  --path games/afterhours/src/playerb/roster.json \
  --path games/afterhours/audio-lab/sfx-raw/ \
  --path-glob 'games/afterhours/audio-lab/sfx/*.mp3' \
  --path-glob 'games/afterhours/audio-lab/sfx/*/*.mp3' \
  --path-glob 'games/afterhours/audio-lab/sfx/*/*/*.mp3' \
  --path-glob 'games/afterhours/public/sfx/*/*.ogg' \
  --path games/afterhours/scripts/playerb/__pycache__/ \
  --path games/afterhours/.tmp/
```

Then add the purged directories to `games/afterhours/.gitignore`. Before pushing, check that
`git rev-list --objects origin/main..afterhours | grep -E 'characters/.*\.glb|\.mp3$|public/sfx/.*\.ogg$'` prints
nothing. The game then needs a build-time fetch from private storage for the characters, the roster and the sounds,
and must still boot without them (falling back to the CC0 janitor and no sound), or `verify`/smoke in CI breaks.

## Credits and attribution to add or fix

1. **`public/models/CREDITS.md`, `office_chair.glb`:** change the licence to say that the file came from Objaverse
   1.0, where it is listed **CC BY-SA 4.0**. Then either:
   - (a) keep it and mark the modified GLB as CC BY-SA 4.0 ("Office Chair" by nokillnando,
     https://sketchfab.com/3d-models/b228a29fa84544c2be501c295653ffe7, CC BY-SA 4.0
     (https://creativecommons.org/licenses/by-sa/4.0/), modified (rescaled, re-centred, optimised); this modified
     version is also CC BY-SA 4.0), or
   - (b) re-download it from Sketchfab, where the author now offers CC BY 4.0, and record the date.

   Also fix the `objaverse()` default in `scripts/fetch-models.ts`. It hard-codes `CC-BY-4.0` instead of reading the
   Objaverse `license` field, which is how this slipped through.
2. **`public/fonts/`:** add `LICENSE-SpecialElite.txt` with the Apache-2.0 text (copy `LICENSE.txt` from
   google/fonts `apache/specialelite`), and keep the README's copyright line and subsetting note.
3. **`public/textures/basis/`:** add `LICENSE` (Apache-2.0, "Copyright Binomial LLC", from
   github.com/BinomialLLC/basis_universal), and mention it in the `textures/CREDITS.md` line that already names the
   licence.
4. **`public/models/player/CREDITS.md`:** replace the outdated MakeHuman licence URL with
   https://github.com/makehumancommunity/makehuman/blob/master/LICENSE.md (§C: assets CC0; §D: output unrestricted).
5. **In-game or landing credits (recommended):** the CC BY credits currently exist only as `CREDITS.md` files, which
   are shipped in `dist/` but not linked anywhere. CC BY allows any reasonable manner of attribution, so this is
   acceptable. A "Credits" link in the game's help or menu pointing to them is more robust. It should cover the 30
   CC BY models, the CC BY-SA chair, 100STYLE, and the requested CMU line.
6. **Mixamo notice:** in the private bucket README, and in a `characters/CREDITS.md` if any notice is ever committed,
   use the notice drafted in `mixamo-licensing.md` §4.1. Optional in-game line: "Characters and animations: Adobe
   Mixamo".
7. **ElevenLabs:** no attribution is needed. Record in the private bucket README which account and plan generated the
   sounds, and the terms version (ElevenCreative Terms, 2026-10-09). Raise `games/getaway/public/sfx/` on `main`
   with the repo owner.
8. **Repo LICENSE (if one is ever added):** exclude third-party assets explicitly ("files under `**/public/models/**`,
   `**/public/textures/**` and `**/public/fonts/**` are licensed per their CREDITS/LICENSE files").
