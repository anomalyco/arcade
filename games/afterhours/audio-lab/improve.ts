#!/usr/bin/env bun
// QA-driven regeneration. For every clip that the listening QA scores <= --threshold (default 3):
//   take 1 uses the current prompts.ts prompt for that variant (or a Gemini-refined one if unchanged),
//   further takes (--retries, default 2) use Gemini-refined prompts built from what the listener heard.
// The best-scoring take wins (the original wins ties); replaced files move to sfx/_previous/.
// New takes are loudness-normalised (lib/loudness.ts; raw kept in sfx-raw/).
// Then each category is topped up with new variants until it has --min-good (3) clips scoring >= 4,
// up to --max-variants (6). Approved takes (lib/approved.ts) and keep:true variants are never touched.
//
// --fresh: for the selected categories, every non-approved slot is regenerated from the current prompts.ts prompts
// (old takes move to sfx/_previous/), slots beyond the prompts.ts list are archived, then topped up as usual.
//
//   bun audio-lab/improve.ts --dry-run
//   bun audio-lab/improve.ts --force light-breaker/v1,light-breaker/v2
//   bun audio-lab/improve.ts --category hor-knock --budget 2000
import { mkdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { CATEGORIES, type CategorySpec, type VariantSpec } from "./prompts"
import { refinePrompt, judge, QA_MODEL, type Judgement } from "./lib/gemini"
import {
  addCost,
  generateSfx,
  loadManifest,
  ROOT,
  saveManifest,
  type Attempt,
  type Manifest,
  type ManifestSound,
} from "./lib/eleven"
import { qaSound } from "./qa"
import { isApproved, styleExamples } from "./lib/approved"
import { normaliseSound } from "./lib/loudness"

const { values: args } = parseArgs({
  options: {
    category: { type: "string", short: "c" },
    group: { type: "string", short: "g" },
    force: { type: "string" },
    fresh: { type: "boolean", default: false },
    threshold: { type: "string", default: "3" },
    retries: { type: "string", default: "2" },
    "min-good": { type: "string", default: "3" },
    "max-variants": { type: "string", default: "6" },
    concurrency: { type: "string", default: "4" },
    budget: { type: "string", default: "40000" },
    "dry-run": { type: "boolean", default: false },
  },
})

const THRESHOLD = Number(args.threshold)
const RETRIES = Number(args.retries)
const MIN_GOOD = Number(args["min-good"])
const MAX_VARIANTS = Number(args["max-variants"])
const BUDGET = Number(args.budget)
const forced = new Set((args.force ?? "").split(",").filter(Boolean))
const split = (s?: string) => (s ? s.split(",").filter(Boolean) : [])
const cats = CATEGORIES.filter(
  (c) =>
    (!args.category || split(args.category).includes(c.id)) && (!args.group || split(args.group).includes(c.group)),
)

const manifest: Manifest = await loadManifest()
const startCost = manifest.totalCost
const runStart = new Date().toISOString()
let spent = 0
const log: string[] = []

function out(line: string) {
  console.log(line)
  log.push(line)
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++])
    }),
  )
}

// 1. Judge everything that has no current QA.
const unjudged = manifest.sounds.filter(
  (s) => cats.some((c) => c.id === s.category) && (!s.qa || s.qa.intent !== CATEGORIES.find((c) => c.id === s.category)?.intent),
)
if (unjudged.length) out(`QA: judging ${unjudged.length} clips with ${QA_MODEL}`)
await pool(unjudged, Number(args.concurrency), async (s) => {
  try {
    await qaSound(s)
    saveManifest(manifest)
    console.log(`  ${s.file} ${s.qa!.score}/5  ${s.qa!.description}`)
  } catch (e) {
    console.error(`  QA failed ${s.file}: ${(e as Error).message}`)
  }
})

const isKeep = (cat: CategorySpec, variant: string) =>
  isApproved(cat.id, variant) || !!cat.variants[Number(variant.slice(1)) - 1]?.keep
const takeDir = (cat: string) => join(ROOT, "sfx", cat, ".takes")

interface Take {
  prompt: string
  influence: number
  audio?: ArrayBuffer
  cost: number | null
  j: Judgement
  original?: boolean
}

async function makeTake(cat: CategorySpec, spec: VariantSpec): Promise<Take> {
  if (spent >= BUDGET) throw new Error("budget exhausted")
  const { audio, cost } = await generateSfx(spec)
  spent += cost ?? 0
  addCost(manifest, cost)
  const j = await judge(audio, cat.intent)
  return { prompt: spec.prompt, influence: spec.influence ?? 0.5, audio, cost, j }
}

function goodExample(cat: CategorySpec): string | undefined {
  const approved = manifest.sounds.find((s) => s.category === cat.id && s.status === "approved")
  if (approved) return approved.prompt
  const locked = cat.variants.find((v) => v.keep)
  if (locked) return locked.prompt
  // In --fresh mode the category's old takes were rejected by ear; don't steer toward them.
  if (args.fresh) return undefined
  const best = manifest.sounds
    .filter((s) => s.category === cat.id && (s.qa?.score ?? 0) >= 4)
    .sort((a, b) => (b.qa?.score ?? 0) - (a.qa?.score ?? 0))[0]
  return best?.prompt
}

/** Runs up to 1 + RETRIES takes for a slot; returns all takes (excluding the original). */
async function takesFor(cat: CategorySpec, base: VariantSpec, history: Take[], firstPrompt?: string): Promise<Take[]> {
  const takes: Take[] = []
  for (let t = 0; t <= RETRIES; t++) {
    const all = [...history, ...takes]
    let prompt: string
    if (t === 0 && firstPrompt && !all.some((h) => h.prompt === firstPrompt)) prompt = firstPrompt
    else
      prompt = await refinePrompt({
        intent: cat.intent,
        goodExample: goodExample(cat),
        styleExamples: styleExamples(cat.id).slice(0, 12),
        attempts: all.map((h) => ({ prompt: h.prompt, description: h.j.description, score: h.j.score, issues: h.j.issues })),
      })
    const influence = Math.min(0.85, (base.influence ?? 0.5) + 0.05 * t)
    const take = await makeTake(cat, { ...base, prompt, influence })
    takes.push(take)
    console.log(`    take ${t + 1}: ${take.j.score}/5 "${prompt}" -> ${take.j.description}`)
    if (take.j.score >= 4) break
  }
  return takes
}

function attemptsOf(takes: Take[], chosen: Take): Attempt[] {
  return takes.map((t) => ({
    prompt: t.prompt,
    influence: t.influence,
    score: t.j.score,
    description: t.j.description,
    issues: t.j.issues,
    cost: t.cost,
    chosen: t === chosen,
  }))
}

async function install(
  cat: CategorySpec,
  variant: string,
  take: Take,
  spec: VariantSpec,
  status: ManifestSound["status"],
  attempts: Attempt[],
  old?: ManifestSound,
) {
  const file = `sfx/${cat.id}/${variant}.mp3`
  let previous: ManifestSound["previous"]
  if (old) {
    const prevFile = `sfx/_previous/${cat.id}/${variant}-${Date.parse(old.generatedAt) || Date.now()}.mp3`
    await mkdir(join(ROOT, "sfx/_previous", cat.id), { recursive: true })
    await rename(join(ROOT, file), join(ROOT, prevFile))
    previous = {
      prompt: old.prompt,
      file: prevFile,
      score: old.qa?.score,
      description: old.qa?.description,
      generatedAt: old.generatedAt,
    }
  }
  await Bun.write(join(ROOT, file), take.audio!)
  const entry: ManifestSound = {
    category: cat.id,
    group: cat.group,
    variant,
    prompt: take.prompt,
    duration: spec.duration ?? null,
    influence: take.influence,
    loop: !!(spec.loop ?? cat.loop),
    file,
    bytes: take.audio!.byteLength,
    cost: take.cost,
    generatedAt: new Date().toISOString(),
    qa: { ...take.j, intent: cat.intent, model: QA_MODEL, at: new Date().toISOString() },
    status,
    previous,
    attempts,
  }
  await normaliseSound(ROOT, entry)
  manifest.sounds = manifest.sounds.filter((s) => s.file !== file)
  manifest.sounds.push(entry)
  await saveManifest(manifest)
}

async function archive(s: ManifestSound) {
  const prevFile = `sfx/_previous/${s.category}/${s.variant}-${Date.parse(s.generatedAt) || Date.now()}.mp3`
  await mkdir(join(ROOT, "sfx/_previous", s.category), { recursive: true })
  await rename(join(ROOT, s.file), join(ROOT, prevFile))
  await rm(join(ROOT, s.file.replace(/^sfx\//, "sfx-raw/")), { force: true })
  manifest.sounds = manifest.sounds.filter((x) => x.file !== s.file)
}

async function improveCategory(cat: CategorySpec) {
  if (args.fresh && !args["dry-run"]) {
    // Archive non-approved slots beyond the prompts.ts list, and create entries for prompts with no slot yet.
    for (const s of manifest.sounds.filter((x) => x.category === cat.id)) {
      if (Number(s.variant.slice(1)) > cat.variants.length && !isKeep(cat, s.variant)) await archive(s)
    }
    for (let i = 0; i < cat.variants.length; i++) {
      const variant = `v${i + 1}`
      if (manifest.sounds.some((x) => x.category === cat.id && x.variant === variant) || isKeep(cat, variant)) continue
      const spec: VariantSpec = { ...cat.variants[i], loop: cat.variants[i].loop ?? cat.loop }
      console.log(`  ${cat.id}/${variant}: new slot`)
      try {
        const takes = await takesFor(cat, spec, [], spec.prompt)
        const best = takes.reduce((a, b) => (b.j.score > a.j.score ? b : a))
        await install(cat, variant, best, spec, "regenerated", attemptsOf(takes, best))
      } catch (e) {
        out(`  FAILED ${cat.id}/${variant}: ${(e as Error).message}`)
      }
    }
  }
  const sounds = manifest.sounds.filter((s) => s.category === cat.id && !(args.fresh && s.attempts && s.generatedAt > runStart))
  // 2. Fix weak (or forced) variants.
  for (const s of sounds) {
    const key = `${cat.id}/${s.variant}`
    if (isKeep(cat, s.variant)) {
      s.status = "approved"
      continue
    }
    const force = forced.has(key) || args.fresh
    if (!force && (s.qa?.score ?? 5) > THRESHOLD) {
      s.status ??= "kept"
      continue
    }
    const idx = Number(s.variant.slice(1)) - 1
    const base: VariantSpec = cat.variants[idx] ?? cat.variants[idx % cat.variants.length]
    const spec: VariantSpec = { ...base, duration: base.duration ?? s.duration ?? undefined, loop: base.loop ?? cat.loop }
    const original: Take = {
      prompt: s.prompt,
      influence: s.influence,
      cost: s.cost,
      original: true,
      j: { score: s.qa?.score ?? 0, description: s.qa?.description ?? "", issues: s.qa?.issues ?? "" },
    }
    if (args["dry-run"]) {
      out(`  would regenerate ${key} (${s.qa?.score}/5${force ? ", forced" : ""}) first prompt: ${base.prompt}`)
      continue
    }
    console.log(`  ${key} ${original.j.score}/5${force ? " (forced)" : ""}: ${original.j.description}`)
    try {
      const takes = await takesFor(cat, spec, [original], base.prompt)
      const candidates = force ? takes : [original, ...takes]
      // Original wins ties so user ratings stay on unchanged files.
      const best = candidates.reduce((a, b) => (b.j.score > a.j.score ? b : a))
      if (best.original) {
        s.status = "kept"
        s.attempts = attemptsOf(takes, best)
      } else await install(cat, s.variant, best, spec, "regenerated", attemptsOf(takes, best), s)
    } catch (e) {
      out(`  FAILED ${key}: ${(e as Error).message}`)
    }
  }
  // 3. Top up with new variants until MIN_GOOD clips score >= 4.
  const current = () => manifest.sounds.filter((s) => s.category === cat.id)
  let guard = 0
  while (
    current().filter((s) => (s.qa?.score ?? 0) >= 4).length < MIN_GOOD &&
    current().length < MAX_VARIANTS &&
    guard++ < MAX_VARIANTS
  ) {
    const n = current().length + 1
    const variant = `v${n}`
    if (args["dry-run"]) {
      out(`  would add ${cat.id}/${variant}`)
      break
    }
    const history: Take[] = current().flatMap((s) => [
      { prompt: s.prompt, influence: s.influence, cost: null, j: { score: s.qa?.score ?? 0, description: s.qa?.description ?? "", issues: s.qa?.issues ?? "" } },
      ...(s.attempts ?? []).filter((a) => !a.chosen).map((a) => ({ prompt: a.prompt, influence: a.influence, cost: null, j: a })),
    ])
    const base = cat.variants[(n - 1) % cat.variants.length]
    const spec: VariantSpec = { ...base, keep: false, loop: base.loop ?? cat.loop }
    console.log(`  ${cat.id}: adding ${variant}`)
    try {
      const takes = await takesFor(cat, spec, history.slice(-8))
      const best = takes.reduce((a, b) => (b.j.score > a.j.score ? b : a))
      if (best.j.score <= 2) {
        out(`  ${cat.id}/${variant} not added: best take ${best.j.score}/5`)
        break
      }
      await install(cat, variant, best, spec, "added", attemptsOf(takes, best))
    } catch (e) {
      out(`  FAILED adding ${cat.id}/${variant}: ${(e as Error).message}`)
      break
    }
  }
}

await pool(cats, Math.max(1, Number(args.concurrency)), async (cat) => {
  await improveCategory(cat)
  const s = manifest.sounds.filter((x) => x.category === cat.id)
  out(
    `${cat.id}: ${s.length} variants, ${s.filter((x) => (x.qa?.score ?? 0) >= 4).length} good, scores ${s.map((x) => `${x.variant}=${x.qa?.score ?? "?"}${x.status === "regenerated" ? "*" : x.status === "added" ? "+" : x.status === "approved" ? "A" : ""}`).join(" ")}`,
  )
})

for (const c of cats) await rm(takeDir(c.id), { recursive: true, force: true })
await saveManifest(manifest)
out(`ElevenLabs credits this run: ${spent} (manifest total ${startCost} -> ${manifest.totalCost})`)
