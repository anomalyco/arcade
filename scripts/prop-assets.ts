import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"
import { hostPath } from "./audio-assets"

const DIR = fileURLToPath(new URL("../packages/kit/props/assets/", import.meta.url))

/**
 * Serves the generated furniture and prop meshes (`packages/kit/props/assets/*.prop`) under each host's prefix-safe
 * `prop-assets/` route, like `texture-assets.ts`. Games fetch them at runtime only when props are switched on.
 */
export function propAssets(): Plugin {
  const files = () => (existsSync(DIR) ? readdirSync(DIR).filter(f => /\.(prop|glb)$/.test(f) || f === "CREDITS.md" || f === "textured-sources.json") : [])
  return {
    name: "arcade-prop-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = hostPath(req.url, server.config.base)
        if (!path?.startsWith("prop-assets/")) return next()
        const name = path.slice("prop-assets/".length)
        if (!files().includes(name)) return next()
        const buf = readFileSync(DIR + name)
        res.setHeader("Content-Type", "application/octet-stream")
        res.setHeader("Content-Length", String(buf.byteLength))
        res.setHeader("Cache-Control", "no-cache")
        res.end(buf)
      })
    },
    generateBundle() {
      for (const f of files()) this.emitFile({ type: "asset", fileName: `prop-assets/${f}`, source: readFileSync(DIR + f) })
    },
  }
}
