import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"
import { hostPath } from "./audio-assets"
import { DEFAULT_TEXTURE_MANIFEST } from "../packages/kit/textures/manifest"

/**
 * Each game/Lab host serves the prepared texture manifest under its own prefix-safe
 * `texture-assets/` route (mirroring `scripts/audio-assets.ts`).
 */
export function textureAssets(): Plugin {
  const assets = new Map(
    DEFAULT_TEXTURE_MANIFEST.map(asset => [
      `texture-assets/${asset.url}`,
      fileURLToPath(new URL(`../packages/kit/textures/assets/${asset.url}`, import.meta.url)),
    ]),
  )
  return {
    name: "arcade-texture-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = hostPath(req.url, server.config.base)
        const file = assets.get(path)
        if (!file) return next()
        res.setHeader("Content-Type", path.endsWith(".webp") ? "image/webp" : "image/png")
        res.end(readFileSync(file))
      })
    },
    generateBundle() {
      for (const [fileName, file] of assets) {
        this.emitFile({ type: "asset", fileName, source: readFileSync(file) })
      }
    },
  }
}
