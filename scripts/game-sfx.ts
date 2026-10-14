import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"

/**
 * Serves and emits Getaway's own samples under the host's `sfx/` directory, where Getaway's `AudioEngine` fetches them
 * (`${BASE_URL}sfx/<name>.mp3`). The Lab runs Getaway's game audio, so it needs the same files under its own prefix.
 */
export function getawaySfx(): Plugin {
  const dir = fileURLToPath(new URL("../games/getaway/public/sfx/", import.meta.url))
  const files = new Map(readdirSync(dir).filter(name => name.endsWith(".mp3")).map(name => [`sfx/${name}`, `${dir}${name}`]))
  return {
    name: "arcade-getaway-sfx",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = files.get(new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\//, ""))
        if (!file) return next()
        res.setHeader("Content-Type", "audio/mpeg")
        res.end(readFileSync(file))
      })
    },
    generateBundle() {
      for (const [fileName, file] of files) this.emitFile({ type: "asset", fileName, source: readFileSync(file) })
    },
  }
}
