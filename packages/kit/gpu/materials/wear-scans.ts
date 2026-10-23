import type { FinishScanId } from "./wear"

/**
 * URLs of the wear looks' CC0 scans (`scans/`, fetched by `scripts/finish/fetch-scans.ts`, credits in
 * `scans/CREDITS.md`): tiling base colour at 512². Kept apart from `wear.ts` so a game bundles only the scans it imports.
 */
export const FINISH_SCAN_URLS: Record<FinishScanId, () => string> = {
  "worn-metal": () => new URL("./scans/worn-metal.webp", import.meta.url).href,
  "painted-steel": () => new URL("./scans/painted-steel.webp", import.meta.url).href,
  "concrete-block": () => new URL("./scans/concrete-block.webp", import.meta.url).href,
  "old-wood": () => new URL("./scans/old-wood.webp", import.meta.url).href,
  bark: () => new URL("./scans/bark.webp", import.meta.url).href,
  stone: () => new URL("./scans/stone.webp", import.meta.url).href,
}
