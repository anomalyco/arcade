import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"
import { selectSfx, sfxUrl } from "../packages/kit/audio/library"
import { DEFAULT_SAMPLE_MANIFEST } from "../packages/kit/audio/manifest"

/** Request path relative to the host: the dev router strips `/arcade/<id>`, a standalone server with a base does not. */
export function hostPath(url: string | undefined, base: string) {
  const pathname = new URL(url ?? "/", "http://localhost").pathname
  return (base.length > 1 && pathname.startsWith(base) ? pathname.slice(base.length) : pathname).replace(/^\//, "")
}

const repo = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))
const CONTENT_TYPES: Record<string, string> = { mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav" }

export type AudioAssetOptions = {
  /**
   * Shared sound library ids this host plays (`gun.pistol.shot`, `zombie.*`, `game:outbreak`, or "all"). Each file is
   * served and emitted once under `audio-assets/sfx/` from its single source in the repository.
   */
  sfx?: readonly string[] | "all"
}

/** Each Lab host owns an identical, manifest-bounded asset route under its own deployment prefix. */
export function audioAssets(options: AudioAssetOptions = {}): Plugin {
  const assets = new Map(DEFAULT_SAMPLE_MANIFEST.map(asset => [`audio-assets/${asset.url}`, repo(`games/getaway/public/sfx/${asset.url}`)]))
  for (const entry of selectSfx(options.sfx)) for (const file of entry.files) assets.set(`audio-assets/${sfxUrl(file)}`, repo(file.path))
  const byteCache = new Map<string, Buffer>()
  const readCached = (file: string): Buffer => {
    let buf = byteCache.get(file)
    if (!buf) {
      buf = readFileSync(file)
      byteCache.set(file, buf)
    }
    return buf
  }
  return {
    name: "arcade-audio-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = hostPath(req.url, server.config.base)
        const file = assets.get(path)
        if (!file) return next()
        const buf = readCached(file)
        res.setHeader("Content-Type", CONTENT_TYPES[path.split(".").pop()!] ?? "application/octet-stream")
        res.setHeader("Content-Length", String(buf.byteLength))
        res.setHeader("Cache-Control", "public, max-age=3600")
        res.end(buf)
      })
    },
    generateBundle() {
      if ([...this.getModuleIds()].some(id => id.endsWith("/audio/test-context.ts"))) {
        this.error("The deterministic audio test context must not enter a browser bundle")
      }
      for (const [fileName, file] of assets) this.emitFile({ type: "asset", fileName, source: readCached(file) })
    },
  }
}
