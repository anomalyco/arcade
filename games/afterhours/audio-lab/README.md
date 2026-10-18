# Afterhours audio lab

Candidate SFX generated with ElevenLabs `eleven_text_to_sound_v2` (mp3 44.1 kHz 64 kb/s) for auditioning. Not wired
into the game; picks get curated into the shared library later (see `docs/sfx-library.md`).

- Serve: `bun games/afterhours/audio-lab/serve.ts --port 5199` then open http://localhost:5199/
- Prompts live in `prompts.ts`; files in `sfx/<category>/v<N>.mp3`; `sfx/manifest.json` records prompt, duration,
  prompt_influence, loop and credit cost per file.
- Regenerate (run from `games/afterhours`):
  - `bun audio-lab/generate.ts --list`
  - `bun audio-lab/generate.ts --category hor-knock --force` (after editing its prompts in `prompts.ts`)
  - `bun audio-lab/generate.ts --category hor-knock --variants 6 --force` (cycles prompts, spreads prompt_influence)
  - `bun audio-lab/generate.ts --category hor-knock --prompt "two soft knocks on wire glass" --variants 4 --force`
  - `--group horror`, `--duration 6`, `--concurrency 3`, `--dry-run`. Without `--force` only missing files are made.
- Ratings, ★ picks, notes and A/B marks are kept in the browser's localStorage; **Export picks** downloads
  `picks.json` and copies it to the clipboard.
