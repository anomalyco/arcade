# arcade

Browser games by Anomaly, served at https://anoma.ly/arcade/.

| Path | What | Live | Worker |
| --- | --- | --- | --- |
| `landing/` | Index page | https://anoma.ly/arcade/ | `arcade-landing` |
| `games/blackout/` | Top-down stealth shooter (WebGPU, Durable Objects) | https://anoma.ly/arcade/blackout/ | `arcade-blackout` |
| `games/getaway/` | Cops-and-robbers driving chase (WebGPU, Durable Objects) | https://anoma.ly/arcade/getaway/ | `arcade-getaway` |
| `games/wings/` | Multiplayer aerial combat with carrier strike groups (WebGPU, Durable Objects) | https://anoma.ly/arcade/wings/ | `arcade-wings` |
| `redirects/` | 301s from the old `anoma.ly/labs/<game>` URLs to `/arcade/<game>` | — | `arcade-labs-redirects` |

## Prototypes

Unlisted: [Outbreak](https://anoma.ly/arcade/outbreak/) — neighbourhood exploration and local survival-game foundation (`games/outbreak`, Worker `arcade-outbreak`). No landing link, indexing, sitemap entry or login.

Unlisted: [Brawl](https://anoma.ly/arcade/brawl/) — top-down party brawler with a character select, six parody heroes
with their own powers, shoveable props and stock rounds (`games/brawl`, Worker `arcade-brawl`). No landing link or
indexing.

Unlisted: [Archers](https://anoma.ly/arcade/archers/) — side-view arena archery in a noir silhouette look: arrows that
stick and must be picked up, dodge-catches, stomps, one-hit kills, chests with special arrows, couch play for up to four
on keyboards and gamepads against bots, and online rooms with rollback (`?online`, or `?room=code` to invite)
(`games/archers`, Worker `arcade-archers`). No landing link or indexing.

Unlisted tool: [Lab](https://anoma.ly/arcade/lab/) — the one isolation workbench for every game's effects, materials,
looks, physics and sound (`games/lab`, Worker `arcade-lab`). Old `/arcade/<game>/lab.html` links redirect to it.

Getaway, Blackout, Outbreak, Carrier, Brawl, Archers, the Lab and `packages/*` share a Bun workspace and the root `bun.lock`. Install at the root, then run
checks and development commands in the game you are changing. Shared code is the private `@arcade/kit` source package.
Wings, landing and redirects keep their own installs and lockfiles.

`bun run dev` at the root serves every workspace game at its production path on one local origin, with the
developer hub at `/arcade/getaway/dev.html` (see [docs/dev-hub.md](docs/dev-hub.md)). On Kit's Mac, launch it as
`nexus run arcade -- bun run dev`.

Record matching Getaway runs: `bun scripts/compare-video.ts --version Before=ref:4495277 --version Now=url:http://getaway-smoke.localhost:1355 --layout stack --out captures/compare/night.mp4`.
Use `--also-side captures/compare/night-side.mp4` for both layouts; high quality is the default (2× capture, 1080-wide stack / 2560-wide side). Add `--zoom 1.35` for closer framing or `--quality draft` for smaller files; see `--help` for all options.

```sh
bun install --frozen-lockfile
bun run check:packages
cd games/blackout
bun run check
bun run deploy
```

## Routing

All Workers share the `anoma.ly` zone. Each game owns `anoma.ly/arcade/<name>` and `anoma.ly/arcade/<name>/*`, and
strips the `/arcade/<name>` prefix in its Worker. The landing owns only the exact `anoma.ly/arcade` and
`anoma.ly/arcade/` routes plus `anoma.ly/arcade/assets/*` for its bundled files, so it never shadows a game.

## CI

`.github/workflows/<project>.yml` runs when files in that project change, or on manual dispatch. Getaway, Blackout and Outbreak
also watch shared packages, root scripts and workspace configuration. Their workflows install at the root with
`bun install --frozen-lockfile`, then run the game's `bun run check` and production-bundle smoke load. The packages
workflow checks shared code independently. On `main`, each affected game runs its own `bun run deploy`. Deploys use the
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
