import { resolve } from "node:path"
import { basisDecoder, png } from "./basis-image"

const source = resolve(process.argv[2] ?? "/Users/kit/worktrees/arcade/afterhours-preview/games/afterhours")
const out = resolve(import.meta.dir, "../public/interior")
const decode = await basisDecoder(source)
for (const [sourceName, name] of [["ceiling_tile", "ceiling-scan"], ["terrazzo", "terrazzo-scan"], ["plaster", "plaster-scan"]]) {
  const albedo = decode(await Bun.file(`${source}/public/textures/${sourceName}/albedo.ktx2`).bytes())
  const surface = decode(await Bun.file(`${source}/public/textures/${sourceName}/surface.ktx2`).bytes())
  if (albedo.width !== surface.width || albedo.height !== surface.height) throw Error("Finish map dimensions differ")
  const normal = new Uint8Array(surface.data.length), orm = new Uint8Array(surface.data.length)
  for (let i = 0; i < surface.data.length; i += 4) {
    const x = surface.data[i]! / 127.5 - 1, y = surface.data[i + 1]! / 127.5 - 1
    normal.set([surface.data[i]!, surface.data[i + 1]!, Math.round((Math.sqrt(Math.max(0, 1 - x*x - y*y)) + 1) * 127.5), 255], i)
    // Terrazzo's scan roughness is remapped into wax, like the source's [0.06, 0.03] range.
    const rough = sourceName === "terrazzo" ? 20 + albedo.data[i + 3]! * 0.04 : sourceName === "ceiling_tile" ? 235 : 85 + albedo.data[i + 3]! * 0.4
    orm.set([surface.data[i + 2]!, Math.round(rough), 0, 255], i)
    albedo.data[i + 3] = 255
  }
  for (const [suffix, data] of [["", albedo.data], ["-normal", normal], ["-orm", orm]] as const)
    await Bun.write(`${out}/${name}${suffix}.png`, await png(data, albedo.width, albedo.height))
  console.log("Decoded CC0 finish", sourceName)
}
await Bun.write(`${out}/FINISH-CREDITS.md`, `# Interior finish scans\n\nCC0 1.0, from ambientCG (https://docs.ambientcg.com/license/). Decoded offline from the read-only Ashwood texture pack; roughness and normal channels are repacked for the native renderer.\n\n- ceiling-scan: OfficeCeiling001, https://ambientcg.com/view?id=OfficeCeiling001\n- terrazzo-scan: Terrazzo019S, https://ambientcg.com/view?id=Terrazzo019S\n- plaster-scan: Plaster001, https://ambientcg.com/view?id=Plaster001\n\nWater stains, wall dirt, wax wear and tile variation are authored world-space patterns in src/interior/finishes.ts.\n`)
