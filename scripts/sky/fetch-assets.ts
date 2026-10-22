/** Pinned public-domain sources. Re-fetch refuses changed bytes after the first manifest. */
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../../packages/kit/sky/assets")
const revision = "704675ce4981e3b7ca8c7b8530165a83f9a454cc"
const sources = [
  { file: "bsc.json", url: `https://raw.githubusercontent.com/aduboisforge/Bright-Star-Catalog-JSON/${revision}/BSC.json`, licence: "Public domain", licenceUrl: `https://github.com/aduboisforge/Bright-Star-Catalog-JSON/blob/${revision}/README.md#license` },
  { file: "moon-source.jpg", url: "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_1k.jpg", licence: "Public domain", licenceUrl: "https://svs.gsfc.nasa.gov/help/#faq" },
]
await mkdir(root, { recursive: true })
const manifestPath = resolve(root, "sources.json")
let prior: { file: string; sha256: string }[] = []
try { prior = JSON.parse(await readFile(manifestPath, "utf8")) } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e }
const manifest = []
for (const source of sources) {
  const response = await fetch(source.url)
  if (!response.ok) throw new Error(`${response.status}: ${source.url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const expected = prior.find(p => p.file === source.file)
  if (expected && expected.sha256 !== sha256) throw new Error(`Source changed: ${source.file}`)
  await writeFile(resolve(root, source.file), bytes)
  manifest.push({ ...source, sha256, bytes: bytes.length })
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
console.log(`Fetched ${manifest.length} public-domain sources`)
