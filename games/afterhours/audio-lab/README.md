# Afterhours audio lab

Candidate SFX generated with ElevenLabs `eleven_text_to_sound_v2` (mp3 44.1 kHz 64 kb/s) for auditioning. Not wired
into the game; picks get curated into the shared library later (see `docs/sfx-library.md`).

Licence: the takes and the shipped `public/sfx/*.ogg` may only be used inside the game, never published as standalone
audio files or a sound collection (ElevenCreative Terms, Exhibit 4 §2); see `public/sfx/CREDITS.md`.

- Serve: `bun games/afterhours/audio-lab/serve.ts --port 5199` then open http://localhost:5199/
- Prompts live in `prompts.ts`; files in `sfx/<category>/v<N>.mp3`; `sfx/manifest.json` records prompt, duration,
  prompt_influence, loop and credit cost per file.
- Regenerate (run from `games/afterhours`):
  - `bun audio-lab/generate.ts --list`
  - `bun audio-lab/generate.ts --category hor-knock --force` (after editing its prompts in `prompts.ts`)
  - `bun audio-lab/generate.ts --category hor-knock --variants 6 --force` (cycles prompts, spreads prompt_influence)
  - `bun audio-lab/generate.ts --category hor-knock --prompt "two soft knocks on wire glass" --variants 4 --force`
  - `--group horror`, `--duration 6`, `--concurrency 3`, `--dry-run`. Without `--force` only missing files are made.
- Listening QA (Gemini `gemini-3.8-flash`, key `GEMINI_API_KEY`): `bun audio-lab/qa.ts [--all] [--category id]`
  describes each clip and scores it 1–5 against the category `intent` in `prompts.ts`; stored as `sound.qa`.
- QA-driven fixes: `bun audio-lab/improve.ts [--category id] [--force cat/v1,cat/v2] [--threshold 3] [--retries 2]
  [--min-good 3] [--max-variants 6] [--budget credits] [--dry-run]`. Weak takes are regenerated (prompts.ts prompt
  first, then Gemini-refined prompts); the best take wins, the original wins ties; replaced files move to
  `sfx/_previous/`. Variants with `keep: true` are never touched. Categories are topped up to 3 takes scoring ≥ 4.
- Approved takes: every `picks-*.json` export in this folder (plus breaker v3, see `lib/approved.ts`) is approved.
  generate.ts and improve.ts never regenerate, replace or renumber them; only normalize.ts touches them (from
  `sfx-raw/`). Their prompts are the house style for new prompts (`prompts.ts` header) and are fed to the Gemini
  prompt refiner as examples. `improve.ts --fresh --category …` regenerates every non-approved slot of a category.
- Outdoor night parts (group "outdoor": `amb-pine-wind` bed, `out-*` one-shots) ship provisionally from
  `ship-outdoor-night.json` (listening-QA choices, not approvals) until Aiden picks; `scripts/audio-build.ts` reads it
  alongside the round-2 picks. Runtime: `src/audio/night.ts`.
- Loudness: `bun audio-lab/normalize.ts [--all] [--category id]` normalises clips in place from the untouched takes in
  `sfx-raw/` (so re-running never stacks processing). Metric as in `docs/sfx-library.md`: momentary-max LUFS for
  one-shots, integrated LUFS for loops; per-category targets in `lib/loudness.ts` (stingers about -11, doors -13 to
  -16, footsteps -17 to -21, beds -23, room tone -30, UI -20), true peak ≤ -1 dBTP, at most 10 dB of peak limiting
  (very peaky takes stay under target and show the LUFS in amber). generate.ts and improve.ts normalise new takes
  automatically.
- Ratings, ★ picks, notes and A/B marks are kept in the browser's localStorage; **Export picks** downloads
  `picks.json` and copies it to the clipboard.
