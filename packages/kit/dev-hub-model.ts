export const hubCommands = [
  { id: "games", label: "Games", href: "dev.html#games" },
  { id: "sandbox", label: "Sandbox", href: "lab.html" },
  { id: "catalogue", label: "Catalogue", href: "dev.html#catalogue" },
] as const
export const hubGames = [
  { id: "getaway", label: "Getaway", prototype: false },
  { id: "blackout", label: "Blackout", prototype: false },
  { id: "wings", label: "Wings", prototype: false },
  { id: "carrier", label: "Carrier", prototype: false },
  { id: "outbreak", label: "Outbreak", prototype: true },
] as const
/** Explicit configuration only; never discover other previews. */
export function gameHref(id: string, overrides: Readonly<Record<string, string>> = {}) {
  const override = overrides[id]
  if (override) {
    try {
      const url = new URL(override)
      if (url.protocol === "http:" && /^[a-z][a-z0-9-]*\.localhost$/.test(url.hostname) && url.port === "1355" && !url.username && !url.password) return url.href
    } catch { /* Fall back to production. */ }
  }
  return `https://anoma.ly/arcade/${encodeURIComponent(id)}/`
}
export type CatalogueAsset = { id: string; label: string; category: "vehicle" | "prop" | "character"; metrics?: Readonly<Record<string, string>> }
export function filterAssets(assets: readonly CatalogueAsset[], query: string, category: string) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return assets.filter(asset => (category === "all" || asset.category === category) && words.every(word => `${asset.id} ${asset.label} ${asset.category}`.toLowerCase().includes(word)))
}
export const catalogueLights = {
  neutral: { moonPower: 1, count: 0, lamps: false, spot: false, exposure: 0, temperature: 0 },
  day: { moonPower: 1.6, count: 0, lamps: false, spot: false, exposure: .3, temperature: .1 },
  night: { moonPower: .15, count: 2, lamps: true, spot: false, exposure: -.3, temperature: -.2 },
  interior: { moonPower: .1, count: 2, lamps: true, spot: true, exposure: .2, temperature: .15 },
} as const
