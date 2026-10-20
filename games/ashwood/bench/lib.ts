// Shared bench helpers: static server for a frozen build, headless Chromium on Metal (muted, never visible).
import { chromium, type Browser } from "playwright-core"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join, extname } from "node:path"
import { tmpdir } from "node:os"

export const TMP = join(process.env.TMPDIR ?? tmpdir(), "ah-perf")

export function arg(args: string[], name: string, def?: string) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ktx2": "image/ktx2",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
}

/** Serves `dir` with COOP/COEP so the page is cross-origin isolated (5 µs performance.now, SharedArrayBuffer). */
export function serve(dir: string, port: number, opts: { prefix?: string; isolate?: boolean } = {}) {
  const isolate = opts.isolate ?? true
  return Bun.serve({
    port,
    fetch(req) {
      let p = decodeURIComponent(new URL(req.url).pathname)
      if (opts.prefix && p.startsWith(opts.prefix)) p = p.slice(opts.prefix.length - 1)
      if (p.endsWith("/")) p += "index.html"
      const f = join(dir, p)
      if (!existsSync(f) || statSync(f).isDirectory()) return new Response("404", { status: 404 })
      return new Response(Bun.file(f), {
        headers: {
          "content-type": TYPES[extname(f)] ?? "application/octet-stream",
          ...(isolate ? { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" } : {}),
          "cache-control": "no-store",
        },
      })
    },
  })
}

export async function launch(): Promise<Browser> {
  const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
  const shell = readdirSync(cache)
    .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
    .sort()
    .reverse()
    .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
    .find(existsSync)
  return chromium.launch({
    executablePath: shell,
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--mute-audio",
      "--use-angle=metal",
      "--ignore-gpu-blocklist",
      "--enable-features=Vulkan",
      "--enable-webgpu-developer-features",
      "--js-flags=--expose-gc",
      "--enable-precise-memory-info",
    ],
  })
}

export const median = (xs: number[]) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return v.length ? v[v.length >> 1]! : NaN
}
export const pct = (xs: number[], p: number) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))]! : NaN
}

/** Maps bundle positions (chunk file name, 0-based line/column) back to `src/…:line` via the build's source maps. */
export async function sourceResolver(buildDir: string) {
  const { SourceMapConsumer } = (await import("source-map-js")) as unknown as { SourceMapConsumer: new (m: unknown) => { originalPositionFor(p: { line: number; column: number }): { source: string | null; line: number | null; name: string | null } } }
  const cache = new Map<string, InstanceType<typeof SourceMapConsumer> | null>()
  return (file: string, line: number, column: number) => {
    if (!file.endsWith(".js")) return null
    let c = cache.get(file)
    if (c === undefined) {
      const f = join(buildDir, "assets", `${file}.map`)
      c = existsSync(f) ? new SourceMapConsumer(JSON.parse(require("node:fs").readFileSync(f, "utf8"))) : null
      cache.set(file, c)
    }
    if (!c) return null
    const p = c.originalPositionFor({ line: line + 1, column: Math.max(0, column) })
    if (!p.source) return null
    const src = p.source.replace(/^.*?(src\/|node_modules\/)/, (_m, a) => (a === "src/" ? "src/" : "")).replace(/^\.\.\//g, "")
    return `${src}:${p.line}`
  }
}
