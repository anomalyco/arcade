// ElevenLabs sound generation + audio-lab manifest helpers.
import { join } from "node:path"
import type { CategorySpec, VariantSpec } from "../prompts"
import { CATEGORIES } from "../prompts"
import type { LoudnessInfo } from "./loudness"
import { isApproved } from "./approved"

export const ROOT = join(import.meta.dir, "..")
export const OUT = join(ROOT, "sfx")
export const MANIFEST = join(OUT, "manifest.json")
export const MODEL = "eleven_text_to_sound_v2"
export const FORMAT = "mp3_44100_64"

export interface QaResult {
  score: number
  description: string
  issues: string
  intent: string
  model: string
  at: string
}

export interface Attempt {
  prompt: string
  influence: number
  score: number
  description: string
  issues: string
  cost: number | null
  chosen: boolean
}

export interface ManifestSound {
  category: string
  group: string
  variant: string
  prompt: string
  duration: number | null
  influence: number
  loop: boolean
  file: string
  bytes: number
  cost: number | null
  generatedAt: string
  qa?: QaResult
  /** "kept" (original take passed), "regenerated" (replaced by a better take), "added" (new variant),
   *  "approved" (user picked it by ear; never replaced, see lib/approved.ts) */
  status?: "kept" | "regenerated" | "added" | "approved"
  previous?: { prompt: string; file: string; score?: number; description?: string; generatedAt: string }
  attempts?: Attempt[]
  loudness?: LoudnessInfo
}

export interface Manifest {
  model: string
  format: string
  updatedAt: string
  totalCost: number
  qaCost?: number
  categories: { id: string; group: string; label: string; intent: string; loop: boolean }[]
  sounds: ManifestSound[]
}

let cachedKey: string | undefined
export async function elevenKey(): Promise<string> {
  if (cachedKey) return cachedKey
  const fromEnv = process.env.ELEVEN_LABS_API_KEY ?? process.env.ELEVENLABS_API_KEY
  if (fromEnv) return (cachedKey = fromEnv.trim())
  const text = await Bun.file(join(process.env.HOME ?? "", "development/.env")).text()
  const m = text.match(/^\s*(?:export\s+)?ELEVEN_LABS_API_KEY\s*=\s*(.*)$/m)
  if (!m) throw new Error("ELEVEN_LABS_API_KEY not found in ~/development/.env")
  return (cachedKey = m[1].trim().replace(/^["']|["']$/g, ""))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Thrown when the key's credit quota is exhausted; callers should stop instead of retrying. */
export class QuotaError extends Error {
  constructor(public remaining: number | null, detail: string) {
    super(`ElevenLabs quota exceeded (${remaining ?? "?"} credits remaining): ${detail}`)
  }
}
export let quotaHit: QuotaError | null = null

export async function generateSfx(spec: VariantSpec): Promise<{ audio: ArrayBuffer; cost: number | null }> {
  if (quotaHit) throw quotaHit
  const key = await elevenKey()
  const body: Record<string, unknown> = { text: spec.prompt, model_id: MODEL, prompt_influence: spec.influence ?? 0.3 }
  if (spec.duration) body.duration_seconds = Math.min(30, Math.max(0.5, spec.duration))
  if (spec.loop) body.loop = true
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.elevenlabs.io/v1/sound-generation?output_format=${FORMAT}`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      const cost = res.headers.get("character-cost")
      return { audio: await res.arrayBuffer(), cost: cost ? Number(cost) : null }
    }
    const detail = (await res.text()).slice(0, 300)
    if (detail.includes("quota_exceeded")) {
      const remaining = Number(detail.match(/You have (\d+) credits remaining/)?.[1] ?? NaN)
      quotaHit = new QuotaError(Number.isFinite(remaining) ? remaining : null, detail)
      throw quotaHit
    }
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt >= 5) throw new Error(`HTTP ${res.status}: ${detail}`)
    const wait = Number(res.headers.get("retry-after")) * 1000 || 1500 * 2 ** (attempt - 1)
    console.warn(`  ElevenLabs ${res.status}, retry ${attempt} in ${Math.round(wait / 1000)}s`)
    await sleep(wait)
  }
}

export async function loadManifest(): Promise<Manifest> {
  const f = Bun.file(MANIFEST)
  if (await f.exists()) return (await f.json()) as Manifest
  return { model: MODEL, format: FORMAT, updatedAt: "", totalCost: 0, categories: [], sounds: [] }
}

let writeChain: Promise<unknown> = Promise.resolve()
export function saveManifest(m: Manifest): Promise<unknown> {
  writeChain = writeChain.then(async () => {
    const order = new Map(CATEGORIES.map((c, i) => [c.id, i]))
    for (const s of m.sounds) if (isApproved(s.category, s.variant)) s.status = "approved"
    m.categories = CATEGORIES.map((c) => ({ id: c.id, group: c.group, label: c.label, intent: c.intent, loop: !!c.loop }))
    m.sounds.sort(
      (a, b) =>
        (order.get(a.category) ?? 999) - (order.get(b.category) ?? 999) ||
        a.variant.localeCompare(b.variant, undefined, { numeric: true }),
    )
    m.updatedAt = new Date().toISOString()
    await Bun.write(MANIFEST, JSON.stringify(m, null, 2) + "\n")
  })
  return writeChain
}

/** Adds credits spent this run (including discarded takes) to the manifest's running total. */
export function addCost(m: Manifest, cost: number | null) {
  m.totalCost = (m.totalCost ?? 0) + (cost ?? 0)
}

export function categoryById(id: string): CategorySpec | undefined {
  return CATEGORIES.find((c) => c.id === id)
}
