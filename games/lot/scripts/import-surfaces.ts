import { resolve } from "node:path"
import { mkdir } from "node:fs/promises"
import { sourceDecoder, png } from "./decode-source"
import { recipes } from "./surface-recipes"

const source = resolve(process.argv[2] ?? "../afterhours-preview/games/afterhours")
const out = resolve(import.meta.dir, "../public/ashwood/surfaces")
await mkdir(out, { recursive: true })
const decode = await sourceDecoder(source)
const linear = (x: number) => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
const srgb = (x: number) => x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055
const byte = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255)
const provenance: Record<string, unknown> = {}
for (const [name, r] of Object.entries(recipes)) {
  const files = await Promise.all(["albedo", "surface"].map(kind => Bun.file(`${source}/public/textures/${r.set}/${kind}.ktx2`).bytes()))
  const a = decode(files[0]), s = decode(files[1])
  const base = new Uint8Array(a.data.length), normal = new Uint8Array(s.data.length), orm = new Uint8Array(s.data.length)
  const paint = r.set === "metal_painted"
  for (let i = 0; i < a.data.length; i += 4) {
    const c = [0, 1, 2].map(k => linear(a.data[i + k] / 255))
    const lum = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
    for (let k = 0; k < 3; k++) {
      const tint = typeof r.tint === "number" ? r.tint : r.tint[k]
      base[i + k] = byte(srgb((paint ? 0.88 + 0.18 * lum / 0.45 : lum + (c[k] - lum) * r.sat) * tint * (1 - (r.damp ?? 0) * 0.28)))
    }
    base[i + 3] = 255
  }
  for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
    const i = (y * s.width + x) * 4
    const ai = (Math.floor(y * a.height / s.height) * a.width + Math.floor(x * a.width / s.width)) * 4
    const nx = s.data[i] / 127.5 - 1, ny = s.data[i + 1] / 127.5 - 1
    normal.set([s.data[i], s.data[i + 1], byte(Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * 0.5 + 0.5), 255], i)
    orm.set([s.data[i + 2], byte(a.data[ai + 3] / 255 * r.rough[0] + r.rough[1]), r.metal === undefined ? s.data[i + 3] : byte(r.metal), 255], i)
  }
  await Bun.write(`${out}/${name}-base.png`, await png(base, a.width, a.height))
  await Bun.write(`${out}/${name}-normal.png`, await png(normal, s.width, s.height))
  await Bun.write(`${out}/${name}-orm.png`, await png(orm, s.width, s.height))
  provenance[name] = { ...r, license: "CC0-1.0", sourceHashes: files.map(b => new Bun.CryptoHasher("sha256").update(b).digest("hex")) }
  console.log("Surface", name)
}
await Bun.write(`${out}/sources.json`, JSON.stringify(provenance, null, 2))
await Bun.write(`${out}/CREDITS.md`, await Bun.file(`${source}/public/textures/CREDITS.md`).text())
