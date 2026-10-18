#!/usr/bin/env bun
// Generate candidate SFX with the ElevenLabs Sound Effects API into audio-lab/sfx/<category>/<variant>.mp3
// and keep audio-lab/sfx/manifest.json in sync. Run `bun audio-lab/qa.ts` (or improve.ts) afterwards to judge them.
//
//   bun audio-lab/generate.ts                                  # everything missing
//   bun audio-lab/generate.ts --category foot-gravel --force   # regenerate one category from prompts.ts
//   bun audio-lab/generate.ts --category hor-knock --variants 5 --force
//   bun audio-lab/generate.ts --category hor-knock --prompt "two knocks on glass" --variants 4 --force
//   bun audio-lab/generate.ts --group horror --dry-run
//   bun audio-lab/generate.ts --list
//
// --force never replaces approved takes (lib/approved.ts: picks-*.json exports) or `keep: true` variants.
import { mkdir, readdir, rename } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { CATEGORIES, type CategorySpec, type VariantSpec } from "./prompts"
import { isApproved } from "./lib/approved"
import { normaliseSound } from "./lib/loudness"
import { addCost, generateSfx, loadManifest, OUT, ROOT, saveManifest, type ManifestSound } from "./lib/eleven"

const { values: args } = parseArgs({
  options: {
    category: { type: "string", short: "c" },
    group: { type: "string", short: "g" },
    variants: { type: "string", short: "n" },
    prompt: { type: "string", short: "p" },
    duration: { type: "string", short: "d" },
    force: { type: "boolean", short: "f", default: false },
    concurrency: { type: "string", default: "3" },
    "dry-run": { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
})

if (args.help) {
  console.log(`Usage: bun audio-lab/generate.ts [options]
  -c, --category <ids>   comma-separated category ids (default: all)
  -g, --group <groups>   comma-separated groups (footsteps, doors, lift, lights, ambience, interactions, horror, ui)
  -n, --variants <N>     variants per category (cycles prompts.ts prompts with varied prompt_influence)
  -p, --prompt <text>    override the prompt for every variant of the selected categories
  -d, --duration <sec>   override duration (0.5–30)
  -f, --force            regenerate even if the file exists (old takes move to sfx/_previous/; keep:true is spared)
      --concurrency <N>  parallel requests (default 3)
      --dry-run          print what would be generated
      --list             list categories`)
  process.exit(0)
}

if (args.list) {
  for (const c of CATEGORIES) console.log(`${c.group.padEnd(13)} ${c.id.padEnd(22)} ${c.variants.length}  ${c.label}`)
  process.exit(0)
}

function split(s?: string) {
  return s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []
}

function selectCategories(): CategorySpec[] {
  const ids = split(args.category)
  const groups = split(args.group)
  const unknown = ids.filter((id) => !CATEGORIES.some((c) => c.id === id))
  if (unknown.length) throw new Error(`Unknown category: ${unknown.join(", ")} (see --list)`)
  return CATEGORIES.filter((c) => (!ids.length || ids.includes(c.id)) && (!groups.length || groups.includes(c.group)))
}

const INFLUENCE_SPREAD = [0.3, 0.45, 0.6, 0.75, 0.35, 0.5]

function plan(cat: CategorySpec): VariantSpec[] {
  const n = args.variants ? Math.max(1, Number(args.variants)) : cat.variants.length
  const out: VariantSpec[] = []
  for (let i = 0; i < n; i++) {
    const base = cat.variants[i % cat.variants.length]
    const cycled = i >= cat.variants.length
    if (base.keep && !cycled) {
      out.push(base)
      continue
    }
    const prompt = args.prompt ?? base.prompt
    const influence = args.prompt || cycled ? INFLUENCE_SPREAD[i % INFLUENCE_SPREAD.length] : (base.influence ?? 0.3)
    const duration = args.duration ? Number(args.duration) : base.duration
    out.push({ prompt, influence, duration, loop: base.loop ?? cat.loop })
  }
  return out
}

const manifest = await loadManifest()
const jobs: { cat: CategorySpec; variant: string; spec: VariantSpec; file: string }[] = []
for (const cat of selectCategories()) {
  const dir = join(OUT, cat.id)
  await mkdir(dir, { recursive: true })
  const existing = new Set(await readdir(dir).catch(() => [] as string[]))
  plan(cat).forEach((spec, i) => {
    const variant = `v${i + 1}`
    const has = existing.has(`${variant}.mp3`)
    if (has && (!args.force || spec.keep || isApproved(cat.id, variant))) return
    jobs.push({ cat, variant, spec, file: `sfx/${cat.id}/${variant}.mp3` })
  })
}

if (args["dry-run"]) {
  for (const j of jobs)
    console.log(`${j.file}  ${j.spec.duration ?? "auto"}s  pi=${j.spec.influence}${j.spec.loop ? " loop" : ""}  ${j.spec.prompt}`)
  console.log(`${jobs.length} sounds, ~${jobs.reduce((s, j) => s + (j.spec.duration ?? 5), 0).toFixed(0)} s audio`)
  process.exit(0)
}

console.log(`Generating ${jobs.length} sounds…`)
let next = 0
let done = 0
let failed = 0
let runCost = 0

async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++]
    try {
      const { audio, cost } = await generateSfx(job.spec)
      const old = manifest.sounds.find((s) => s.file === job.file)
      let previous: ManifestSound["previous"]
      if (old && (await Bun.file(join(ROOT, job.file)).exists())) {
        const prevFile = `sfx/_previous/${job.cat.id}/${job.variant}-${Date.parse(old.generatedAt) || Date.now()}.mp3`
        await mkdir(join(ROOT, "sfx/_previous", job.cat.id), { recursive: true })
        await rename(join(ROOT, job.file), join(ROOT, prevFile))
        previous = { prompt: old.prompt, file: prevFile, score: old.qa?.score, description: old.qa?.description, generatedAt: old.generatedAt }
      }
      await Bun.write(join(ROOT, job.file), audio)
      runCost += cost ?? 0
      addCost(manifest, cost)
      const entry: ManifestSound = {
        category: job.cat.id,
        group: job.cat.group,
        variant: job.variant,
        prompt: job.spec.prompt,
        duration: job.spec.duration ?? null,
        influence: job.spec.influence ?? 0.3,
        loop: !!job.spec.loop,
        file: job.file,
        bytes: audio.byteLength,
        cost,
        generatedAt: new Date().toISOString(),
        status: old ? "regenerated" : undefined,
        previous,
      }
      await normaliseSound(ROOT, entry)
      manifest.sounds = manifest.sounds.filter((s) => s.file !== job.file)
      manifest.sounds.push(entry)
      saveManifest(manifest)
      done++
      console.log(`[${done + failed}/${jobs.length}] ${job.file} ${(audio.byteLength / 1024).toFixed(0)} KB cost=${cost ?? "?"}`)
    } catch (err) {
      failed++
      console.error(`[${done + failed}/${jobs.length}] FAILED ${job.file}: ${(err as Error).message}`)
    }
  }
}

await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency)) }, worker))
await saveManifest(manifest)
console.log(`Done: ${done} ok, ${failed} failed, run cost ${runCost} credits, manifest total ${manifest.totalCost} credits.`)
if (failed) process.exit(1)
