# arcade

Browser games by Anomaly, served at https://anoma.ly/arcade/.

| Path | What | Live | Worker |
| --- | --- | --- | --- |
| `landing/` | Index page | https://anoma.ly/arcade/ | `arcade-landing` |
| `games/blackout/` | Top-down stealth shooter (WebGPU, Durable Objects) | https://anoma.ly/arcade/blackout/ | `arcade-blackout` |
| `games/getaway/` | Cops-and-robbers driving chase (WebGPU, Durable Objects) | https://anoma.ly/arcade/getaway/ | `arcade-getaway` |
| `games/wings/` | Multiplayer aerial combat with carrier strike groups (WebGPU, Durable Objects) | https://anoma.ly/arcade/wings/ | `arcade-wings` |
| `redirects/` | 301s from the old `anoma.ly/labs/<game>` URLs to `/arcade/<game>` | — | `arcade-labs-redirects` |

Each folder is an independent Bun project with its own `package.json`, lockfile, `check` script and `wrangler.jsonc`.
There is no root workspace.

Record matching Getaway runs: `bun scripts/compare-video.ts --version Before=ref:4495277 --version Now=url:http://getaway-smoke.localhost:1355 --layout stack --out captures/compare/night.mp4`.
Use `--also-side captures/compare/night-side.mp4` for both layouts; high quality is the default (2× capture, 1080-wide stack / 2560-wide side). Add `--zoom 1.35` for closer framing or `--quality draft` for smaller files; see `--help` for all options.

```sh
cd games/blackout
bun install
bun run check
bun run deploy
```

## Routing

All Workers share the `anoma.ly` zone. Each game owns `anoma.ly/arcade/<name>` and `anoma.ly/arcade/<name>/*`, and
strips the `/arcade/<name>` prefix in its Worker. The landing owns only the exact `anoma.ly/arcade` and
`anoma.ly/arcade/` routes plus `anoma.ly/arcade/assets/*` for its bundled files, so it never shadows a game.

## CI

`.github/workflows/<project>.yml` runs when files in that project change, or on manual dispatch. It installs with
`bun install --frozen-lockfile` and runs `bun run check`. On `main` it then runs `bun run deploy`. Deploys use the
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

## History

The games were imported with `git subtree add` from their original repositories, so `git log -- games/<name>` shows
their full history. Blackout came from the `anomalyco/blackout` GitHub repository. Wings came from a local repository.

## Migration notes

- These are new Workers, so their Durable Object namespaces are fresh. Live rooms and lobby state from the old
  `anoma.ly/labs/*` deployments do not carry over.
- The old `anoma.ly/labs/blackout`, `anoma.ly/labs/getaway` and `anoma.ly/labs/wings` URLs (every path, with the query string) permanently
  redirect to `/arcade/<name>` through `redirects/`. The old labs Workers and the standalone repositories have been removed; their history is in this repo.
  `anomalyco/blackout` on GitHub is superseded by this repo.
