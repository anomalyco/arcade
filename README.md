# arcade

Browser games by Anomaly, served at https://anoma.ly/arcade/.

| Path | What | Live | Worker |
| --- | --- | --- | --- |
| `landing/` | Index page | https://anoma.ly/arcade/ | `arcade-landing` |
| `games/blackout/` | Top-down stealth shooter (WebGPU, Durable Objects) | https://anoma.ly/arcade/blackout/ | `arcade-blackout` |
| `games/getaway/` | Cops-and-robbers driving chase (WebGPU, Durable Objects) | https://anoma.ly/arcade/getaway/ | `arcade-getaway` |
| `games/wings/` | Multiplayer aerial combat with carrier strike groups (WebGPU, Durable Objects) | https://anoma.ly/arcade/wings/ | `arcade-wings` |
| `redirects/` | 301s from the old `anoma.ly/labs/<game>` URLs to `/arcade/<game>` | — | `arcade-labs-redirects` |

Getaway, Blackout and `packages/*` share a Bun workspace and the root `bun.lock`. Install at the root, then run
checks and development commands in the game you are changing. Shared code is the private `@arcade/kit` source package.
Wings, landing and redirects keep their own installs and lockfiles.

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

`.github/workflows/<project>.yml` runs when files in that project change, or on manual dispatch. Getaway and Blackout
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
