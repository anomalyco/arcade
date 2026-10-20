// Which shell the page runs: the game ("play": menu, title card, intro, explore) or the debug sandbox ("debug": fly,
// viewpoints, Lab panel, ?query flags, exactly the old boot).
//
// - `<base>/debug` is the debug sandbox in dev builds only; a production build shows the normal game there.
// - Automation keeps loading `<base>/?view=…&shot…`: any query string selects debug in dev builds or when served from
//   localhost (so the --prod profiling scripts against `vite preview` still work). Public hosts never see it.
// - `?play` forces the game (e.g. to try the menu with a query on the dev server).
// The path check only looks at the last segment, so it works under the Worker's /arcade/ashwood prefix.

export type Mode = "play" | "debug"

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

export function resolveMode(loc: Location = location): Mode {
  const params = new URLSearchParams(loc.search)
  if (params.has("play")) return "play"
  const dev = import.meta.env.DEV
  if (dev && /\/debug\/?$/.test(loc.pathname)) return "debug"
  if (loc.search.length > 1 && (dev || LOCAL_HOSTS.has(loc.hostname))) return "debug"
  return "play"
}
