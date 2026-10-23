import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"
import { hostPath } from "./audio-assets"

const ROOT = fileURLToPath(new URL("../packages/kit/forest/assets", import.meta.url))
const TYPES: Record<string, string> = { ".webp": "image/webp", ".gz": "application/octet-stream", ".json": "application/json", ".md": "text/markdown" }

/**
 * Serves the night forest's scanned assets (`packages/kit/forest/assets`, written by `scripts/woods/fetch-assets.ts`)
 * under each host's own prefix-safe `forest-assets/` route, and emits them into the build (as `textureAssets` does).
 * The `.gz` model files stay gzip bytes: `loadForestModels` inflates them itself.
 */
export function forestAssets(): Plugin {
  const files = new Map<string, string>()
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else files.set(`forest-assets/${relative(ROOT, p).split("\\").join("/")}`, p)
    }
  }
  walk(ROOT)
  return {
    name: "arcade-forest-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = hostPath(req.url, server.config.base)
        const file = files.get(path)
        if (!file) return next()
        const buf = readFileSync(file)
        res.setHeader("Content-Type", TYPES[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream")
        res.setHeader("Content-Length", String(buf.byteLength))
        res.setHeader("Cache-Control", "public, max-age=3600")
        res.end(buf)
      })
    },
    generateBundle() {
      for (const [fileName, file] of files) this.emitFile({ type: "asset", fileName, source: readFileSync(file) })
    },
  }
}
