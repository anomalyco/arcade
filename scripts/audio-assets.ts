import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"
import { DEFAULT_SAMPLE_MANIFEST } from "../packages/kit/audio/manifest"

/** Request path relative to the host: the dev router strips `/arcade/<id>`, a standalone server with a base does not. */
export function hostPath(url: string | undefined, base: string) {
  const pathname = new URL(url ?? "/", "http://localhost").pathname
  return (base.length > 1 && pathname.startsWith(base) ? pathname.slice(base.length) : pathname).replace(/^\//, "")
}

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
        const file = assets.get(hostPath(req.url, server.config.base))
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
