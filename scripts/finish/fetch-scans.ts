/**
 * Downloads the wear looks' CC0 scans (`FINISH_SCANS` in packages/kit/gpu/materials/wear.ts) from Poly Haven and
 * writes them as tiling base-colour WebPs, with sources and credits, to packages/kit/gpu/materials/scans/. The shader
 * projects them triplanar and divides by their mean, so they add grain and pitting without shifting a look's albedo.
 * Run once; outputs are checked in.
 *
 *   bun scripts/finish/fetch-scans.ts [--only <scan,scan>] [--size 512]
 */
import { $ } from "bun"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FINISH_SCANS, type FinishScanId } from "../../packages/kit/gpu/materials/wear"

const OUT = join(import.meta.dir, "../../packages/kit/gpu/materials/scans")
const CACHE = join(process.env.TMPDIR ?? "/tmp", "finish-scans-cache")
mkdirSync(OUT, { recursive: true })
mkdirSync(CACHE, { recursive: true })

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const only = arg("--only") ? new Set(arg("--only")!.split(",")) : null
const size = Number(arg("--size") ?? 512)

type Credit = { scan: FinishScanId; id: string; url: string; authors: Record<string, string>; licence: string; use: string; file: string; source: string; sha256: string }

async function fetchCached(url: string): Promise<string> {
  const path = join(CACHE, url.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_"))
  if (!existsSync(path)) {
    const res = await fetch(url)
    if (!res.ok) throw Error(`${res.status} ${url}`)
    writeFileSync(path, new Uint8Array(await res.arrayBuffer()))
  }
  return path
}
const json = async (url: string) => JSON.parse(readFileSync(await fetchCached(url), "utf8"))
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

async function scan(name: FinishScanId): Promise<Credit> {
  const { id, use } = FINISH_SCANS[name]
  const files = await json(`https://api.polyhaven.com/files/${id}`)
  const info = await json(`https://api.polyhaven.com/info/${id}`)
  const src = files.Diffuse["1k"].jpg.url as string
  const path = await fetchCached(src)
  const file = `${name}.webp`, tmp = join(CACHE, `${name}.png`)
  await $`magick ${path} -resize ${size}x${size}! ${tmp}`.quiet()
  await $`cwebp -quiet -q 85 ${tmp} -o ${join(OUT, file)}`.quiet()
  console.log(`${name}: ${id} → ${file}`)
  return { scan: name, id, url: `https://polyhaven.com/a/${id}`, authors: info.authors, licence: "CC0 1.0", use, file, source: src, sha256: sha(path) }
}

const sourcesPath = join(OUT, "sources.json")
const previous: Credit[] = existsSync(sourcesPath) ? JSON.parse(readFileSync(sourcesPath, "utf8")) : []
const credits = new Map(previous.map(c => [c.scan, c]))
for (const name of Object.keys(FINISH_SCANS) as FinishScanId[]) if (!only || only.has(name)) credits.set(name, await scan(name))
const list = [...credits.values()].sort((a, b) => a.scan.localeCompare(b.scan))
writeFileSync(sourcesPath, JSON.stringify(list, null, 1) + "\n")
writeFileSync(join(OUT, "CREDITS.md"), [
  "# Wear look scans: credits",
  "",
  "Every scan here is from [Poly Haven](https://polyhaven.com), released under **CC0 1.0** (public domain,",
  "https://polyhaven.com/license). Downloaded by `scripts/finish/fetch-scans.ts`: the 1k base colour resized to",
  `${size}² and re-encoded as WebP. Source URLs and the SHA-256 of each download are in \`sources.json\`.`,
  "",
  "| Scan | Source | Authors | Used for |",
  "| --- | --- | --- | --- |",
  ...list.map(c => `| \`${c.file}\` | [${c.id}](${c.url}) | ${Object.entries(c.authors).map(([n, r]) => `${n} (${r})`).join(", ")} | ${c.use} |`),
  "",
].join("\n"))
