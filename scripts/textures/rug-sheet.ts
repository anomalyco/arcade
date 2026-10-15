#!/usr/bin/env bun
/**
 * Bakes procedural rugs and writes a labelled contact sheet (needs ImageMagick).
 *
 *   bun scripts/textures/rug-sheet.ts [--out dir] [--size 512] [--seeds 1,2,3] [--style persian] [--palette madder]
 *
 * Without --style it bakes one rug per style; with --style it bakes that style for each seed.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"
import { bakeRug, RUG_STYLES, type RugSpec, type RugStyle } from "../../packages/kit/textures/rug"
import type { RugPaletteId } from "../../packages/kit/textures/rug-palettes"

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = arg("out", "/tmp/rugs")!
const size = Number(arg("size", "512"))
const seeds = (arg("seeds", "7") ?? "7").split(",").map(Number)
const style = arg("style") as RugStyle | undefined
const palette = arg("palette") as RugPaletteId | undefined
mkdirSync(out, { recursive: true })

const defaults: Record<RugStyle, Partial<RugSpec>> = {
  persian: { width: 2.0, length: 3.0, palette: "madder" },
  turkmen: { width: 1.9, length: 2.8, palette: "tekke" },
  kilim: { width: 1.5, length: 2.4, palette: "kilim" },
  deco: { width: 2.0, length: 2.8, palette: "deco" },
  braided: { width: 1.6, length: 2.3, palette: "braid" },
  shag: { width: 1.8, length: 2.6, palette: "shag70s" },
}
const jobs: { name: string; spec: Partial<RugSpec> }[] = []
for (const s of style ? [style] : RUG_STYLES) for (const seed of seeds) jobs.push({ name: `${s}-${seed}`, spec: { style: s, seed, ...defaults[s], ...(palette ? { palette } : {}) } })
const files: string[] = []
for (const job of jobs) {
  const bake = bakeRug(job.spec, size)
  const raw = join(out, `${job.name}.rgba`)
  writeFileSync(raw, bake.mips[0]!)
  const png = join(out, `${job.name}.png`)
  // Show transparency over a dark floor so fringes and ovals read.
  await $`magick -size ${size}x${size} -depth 8 rgba:${raw} -background "#3a2a1e" -alpha remove -alpha off ${png}`.quiet()
  files.push(png)
  console.log(`${job.name}: ${bake.ms.toFixed(0)} ms`)
}
await $`magick montage ${files} -tile ${Math.min(files.length, 3)}x -geometry +6+6 -background "#222" ${join(out, "sheet.png")}`.quiet()
console.log(join(out, "sheet.png"))
