# Dev Hub

## One local origin

```sh
bun install --frozen-lockfile
bun run dev              # http://127.0.0.1:5180/ (or Portless's PORT/HOST)
bun run dev --workers    # also each game's Worker, started on its first /api or /ws request
nexus run arcade -- bun run dev   # on Kit's Mac: http://arcade.localhost:1355/
```

`scripts/dev.ts` is one HTTP server that mounts every workspace game (`games/*` in the root `package.json`) at its
production path: `/arcade/getaway/`, `/arcade/blackout/`, `/arcade/outbreak/`, `/arcade/carrier/`. `/` and `/arcade/`
redirect to the hub at `/arcade/getaway/dev.html`. Paths match production, so relative assets,
`compare.html`, `audio-assets/` and the games' directory-relative `api/` and `ws` URLs resolve the same way locally.

Each game runs in its own Vite dev server, in middleware mode with base `/arcade/<id>/`, created on the first request
for that game. Vite configs and plugins are unchanged. HMR WebSockets share the router's socket, and each Vite accepts
only its own base path. Requests reach Vite without the prefix, so root-relative plugin middleware
(audio assets, Carrier feedback) works. Carrier keeps its `hmr: false` default. Dependency caches live in
`node_modules/.vite-hub` so they don't collide with a game's own `bun run dev` in the same checkout.

`/arcade/<id>/api/*` and `/arcade/<id>/ws*` belong to the game's Worker, which strips the prefix itself, as in
production. Without `--workers`, they return a 503 JSON error that names the flag. Solo, practice and Lab
work without a Worker. With `--workers`, the router starts one `wrangler dev` child per game on a free loopback port
when it is first needed, and forwards HTTP and WebSocket traffic unchanged. Wrangler children stop with the router.

The router is one Nexus entry. It binds loopback, adds no public routes, and changes no TLS, hosts or landing setup.
`http://*.localhost` is a secure context in Chromium, so WebGPU behaves as it does in production.

Limits:

- Carrier's sound-picks save posts to root `/__sfx/picks`. Under the router, as in production, that path does not
  exist and the save fails.
- One router serves one checkout. Use separate Nexus names for separate worktrees.
- Safari may not resolve `.localhost` names without system setup (see Nexus's README).

## Hub

Getaway and Blackout serve the unlisted hub at `dev.html` (production `/arcade/getaway/dev.html`, `noindex,nofollow`,
no landing link). Its links depend on how the page is served:

| Served by | Game links | Label |
| --- | --- | --- |
| `bun run dev` (router) | Mounted games: same origin, `/arcade/<id>/`. Others: production | Local |
| Production `anoma.ly/arcade/…` | Same-origin siblings `/arcade/<id>/` | Production |
| A single game's own Vite server | `https://anoma.ly/arcade/<id>/`, plus a note to run `bun run dev` | Production |

The router announces itself with a `<meta name="arcade-dev-router">` tag that lists its mounted games. The hub never
probes ports or other previews. Carrier and Outbreak stay inside the closed Prototypes disclosure.

The Lab link opens the single Lab app at `/arcade/lab/` (mounted like a game from `games/lab`). Old
`/arcade/<game>/lab.html` URLs redirect to `/arcade/lab/?game=<game>`, locally and in production. The Lab toolbar's
Hub link returns to Games at `/arcade/getaway/dev.html`.
Browser back/forward work across hub, games and Lab because they share one origin and history.

## Catalogue

Catalogue lists 25 shipped spawn-adapter assets: seven Getaway vehicles, 17 street props and Blackout's soldier.
Selecting one draws it with production geometry and the shared Lab shading on one demand-driven canvas, rendered at
1× CSS pixels like the Lab. The inspector shows its ID, type, configured dimensions and mass, lighting setup and feedback.
This is not full game material/lighting parity.

`#catalogue/<asset id>` records the selection with `replaceState`. Reload keeps it, and Back leaves the Catalogue.
The last asset and the lighting setup are also stored locally, so Catalogue reopens where it was left.

### Input

| Input | Action |
| --- | --- |
| Drag | Orbit (4 px threshold) |
| Shift-drag, middle-drag, right-drag | Pan |
| Scroll / two-finger trackpad scroll | Zoom |
| Right-click or Control-click without dragging | Asset actions: Frame, Copy, Export |
| `F` / `←` `→` `↑` `↓` / `⇧` + arrows / `+` `−` | Frame / orbit / pan / zoom (viewer focused) |
| `Esc` | Focus search |
| `↓` from search, `↑` `↓` `Home` `End` in the list | Move selection |

This matches the Lab: drag orbits, Shift/middle/right-drag pans. A single-asset viewer has no object selection,
so a plain click only focuses the viewer. Text fields keep their keys. Cmd shortcuts and Ctrl-wheel, including
trackpad pinch delivered as Ctrl-wheel, stay with the browser. Pinch therefore zooms the page, not the camera.
The proof dispatches synthetic events. Physical trackpad and multitouch behavior has not been verified.

Lighting setups (Neutral, Day, Night, Interior) use the shared Lab panel without group action buttons, so it shows
only the setup select. The panel's keyboard cursor appears only while focus is inside it.

No simulation or audio starts. Games and hidden documents submit no further frames. Navigation away releases the
device, with a retained device for back/forward-cache pages until restoration.

### Feedback

Drafts are stored locally per asset ID. Copy writes JSON to the clipboard, falling back to the Export dialog.
The JSON includes asset ID, feedback, lighting settings, camera and fixture seed 7. There is no remote feedback service.

## Proof

`bun scripts/prove-dev-hub.ts` starts the router twice (Workers off and on) and runs headless Chromium/Metal against it.
Results go to `captures/dev-hub/`. It checks:

- the entry redirect, local versus production links, and that prototypes stay closed;
- each game's deep link served locally under its prefix with no failed same-origin requests, no running AudioContext
  before a gesture, and Back to the hub;
- the Worker-off response, and Worker HTTP plus WebSocket through the origin with `--workers`;
- HMR sockets for each game, and a hot CSS update without a reload;
- the Catalogue registry, filtering, list keyboard, lighting export identity, and drag/Shift/right-drag camera grammar;
- the context menu, focus, text and native shortcut ownership, reload persistence, and paused hidden route and
  document;
- Sandbox round trips on both Lab hosts, and the standalone-server fallback.
