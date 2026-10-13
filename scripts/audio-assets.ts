import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"
import { DEFAULT_SAMPLE_MANIFEST } from "../packages/kit/audio/manifest"

/** Each Lab host owns an identical, manifest-bounded asset route under its own deployment prefix. */
export function audioAssets(): Plugin {
  const assets = new Map(DEFAULT_SAMPLE_MANIFEST.map(asset => [
    `audio-assets/${asset.url}`,
    fileURLToPath(new URL(`../games/getaway/public/sfx/${asset.url}`, import.meta.url)),
  ]))
  return {
    name: "arcade-audio-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\//, "")
        const file = assets.get(path)
        if (!file) return next()
        res.setHeader("Content-Type", "audio/mpeg")
        res.end(readFileSync(file))
      })
    },
    generateBundle() {
      if ([...this.getModuleIds()].some(id => id.endsWith("/audio/test-context.ts"))) {
        this.error("The deterministic audio test context must not enter a browser bundle")
      }
      for (const [fileName, file] of assets) this.emitFile({ type: "asset", fileName, source: readFileSync(file) })
    },
  }
}
