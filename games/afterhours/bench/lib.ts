// Shared bench helpers: static server for a frozen build, headless Chromium on Metal (muted, never visible).
import { chromium, type Browser } from "playwright-core"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join, extname } from "node:path"

export const TMP = "$TMPDIR/ah-perf"

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
}

/** Serves `dir` with COOP/COEP so the page is cross-origin isolated (5 µs performance.now, SharedArrayBuffer). */
export function serve(dir: string, port: number) {
  return Bun.serve({
    port,
    fetch(req) {
      let p = decodeURIComponent(new URL(req.url).pathname)
      if (p.endsWith("/")) p += "index.html"
      const f = join(dir, p)
      if (!existsSync(f) || statSync(f).isDirectory()) return new Response("404", { status: 404 })
      return new Response(Bun.file(f), {
        headers: {
          "content-type": TYPES[extname(f)] ?? "application/octet-stream",
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp",
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
