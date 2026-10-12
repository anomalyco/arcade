# arcade

Browser games by Anomaly, served at https://anoma.ly/arcade/.

| Path | What | Live | Worker |
| --- | --- | --- | --- |
| `landing/` | Index page | https://anoma.ly/arcade/ | `arcade-landing` |
| `games/blackout/` | Top-down stealth shooter (WebGPU, Durable Objects) | https://anoma.ly/arcade/blackout/ | `arcade-blackout` |
| `games/getaway/` | Cops-and-robbers driving chase (WebGPU, Durable Objects) | https://anoma.ly/arcade/getaway/ | `arcade-getaway` |

Each folder is an independent Bun project with its own `package.json`, lockfile, `check` script and `wrangler.jsonc`.
There is no root workspace.

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
their full history. Blackout came from https://github.com/anomalyco/blackout.

## Migration notes

- These are new Workers, so their Durable Object namespaces are fresh. Live rooms and lobby state from the old
  `anoma.ly/labs/*` deployments do not carry over.
- The old `blackout` and `getaway` Workers at `anoma.ly/labs/<name>` are still running and can be retired later.
