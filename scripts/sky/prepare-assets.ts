/** Repack public-domain catalogue and compress the Moon. No runtime network dependency. */
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { spectralTemperature, DEG } from "../../packages/kit/sky/astronomy"

const root = resolve(import.meta.dir, "../../packages/kit/sky/assets")
type Source = { "harvard_ref_#": number; RA: string; DEC: string; MAG: string; "Title HD": string; "RA PM": string; "DEC PM": string }
const source: Source[] = JSON.parse(await readFile(resolve(root, "bsc.json"), "utf8"))
const sexa = (s: string) => { const [a, b, c] = s.replace(/^[+-]/, "").split(":").map(Number); return (a! + b! / 60 + c! / 3600) * (s.startsWith("-") ? -1 : 1) }
const rows = source.map(s => [s["harvard_ref_#"], sexa(s.RA) * 15 * DEG, sexa(s.DEC) * DEG, Number(s.MAG), spectralTemperature(s["Title HD"]), Number(s["RA PM"]), Number(s["DEC PM"])]).filter(r => r.every(Number.isFinite))
if (rows.length !== 9096) throw new Error(`Expected 9096 stars, got ${rows.length}`)
const bytes = new ArrayBuffer(rows.length * 28), view = new DataView(bytes)
rows.forEach((row, i) => row.forEach((value, j) => view.setFloat32((i * 7 + j) * 4, value, true)))
await writeFile(resolve(root, "stars.bin"), new Uint8Array(bytes))
const command = Bun.spawn(["magick", resolve(root, "moon-source.jpg"), "-quality", "92", resolve(root, "moon.webp")], { stdout: "inherit", stderr: "inherit" })
if (await command.exited) throw new Error("Moon WebP conversion failed")
console.log(`${rows.length} catalogue stars, ${bytes.byteLength} bytes`)
