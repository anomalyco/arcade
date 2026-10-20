# Pre-push audit: `afterhours` → github.com/anomalyco/arcade (public)

Audited 2026-10-18. Read-only. Scope: every blob added in `origin/main..afterhours` (36 commits, `e9773d69` →
`b68af3fe`), including blobs that later commits replaced or deleted, plus commit messages and author metadata.

- 1,983 new blobs, 1,279 distinct paths (73 deletions inside the range). **347.1 MiB** of new blob data:
  234.1 MiB is still reachable at HEAD, and 113.0 MiB exists only in history (superseded or deleted versions).
- The branch is 11 commits behind `origin/main` (merge base `4ed3ed79`). Files outside `games/afterhours/` that the
  branch changes: `bun.lock`, `package.json`, `docs/controls.md`, `packages/kit/client/key-cap.ts`. All are clean.

## Verdict

| Severity | Count | Summary |
| --- | --- | --- |
| Critical (live secret) | **0** | No API keys, tokens, cookies, private keys or `.env` contents anywhere in the range |
| High | 1 | Mixamo-derived GLBs (Adobe content). This is a licensing issue, not a secret. The branch's own `docs/mixamo-licensing.md` advises against committing them |
| Medium | 3 | Home path and username in scratch files and `.pyc`; machine-specific `$TMPDIR` paths in source and docs; committed scratch dirs |
| Low / info | 5 | Personal Gmail in commit metadata, first name in file names, `~/development/.env` path convention, localhost ports, C2PA provenance in concept PNGs |
| Size | — | 102 MiB of concept PNGs, 25.5 MiB of superseded audio takes, 24.5 MiB across four versions of one KTX2 atlas |

None of the findings is a credential leak. A push needs no key rotation. Before pushing, purge the Mixamo files
and clean the medium findings, either now or as part of the history rewrite below.

## Method

1. Listed new blobs with `git rev-list --objects origin/main..HEAD` and mapped each blob to a path and commit with
   `git log --raw --diff-filter=AMR`. Extracted every blob, text and binary, to a scratch directory.
2. **Real secret values:** a script read `~/development/.env` (43 keys, including `ELEVEN_LABS_API_KEY`,
   `GEMINI_API_KEY`, `CLOUDFLARE_API_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_CLIENT_SECRET`, `FIGMA_CLIENT_SECRET` and
   `CLOUDFLARE_ACCOUNT_ID`). It searched all 1,983 blobs and all commit messages for each value in raw, hex, base64
   and URL-encoded form, and for the first and last 20 characters of long values. It reported only key names.
   Result: **0 hits**. No value was printed.
3. **Pattern greps** over all text blobs: `sk_…`, `sk-…`, `xi-api-key`, `AKIA…`, `-----BEGIN`, `ghp_`/`gho_`/
   `github_pat`, `xox[abpr]-`, `AIza…`, JWT `eyJ…`, `r8_`, `hf_`, `Bearer`, `Authorization`, `api_key`/`apikey`,
   `password`, `secret`, `cookie`, `session_id`, `access_token`, `refresh_token`, `client_secret`, Adobe IMS
   (`ims-na1`, `ims_`), plus an entropy scan of every token of 28+ characters (excluding lockfile hashes). The only
   matches are code that *reads* keys from the environment: `audio-lab/lib/eleven.ts` and `audio-lab/lib/gemini.ts`.
   Neither contains a key.
4. **Personal info:** grepped all blobs, binary included, for `/Users/…`, `/private/var/folders/…`, emails,
   `opentunnel`/`ngrok`/`trycloudflare`, Slack channel, user and webhook IDs, `ses_…`, `/Users/kit`, `.local`
   hosts, and real names.
5. **Media:** no `.mp4`, `.webm`, `.har`, `.zip`, Playwright trace or screenshot capture was committed in any
   commit (`captures/` and `mixamo-src/` are gitignored and were never added). I checked all 41 PNGs and 61 JPGs:
   PNG chunks, JPEG EXIF/XMP/GPS, and a visual contact sheet of every concept PNG plus each of the four
   `scripts/documents/images/*.jpg`. I checked glTF `asset`/`extras` JSON in all 130 GLB blobs and the header
   metadata of the MP3, OGG, KTX2, WOFF2, WASM and BIN files.

## Findings

### H1. Mixamo (Adobe) characters and animations committed. High (licensing)

| Commit | Path | Size |
| --- | --- | --- |
| `9624260b` (added), `2b24cce9`, `5f1ef2f4` (updated) | `games/afterhours/public/models/characters/anims.glb` | 3 versions, 7.41 MiB |
| `9624260b` | `games/afterhours/public/models/characters/{remy,james,kate,louise,megan}.glb` | 11.0 MiB |
| `9624260b` | `games/afterhours/public/models/characters/roster.json` (Mixamo `Ch06`/`Ch21`… mesh names, metadata only) | small |

These are converted Mixamo stock characters (Remy, James, Kate, Louise, Megan) and Mixamo animation clips, 8 GLB
blobs and 18.45 MiB in total. The branch's own `games/afterhours/docs/mixamo-licensing.md` (commit `9624260b`)
concludes that committing them to a public repo "leans toward not allowed" under Adobe General Terms §3.6
(no distribution "on a stand-alone basis"). It recommends keeping them private and fetching them at build time.
Pushing makes every version permanently downloadable.

Removing them from history also removes them from HEAD, so the character runtime (`src/playerb/…`, roster
loading) needs a private fetch step or a fallback before the purge lands.

The other two player bodies are clean. `public/models/player/janitor.glb` (MakeHuman CC0 + 100STYLE CC BY 4.0 +
Quaternius CC0) and `public/models/playerb/janitor_b.glb` (MakeHuman + Quaternius + CMU mocap) are documented in
their `CREDITS.md` files as redistributable.

### M1. Owner home path and username in committed files. Medium

| Commit | Path | Content | At HEAD? |
| --- | --- | --- | --- |
| `3cd2b0da` (later versions `f3ba7197`, `b5c3a4db`) | `games/afterhours/.tmp/sep.ts` | `import … from "/Users/aidencline/development/arcade-afterhours/…"` | yes |
| `7fb121b0` (deleted in `99c00d3b`) | `games/afterhours/scripts/.sharp-tmp.ts` | `/Users/aidencline/development/arcade-afterhours/node_modules/sharp` and `/private/var/folders/wp/p9bq_z410fl2zmv767k8w0zw0000gn/T/opencode/sharp` | no (history only) |
| `27eeb50b`, `4d6a766a` | `games/afterhours/scripts/playerb/__pycache__/{carry,cmu,mocap,rt}.cpython-313.pyc` | compiled bytecode that embeds the absolute source path `/Users/aidencline/development/arcade-afterhours/…` | yes (4 files) |

This exposes the local username and directory layout. No credential is involved.

### M2. Machine-specific `$TMPDIR` path hard-coded in source and docs. Medium-low

`/private/var/folders/wp/p9bq_z410fl2zmv767k8w0zw0000gn/T/opencode/…` (a per-user macOS temp folder ID) appears in:

| Commit (first) | Path | At HEAD? |
| --- | --- | --- |
| `7fb121b0` | `games/afterhours/bench/lib.ts` (`TMP = …/ah-perf`) | yes |
| `3cd2b0da` | `games/afterhours/scripts/audit/lib.ts` (`OUT` default `…/ah-audit/out`) | yes |
| `7fb121b0`, `f3ba7197` | `games/afterhours/docs/perf-audit.md` | yes |
| `8e630c5b` | `games/afterhours/docs/integration-audit.md` (line 6) | yes |
| `7fb121b0` (deleted `99c00d3b`) | `games/afterhours/scripts/.sharp-tmp.ts` | no |

On its own this is not identifying, but it is machine-specific, and the scripts also break on other machines.
Replace the literal path with `process.env.TMPDIR` in the source files and with `$TMPDIR` in the docs.

### M3. Scratch and debug files committed. Medium-low (hygiene; also the source of M1)

- `games/afterhours/.tmp/` holds 14 throwaway probes (`fall.ts`, `fd.ts`, `liftkeys.ts`, `mont.py`, `probe*.ts`,
  `sep*.ts`, `serve.ts`, `trace.ts`). Added across `3cd2b0da`, `8e630c5b`, `6779fca8`, `f3ba7197`, `ca041ab9`,
  `71673f6d` and `5f1ef2f4`, and still at HEAD. `.tmp/` is not gitignored.
- `games/afterhours/scripts/.sharp-tmp.ts`, `.cost-tmp.ts` and `.probe-tmp.ts` were added in `7fb121b0`/`3f43cfbf`
  and deleted in `99c00d3b`. They remain in history.
- `games/afterhours/scripts/playerb/__pycache__/*.pyc` (see M1).

### L1. Personal Gmail in commit metadata. Low

All 36 commits are authored and committed as `Aiden Cline <aidenpcline@gmail.com>`. The owner's earlier commits in
this repo use `63023139+rekram1-node@users.noreply.github.com`. If the personal address should not be public on
this repo, rewrite it with a mailmap during the purge (see below).

### L2. Owner first name in file names and content. Low / info

`games/afterhours/audio-lab/picks-aiden-2026-10-18.json` (`d7b8f84f`) and `picks-aiden-2026-10-18-round2.json`
(`71673f6d`) have the `note` "Aiden's round-2 picks…". They are referenced by `scripts/audio-build.ts` and
`src/audio/sfx-manifest.ts`. This is harmless. Rename the files only if you don't want the name in the repo.

### L3. Secret-loading convention reveals key location. Info

`audio-lab/lib/eleven.ts` and `audio-lab/lib/gemini.ts` (`d7b8f84f`, `27eeb50b`) fall back to reading
`$HOME/development/.env` for `ELEVEN_LABS_API_KEY` and `GEMINI_API_KEY`. No values are present. This only shows
where keys live locally. Consider an env-var-only path.

### L4. Localhost dev ports and `$HOME/Library/Caches/ms-playwright`. Info

About 60 scripts use `http://localhost:5196/` and similar addresses. Nothing in them is private.

### L5. C2PA provenance in concept PNGs. Info

All 41 `games/afterhours/concept/*.png` (`e9773d69`) carry a `caBX` C2PA manifest from the OpenAI Media Service API
(`gpt-image-1`, `trainedAlgorithmicMedia`), signed by SSL.com/OpenAI certificates. It contains no account, org or
user identifier. The `ca@trufo.ai` string the email grep matched is a certificate field. I reviewed all 41 images
visually: all are AI concept art, with no screenshots or private content.

### Clean (checked, nothing found)

- No secrets in commit messages.
- No Adobe or Mixamo cookies, IMS tokens, or account emails in any file. The Mixamo pipeline
  (`scripts/playerb/mixamo.py`, `characters.ts`) works from local FBX files in the gitignored `mixamo-src/`.
- No browser screenshots of Adobe or other logged-in pages were committed. All browser captures went to the
  gitignored `captures/` or `$TMPDIR`.
- No opentunnel or other tunnel URLs, no Slack channel or user IDs, no `ses_` IDs, no `/Users/kit` paths.
- JPEGs have no EXIF, XMP or GPS. `scripts/documents/images/{cat,bowling,polaroid-corridor,polaroid-dish}.jpg` are
  image-model generated (viewed).
- GLB metadata contains only generator strings (`glTF-Transform v4.5.1`, `Khronos glTF Blender I/O v5.2.40`) and
  Sketchfab CC BY credits. No file paths.
- MP3 and OGG headers contain only `Lavf`/`Lavc` encoder tags. KTX2 headers contain only `Basis Universal 2.50`.
- `audio-lab/sfx/manifest.json` (ElevenLabs prompts, per-take cost, QA notes) has no keys or account IDs.

## Size

Added by file type: PNG 102.5 MiB (41 files), GLB 84.1 MiB (130 blobs), KTX2 68.8 MiB (47), MP3 38.8 MiB (694),
JPG 34.0 MiB (61), TS 10.4 MiB, OGG 3.5 MiB, JSON 2.5 MiB.

Largest blobs added:

| # | MiB | Blob | Path | At HEAD? |
| --- | --- | --- | --- | --- |
| 1 | 10.74 | `484a5160` | `public/models/documents/base.ktx2` | no (superseded) |
| 2 | 8.49 | `bc57f6d7` | `public/models/documents/base.ktx2` | no (superseded) |
| 3 | 4.42 | `8485e051` | `public/textures/asphalt_lot/albedo.ktx2` | no (deleted) |
| 4 | 4.30 | `d95fc71c` | `public/textures/asphalt/albedo.ktx2` | no (deleted) |
| 5 | 4.26 | `3a530dd3` | `public/models/playerb/janitor_b.glb` | no (superseded) |
| 6 | 3.75 | `9e56e200` | `public/textures/concrete_wall/albedo.ktx2` | no (deleted) |
| 7 | 3.37 | `d85aaff6` | `public/textures/asphalt/normal.jpg` | yes |
| 8 | 3.29 | `2f3e1f48` | `concept/r4-02-specimen-hall.png` | yes |
| 9 | 3.20 | `068066bc` | `public/textures/asphalt_lot/normal.jpg` | yes |
| 10 | 3.03 | `2514b8cc` | `public/models/playerb/janitor_b.glb` | yes |
| 11 | 2.92 | `380e142c` | `concept/r4-03-lab-cafeteria.png` | yes |
| 12 | 2.87 | `bd5444f0` | `concept/r3-02-lab-corridor-pov.png` | yes |
| 13 | 2.85 | `4dd66006` | `concept/09-lowpoly-retro-style.png` | yes |
| 14 | 2.83 | `bf8d1569` | `concept/r4-08-lab-security-office.png` | yes |
| 15 | 2.81 | `7659686f` | `public/models/documents/base.ktx2` | no (superseded) |
| 16 | 2.79 | `5c0a03b2` | `concept/r4-07-gas-station.png` | yes |
| 17 | 2.78 | `ccbfda13` | `concept/r2-03-ink-hallway-pov.png` | yes |
| 18 | 2.76 | `db458a20` | `concept/01-cubicle-sea-1987.png` | yes |
| 19 | 2.76 | `8cede14e` | `concept/r2-06-janitor-pov-bathroom.png` | yes |
| 20 | 2.74 | `bf794faa` | `concept/r4-05-freight-elevator.png` | yes |
| 21 | 2.71 | `c0ba3006` | `public/models/characters/anims.glb` (Mixamo) | no (superseded) |
| 22 | 2.71 | `819f993f` | `concept/r3-05-small-town-main-street.png` | yes |
| 23 | 2.70 | `c47da03a` | `concept/r5-01-corridor-junction.png` | yes |
| 24 | 2.69 | `372798f6` | `concept/03-open-office-1999.png` | yes |
| 25 | 2.68 | `ab363ae1` | `concept/r4-04-decon-showers.png` | yes |
| 26 | 2.68 | `6a9a5c1e` | `public/models/characters/remy.glb` (Mixamo) | yes |
| 27 | 2.65 | `1fda6e85` | `concept/r3-08-forest-perimeter.png` | yes |
| 28 | 2.62 | `41aa4e90` | `concept/r3-04-containment-chamber.png` | yes |
| 29 | 2.60 | `409208fe` | `concept/r3-07-janitor-closet-radio.png` | yes |
| 30 | 2.60 | `fc289ffb` | `public/textures/asphalt_lot/arm.jpg` | yes |

All paths are relative to `games/afterhours/`.

Bulky items that don't belong in a public game repo:

| Item | Commits | Size | Note |
| --- | --- | --- | --- |
| `concept/*.png` (41) | `e9773d69` | 102.5 MiB | 44% of the HEAD tree. Re-encode to WebP/JPEG (~5–10× smaller) or keep out of git |
| `audio-lab/sfx-raw/` (205 at HEAD) + `audio-lab/sfx/_previous/` (201 at HEAD) | `8d49c191`, `27eeb50b`, `d7b8f84f`, `71673f6d`, `afdbf52e` | 25.5 MiB in history | Unpicked, raw and superseded ElevenLabs takes. The game ships `public/sfx/*.ogg` (3.5 MiB) |
| `audio-lab/sfx/<cat>/*.mp3` (current takes) | same | ~12 MiB | Audition source. Only needed to rebuild `public/sfx` |
| `public/models/documents/base.ktx2`, 4 versions | `9d9bf9cd`…`3cd2b0da`, `75938d96` | 24.5 MiB history, 3.3 MiB at HEAD | Superseded atlas versions |
| `public/textures/*/{albedo,surface}.ktx2` (deleted) | `c5918210` (added and later removed) | ~34 MiB history-only | Dead texture experiment |
| Old versions of `player/janitor.glb` (6), `playerb/janitor_b.glb` (2), cars and vans (3 each) | various | ~20 MiB history-only | Superseded versions |

## Purge list

Do this in a **fresh clone or after a backup**, and rewrite only the unpublished range so `origin/main` is
untouched. `git filter-repo` accepts a rev range through `--refs`.

```sh
git clone --no-local /Users/aidencline/development/arcade-afterhours /tmp/ah-purge && cd /tmp/ah-purge
git checkout afterhours

# 1. Required: Mixamo assets (H1), scratch and bytecode (M1/M3)
git filter-repo --force --refs origin/main..afterhours --invert-paths \
  --path games/afterhours/public/models/characters/anims.glb \
  --path games/afterhours/public/models/characters/remy.glb \
  --path games/afterhours/public/models/characters/james.glb \
  --path games/afterhours/public/models/characters/kate.glb \
  --path games/afterhours/public/models/characters/louise.glb \
  --path games/afterhours/public/models/characters/megan.glb \
  --path games/afterhours/.tmp/ \
  --path games/afterhours/scripts/.sharp-tmp.ts \
  --path games/afterhours/scripts/.cost-tmp.ts \
  --path games/afterhours/scripts/.probe-tmp.ts \
  --path-glob 'games/afterhours/scripts/playerb/__pycache__/*'

# 2. Recommended: scrub machine paths left in kept files (M2), in every historical version
cat > /tmp/ah-replace.txt <<'EOF'
/private/var/folders/wp/p9bq_z410fl2zmv767k8w0zw0000gn/T/opencode/==>$TMPDIR/
/Users/aidencline/development/arcade-afterhours/==>
EOF
git filter-repo --force --refs origin/main..afterhours --replace-text /tmp/ah-replace.txt
# Then fix bench/lib.ts and scripts/audit/lib.ts in a normal commit to use process.env.TMPDIR, because the
# literal "$TMPDIR/" string is not expanded inside TS string literals.

# 3. Optional (L1): public noreply author
printf '%s\n' 'Aiden Cline <63023139+rekram1-node@users.noreply.github.com> Aiden Cline <aidenpcline@gmail.com>' > /tmp/ah-mailmap
git filter-repo --force --refs origin/main..afterhours --mailmap /tmp/ah-mailmap

# 4. Optional (size): debugging audio and history-only bulk
git filter-repo --force --refs origin/main..afterhours --invert-paths \
  --path games/afterhours/audio-lab/sfx-raw/ \
  --path games/afterhours/audio-lab/sfx/_previous/
#   Superseded atlas/texture/model versions can't be removed by path without deleting HEAD's copy. Use
#   --strip-blobs-with-ids with blob IDs from `git rev-list --objects origin/main..afterhours` that are not in
#   `git ls-tree -r HEAD` (113 MiB in total; the largest are listed above).
#   For concept/: either re-encode in a commit before the rewrite and strip the old PNG blob IDs, or drop
#   concept/ from git and host the images elsewhere.
```

After step 1, HEAD no longer has the five characters or `anims.glb`. Land the private fetch step from
`docs/mixamo-licensing.md` option (b) first, or make the roster fall back to `player/janitor.glb`. Then run
`bun run verify` and check, for example with `git log --all -- games/afterhours/public/models/characters/*.glb`
and the pattern greps above, that nothing remains.

### `.gitignore` additions (`games/afterhours/.gitignore`)

The file currently contains `captures/` and `mixamo-src/`. Add:

```gitignore
.tmp/
__pycache__/
*.pyc
scripts/.*-tmp.ts
# Mixamo-derived assets are fetched at build time, never committed (docs/mixamo-licensing.md)
public/models/characters/*.glb
# audition archives; only public/sfx ships
audio-lab/sfx-raw/
audio-lab/sfx/_previous/
```
