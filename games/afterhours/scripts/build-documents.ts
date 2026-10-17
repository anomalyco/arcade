// Builds the set-dressing document atlas: renders every document in scripts/documents/render.ts with Canvas 2D in a
// headless browser (fonts and images injected as data URLs, no dev server needed), then encodes KTX2 with basisu and
// writes the manifest into src/render/documents.ts (generated block) and public/models/documents/manifest.json.
//
//   bun scripts/build-documents.ts            # build → public/models/documents/{base,normal,orm}.ktx2
//   bun scripts/build-documents.ts --png      # also keep the PNG atlases in captures/documents-*.png for review
//
// Fonts (all OFL or Apache 2.0, downloaded from github.com/google/fonts into $TMPDIR/afterhours-fonts): Special Elite,
// Courier Prime, Caveat, Reenie Beanie, Nothing You Could Do, Oswald, Archivo Black, Libre Franklin, VT323,
// Permanent Marker. Photos/illustrations in scripts/documents/images/ were generated for this project (no third-party
// content). Needs basisu on PATH.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const out = join(root, "public/models/documents")
const work = join(tmpdir(), "afterhours-documents")
const fontDir = join(tmpdir(), "afterhours-fonts")
const keepPng = process.argv.includes("--png")
const ATLAS = 4096
const ATLAS_MAX_H = 8192
mkdirSync(out, { recursive: true })
mkdirSync(work, { recursive: true })
mkdirSync(fontDir, { recursive: true })

const FONTS: [family: string, file: string, path: string][] = [
  ["Special Elite", "SpecialElite-Regular.ttf", "apache/specialelite/SpecialElite-Regular.ttf"],
  ["Courier Prime", "CourierPrime-Regular.ttf", "ofl/courierprime/CourierPrime-Regular.ttf"],
  ["Caveat", "Caveat.ttf", "ofl/caveat/Caveat%5Bwght%5D.ttf"],
  ["Reenie Beanie", "ReenieBeanie.ttf", "ofl/reeniebeanie/ReenieBeanie.ttf"],
  ["Nothing You Could Do", "NothingYouCouldDo.ttf", "ofl/nothingyoucoulddo/NothingYouCouldDo.ttf"],
  ["Oswald", "Oswald.ttf", "ofl/oswald/Oswald%5Bwght%5D.ttf"],
  ["Archivo Black", "ArchivoBlack-Regular.ttf", "ofl/archivoblack/ArchivoBlack-Regular.ttf"],
  ["Libre Franklin", "LibreFranklin.ttf", "ofl/librefranklin/LibreFranklin%5Bwght%5D.ttf"],
  ["VT323", "VT323-Regular.ttf", "ofl/vt323/VT323-Regular.ttf"],
  ["Permanent Marker", "PermanentMarker-Regular.ttf", "apache/permanentmarker/PermanentMarker-Regular.ttf"],
]
for (const [, file, path] of FONTS) {
  const f = join(fontDir, file)
  if (existsSync(f)) continue
  const res = await fetch(`https://raw.githubusercontent.com/google/fonts/main/${path}`)
  if (!res.ok) throw new Error(`font ${path}: HTTP ${res.status}`)
  await Bun.write(f, res)
}
const fontFaces = FONTS.map(
  ([family, file]) =>
    `@font-face{font-family:"${family}";src:url(data:font/ttf;base64,${readFileSync(join(fontDir, file)).toString("base64")});font-weight:100 900;}`,
).join("\n")
const imgDir = join(import.meta.dir, "documents/images")
const images = Object.fromEntries(
  readdirSync(imgDir)
    .filter((f) => f.endsWith(".jpg"))
    .map((f) => [f.replace(/\.jpg$/, ""), `data:image/jpeg;base64,${readFileSync(join(imgDir, f)).toString("base64")}`]),
)

// Room list for door plates, parsed from the building program's storey tables: "| 1-02 | Conference A (r2-07) | …".
const program = readFileSync(join(root, "docs/building-program.md"), "utf8")
const rooms: [string, string][] = []
for (const m of program.matchAll(/^\| (\d-\d\d[a-z]?)(?:\.\.(\d\d))? \| ([^|]+?) \|/gm)) {
  const label = m[3]!
    .replace(/\*\*|`/g, "")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/:\s*/g, " — ")
    .replace(/\s*\+.*$/, "")
    .trim()
    .toUpperCase()
  if (m[2]) {
    const [st, a] = m[1]!.split("-") as [string, string]
    for (let n = Number(a); n <= Number(m[2]); n++) rooms.push([`${st}-${String(n).padStart(2, "0")}`, label.replace(/ PRIVATE OFFICES$/, "")])
  } else rooms.push([m[1]!, label])
}
const seen = new Set<string>()
const roomList = rooms.filter(([id]) => (seen.has(id) ? false : (seen.add(id), true)))
console.log(`door plates for ${roomList.length} rooms`)

const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "documents/render.ts")], target: "browser", format: "esm", minify: false })
if (!bundle.success) throw new Error(bundle.logs.join("\n"))
const js = await bundle.outputs[0]!.text()

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--mute-audio"] })
const page = await browser.newPage()
page.on("pageerror", (e) => console.error("page:", e.message))
await page.setContent(`<!doctype html><html><head><style>${fontFaces}</style></head><body>
<script>window.__images = ${JSON.stringify(images)}; window.__rooms = ${JSON.stringify(roomList)}</script><script type="module">${js}</script></body></html>`)
await page.waitForFunction(() => typeof (globalThis as { __build?: unknown }).__build === "function", undefined, { timeout: 60_000 })
const t0 = performance.now()
const result = (await page.evaluate((n) => (globalThis as unknown as { __build: (n: number, h: number) => Promise<unknown> }).__build(n[0]!, n[1]!), [ATLAS, ATLAS_MAX_H])) as {
  base: string
  normal: string
  orm: string
  manifest: { atlas: [number, number]; documents: Record<string, { title: string; size: [number, number]; uv: number[]; tags: string[]; paper: string; pxPerMm: number }>; swatches: Record<string, [number, number]> }
}
await browser.close()
console.log(`rendered ${Object.keys(result.manifest.documents).length} documents in ${((performance.now() - t0) / 1000).toFixed(1)} s`)

const png = (dataUrl: string, file: string) => {
  writeFileSync(file, Buffer.from(dataUrl.split(",")[1]!, "base64"))
  return file
}
const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" })
  const err = await new Response(p.stderr).text()
  if ((await p.exited) !== 0) throw new Error(`${cmd[0]} failed: ${err.slice(-500)}`)
}
/** Downscale by an integer factor (non-square atlases). */
const resize = (input: string, _size: number, output: string, factor: number) =>
  run(["ffmpeg", "-y", "-loglevel", "error", "-i", input, "-vf", `scale=iw/${factor}:ih/${factor}:flags=lanczos`, output])
const basePng = png(result.base, join(work, "base.png"))
const normalFull = png(result.normal, join(work, "normal-full.png"))
const ormFull = png(result.orm, join(work, "orm-full.png"))
await resize(normalFull, 0, join(work, "normal.png"), 4)
await resize(ormFull, 0, join(work, "orm.png"), 8)
// Base colour: ETC1S at maximum quality with full mips. Measured on this atlas: UASTC (RDO 3) 14.3 MB vs ETC1S q255
// 3.3 MB, with text and handwriting still crisp at ~3 px/mm (smooth paper grain keeps the codebook small).
// Normal UASTC at quarter size (creases and grain only), ORM ETC1S at eighth size (flat per-document values).
await Promise.all([
  run(["basisu", "-ktx2", "-mipmap", "-q", "255", "-comp_level", "2", "-srgb", "-mip_srgb", basePng, "-output_file", join(out, "base.ktx2")]),
  run(["basisu", "-ktx2", "-mipmap", "-uastc", "-uastc_level", "1", "-uastc_rdo_l", "2", "-normal_map", "-linear", "-mip_linear", join(work, "normal.png"), "-output_file", join(out, "normal.ktx2")]),
  run(["basisu", "-ktx2", "-mipmap", "-q", "200", "-linear", "-mip_linear", join(work, "orm.png"), "-output_file", join(out, "orm.ktx2")]),
])
if (keepPng) {
  mkdirSync(join(root, "captures"), { recursive: true })
  png(result.base, join(root, "captures/documents-atlas.png"))
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(result.manifest, null, 1) + "\n")

// Generated block in src/render/documents.ts
const ts = join(root, "src/render/documents.ts")
if (existsSync(ts)) {
  const text = readFileSync(ts, "utf8")
  const begin = "// <generated by scripts/build-documents.ts>"
  const end = "// </generated>"
  const i = text.indexOf(begin)
  const j = text.indexOf(end)
  if (i >= 0 && j > i) {
    const r = (v: number) => +v.toFixed(5)
    const docs = Object.entries(result.manifest.documents)
      .map(([id, d]) => `  ${id}: { size: [${d.size.join(", ")}], uv: [${d.uv.map(r).join(", ")}], tags: [${d.tags.map((t) => `"${t}"`).join(", ")}], title: ${JSON.stringify(d.title)} },`)
      .join("\n")
    const sw = Object.entries(result.manifest.swatches)
      .map(([k, v]) => `  ${k}: [${v.map(r).join(", ")}],`)
      .join("\n")
    writeFileSync(
      ts,
      `${text.slice(0, i)}${begin}\nexport const DOCUMENTS = {\n${docs}\n} as const satisfies Record<string, DocumentInfo>\n\nexport const DOC_SWATCHES = {\n${sw}\n} as const satisfies Record<string, readonly [number, number]>\n${text.slice(j)}`,
    )
  }
}
const size = ["base", "normal", "orm"].map((k) => `${k} ${(Bun.file(join(out, `${k}.ktx2`)).size / 1e6).toFixed(2)} MB`)
console.log(size.join(", "))
process.exit(0)
