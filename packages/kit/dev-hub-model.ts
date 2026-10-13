export const hubCommands = [
  { id: "games", label: "Games", href: "dev.html#games" },
  { id: "sandbox", label: "Sandbox", href: "lab.html" },
  { id: "catalogue", label: "Catalogue", href: "dev.html#catalogue" },
] as const
export const hubGames = [
  { id: "getaway", label: "Getaway", prototype: false },
  { id: "blackout", label: "Blackout", prototype: false },
  { id: "wings", label: "Wings", prototype: false },
  { id: "carrier", label: "Carrier", prototype: true },
  { id: "outbreak", label: "Outbreak", prototype: true },
] as const

/** The hub page inside the Arcade path layout, shared by production and the local router. */
export const hubPath = "/arcade/getaway/dev.html"

/**
 * Where game links point, decided by how this page is served:
 * - router: `bun run dev` mounts the listed games locally on this origin;
 * - arcade: production, where every game is a same-origin sibling;
 * - standalone: a single game's own dev server, which cannot reach the others.
 */
export type HubTargets = { kind: "router"; local: readonly string[]; workers: boolean } | { kind: "arcade" } | { kind: "standalone" }

export function hubTargets(pathname: string, routerMeta: string | null | undefined): HubTargets {
  if (routerMeta) {
    try {
      const meta: unknown = JSON.parse(routerMeta)
      const games = meta && typeof meta === "object" ? Reflect.get(meta, "games") : undefined
      if (Array.isArray(games)) return { kind: "router", local: games.filter((id): id is string => typeof id === "string"), workers: Reflect.get(meta as object, "workers") === true }
    } catch { /* Not a router page. */ }
  }
  return pathname.startsWith("/arcade/") ? { kind: "arcade" } : { kind: "standalone" }
}

export type GameLink = { href: string; source: "local" | "production" }
export function gameLink(id: string, targets: HubTargets): GameLink {
  const path = `/arcade/${encodeURIComponent(id)}/`
  if (targets.kind === "router" && targets.local.includes(id)) return { href: path, source: "local" }
  if (targets.kind === "arcade") return { href: path, source: "production" }
  return { href: `https://anoma.ly${path}`, source: "production" }
}

export type DevRoute =
  | { kind: "redirect"; location: string }
  | { kind: "vite"; game: string; path: string }
  | { kind: "worker"; game: string }
  | { kind: "missing" }

/** Router paths mirror production: a game owns /arcade/<id> and /arcade/<id>/*, and its Worker strips the prefix. */
export function devRoute(url: string, mounted: readonly string[]): DevRoute {
  const { pathname, search } = new URL(url, "http://hub")
  if (pathname === "/" || pathname === "/arcade" || pathname === "/arcade/") return { kind: "redirect", location: hubPath }
  const match = pathname.match(/^\/arcade\/([a-z][a-z0-9-]*)(\/.*)?$/)
  if (!match || !mounted.includes(match[1]!)) return { kind: "missing" }
  const game = match[1]!, rest = match[2]
  if (!rest) return { kind: "redirect", location: `/arcade/${game}/${search}` }
  if (/^\/(api\/|ws(\/|$))/.test(rest)) return { kind: "worker", game }
  return { kind: "vite", game, path: rest + search }
}

export type CatalogueAsset = { id: string; label: string; category: "vehicle" | "prop" | "character"; metrics?: Readonly<Record<string, string>> }
export function filterAssets(assets: readonly CatalogueAsset[], query: string, category: string) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return assets.filter(asset => (category === "all" || asset.category === category) && words.every(word => `${asset.id} ${asset.label} ${asset.category}`.toLowerCase().includes(word)))
}

/** `#catalogue/<asset id>` keeps the inspected asset across reloads and history. */
export function catalogueHash(assetId?: string) { return assetId ? `#catalogue/${encodeURIComponent(assetId)}` : "#catalogue" }
export function parseHubHash(hash: string): { page: "games" | "catalogue"; assetId?: string } {
  const match = hash.match(/^#catalogue(?:\/(.+))?$/)
  if (!match) return { page: "games" }
  try { return { page: "catalogue", assetId: match[1] ? decodeURIComponent(match[1]) : undefined } } catch { return { page: "catalogue" } }
}

export const catalogueLights = {
  neutral: { moonPower: 1, count: 0, lamps: false, spot: false, exposure: 0, temperature: 0 },
  day: { moonPower: 1.6, count: 0, lamps: false, spot: false, exposure: .3, temperature: .1 },
  night: { moonPower: .15, count: 2, lamps: true, spot: false, exposure: -.3, temperature: -.2 },
  interior: { moonPower: .1, count: 2, lamps: true, spot: true, exposure: .2, temperature: .15 },
} as const
