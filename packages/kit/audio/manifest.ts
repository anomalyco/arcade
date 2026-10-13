import type { SampleAssetMeta } from "./types"

export const DEFAULT_SAMPLE_MANIFEST: readonly SampleAssetMeta[] = [
  // Impact & collision layers (existing Getaway project samples)
  {
    id: "crash_thump_1",
    url: " crash_thump_1.mp3".trim(),
    category: "impact",
    material: "metal",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/crash_thump_1.mp3",
    fallbackSynth: { durationSeconds: 0.32, baseHz: 118, endHz: 36, noiseMix: 0.35, cutoffHz: 620, decayRate: 11 },
  },
  {
    id: "crash_thump_2",
    url: "crash_thump_2.mp3",
    category: "impact",
    material: "metal",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/crash_thump_2.mp3",
    fallbackSynth: { durationSeconds: 0.34, baseHz: 108, endHz: 33, noiseMix: 0.38, cutoffHz: 580, decayRate: 10.5 },
  },
  {
    id: "crash_thump_3",
    url: "crash_thump_3.mp3",
    category: "impact",
    material: "metal",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/crash_thump_3.mp3",
    fallbackSynth: { durationSeconds: 0.36, baseHz: 126, endHz: 39, noiseMix: 0.32, cutoffHz: 680, decayRate: 11.5 },
  },
  {
    id: "crash_crunch_1",
    url: "crash_crunch_1.mp3",
    category: "impact",
    material: "metal",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/crash_crunch_1.mp3",
    fallbackSynth: { durationSeconds: 0.45, baseHz: 280, endHz: 85, noiseMix: 0.72, cutoffHz: 2400, harmonicRatios: [1, 2.31, 3.87], decayRate: 8.5 },
  },
  {
    id: "crash_crunch_2",
    url: "crash_crunch_2.mp3",
    category: "impact",
    material: "metal",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/crash_crunch_2.mp3",
    fallbackSynth: { durationSeconds: 0.48, baseHz: 310, endHz: 92, noiseMix: 0.75, cutoffHz: 2650, harmonicRatios: [1, 2.18, 4.12], decayRate: 8.2 },
  },
  {
    id: "crash_crunch_3",
    url: "crash_crunch_3.mp3",
    category: "impact",
    material: "metal",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/crash_crunch_3.mp3",
    fallbackSynth: { durationSeconds: 0.44, baseHz: 265, endHz: 78, noiseMix: 0.7, cutoffHz: 2250, harmonicRatios: [1, 2.42, 3.65], decayRate: 8.8 },
  },
  {
    id: "crash_heavy_1",
    url: "crash_heavy_1.mp3",
    category: "impact",
    material: "metal",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/crash_heavy_1.mp3",
    fallbackSynth: { durationSeconds: 0.68, baseHz: 92, endHz: 26, noiseMix: 0.82, cutoffHz: 3100, harmonicRatios: [1, 1.85, 3.12, 4.7], decayRate: 6.2 },
  },
  {
    id: "crash_heavy_2",
    url: "crash_heavy_2.mp3",
    category: "impact",
    material: "metal",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/crash_heavy_2.mp3",
    fallbackSynth: { durationSeconds: 0.72, baseHz: 86, endHz: 24, noiseMix: 0.85, cutoffHz: 2950, harmonicRatios: [1, 1.92, 3.35, 4.9], decayRate: 5.9 },
  },
  {
    id: "crash_debris_1",
    url: "crash_debris_1.mp3",
    category: "impact",
    material: "glass",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/crash_debris_1.mp3",
    fallbackSynth: { durationSeconds: 0.55, baseHz: 1850, endHz: 1120, noiseMix: 0.65, cutoffHz: 4800, harmonicRatios: [1, 2.76, 5.4], decayRate: 9.5 },
  },
  {
    id: "crash_debris_2",
    url: "crash_debris_2.mp3",
    category: "impact",
    material: "glass",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/crash_debris_2.mp3",
    fallbackSynth: { durationSeconds: 0.58, baseHz: 2120, endHz: 1280, noiseMix: 0.62, cutoffHz: 5100, harmonicRatios: [1, 2.68, 5.15], decayRate: 9.2 },
  },
  {
    id: "crash_wall_1",
    url: "crash_wall_1.mp3",
    category: "impact",
    material: "concrete",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/crash_wall_1.mp3",
    fallbackSynth: { durationSeconds: 0.42, baseHz: 145, endHz: 48, noiseMix: 0.68, cutoffHz: 1450, decayRate: 9.8 },
  },
  // Tyre & surface samples
  {
    id: "skid_short",
    url: "skid_short.mp3",
    category: "tyre",
    material: "rubber",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/skid_short.mp3",
    fallbackSynth: { durationSeconds: 0.35, baseHz: 1420, endHz: 1680, noiseMix: 0.55, cutoffHz: 2600, harmonicRatios: [1, 1.48], decayRate: 7.5 },
  },
  {
    id: "tire_screech_loop",
    url: "tire_screech_loop.mp3",
    category: "tyre",
    material: "rubber",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/tire_screech_loop.mp3",
    loop: true,
    trimSilence: true,
    fallbackSynth: { durationSeconds: 1.5, baseHz: 1380, endHz: 1380, noiseMix: 0.6, cutoffHz: 2400, harmonicRatios: [1, 1.52], decayRate: 0, loop: true },
  },
  {
    id: "tire_scrub_loop",
    url: "tire_scrub_loop.mp3",
    category: "tyre",
    material: "rubber",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/tire_scrub_loop.mp3",
    loop: true,
    trimSilence: true,
    fallbackSynth: { durationSeconds: 1.5, baseHz: 420, endHz: 420, noiseMix: 0.9, cutoffHz: 1100, decayRate: 0, loop: true },
  },
  // Ambience & UI
  {
    id: "city_ambience_loop",
    url: "city_ambience_loop.mp3",
    category: "ambience",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/city_ambience_loop.mp3",
    loop: true,
    trimSilence: true,
    fallbackSynth: { durationSeconds: 2.0, baseHz: 110, endHz: 110, noiseMix: 0.88, cutoffHz: 360, decayRate: 0, loop: true },
  },
  {
    id: "ui_click",
    url: "ui_click.mp3",
    category: "ui",
    source: "project",
    license: "Proprietary project asset (Getaway public/sfx)",
    provenance: "games/getaway/public/sfx/ui_click.mp3",
    fallbackSynth: { durationSeconds: 0.08, baseHz: 1850, endHz: 920, noiseMix: 0.25, cutoffHz: 3800, decayRate: 42 },
  },
  // Curated ElevenLabs sound-design stems (generated offline during development, never called at runtime)
  {
    id: "stem_arcane_charge_loop",
    url: "stems/arcane_charge_loop.mp3",
    category: "spell",
    material: "arcane",
    source: "elevenlabs-sound-v2",
    modelId: "eleven_text_to_sound_v2",
    prompt: "Seamless crystalline arcane energy hum loop: warm resonant glass harmonic shimmer, subtle low magnetic pulse, clean studio sound effect, no music or speech.",
    license: "ElevenLabs commercial sound-generation license (Anomaly)",
    provenance: "Generated offline via ElevenLabs /v1/sound-generation (eleven_text_to_sound_v2, 2.25s, -5.5 dBFS peak)",
    loop: true,
    trimSilence: true,
    durationSeconds: 2.25,
    fallbackSynth: { durationSeconds: 2.0, baseHz: 330, endHz: 330, noiseMix: 0.22, cutoffHz: 1950, harmonicRatios: [1, 1.5, 2.0, 2.76], decayRate: 0, loop: true },
  },
  {
    id: "stem_arcane_cast_burst",
    url: "stems/arcane_cast_burst.mp3",
    category: "spell",
    material: "arcane",
    source: "elevenlabs-sound-v2",
    modelId: "eleven_text_to_sound_v2",
    prompt: "Single compact arcane spell release impact: crisp crystalline transient snap, focused low energy thump, short airy harmonic tail, dry studio foley, no music or speech.",
    license: "ElevenLabs commercial sound-generation license (Anomaly)",
    provenance: "Generated offline via ElevenLabs /v1/sound-generation (eleven_text_to_sound_v2, 1.00s, -10.7 dBFS peak)",
    trimSilence: true,
    durationSeconds: 1.0,
    fallbackSynth: { durationSeconds: 0.65, baseHz: 523.25, endHz: 261.63, noiseMix: 0.35, cutoffHz: 3400, harmonicRatios: [1, 1.5, 2.76, 3.99], decayRate: 6.8 },
  },
  {
    id: "stem_metal_shard_clink",
    url: "stems/metal_shard_clink.mp3",
    category: "impact",
    material: "metal",
    source: "elevenlabs-sound-v2",
    modelId: "eleven_text_to_sound_v2",
    prompt: "Single crisp metallic debris clink on asphalt: sharp steel contact ping with short natural ring decay, dry close foley, no background noise or reverb.",
    license: "ElevenLabs commercial sound-generation license (Anomaly)",
    provenance: "Generated offline via ElevenLabs /v1/sound-generation (eleven_text_to_sound_v2, 0.80s, -1.9 dBFS peak)",
    trimSilence: true,
    durationSeconds: 0.8,
    fallbackSynth: { durationSeconds: 0.38, baseHz: 1480, endHz: 1420, noiseMix: 0.2, cutoffHz: 4600, harmonicRatios: [1, 2.76, 5.4], decayRate: 12.5 },
  },
  {
    id: "stem_chassis_impact_deep",
    url: "stems/chassis_impact_deep.mp3",
    category: "impact",
    material: "metal",
    source: "elevenlabs-sound-v2",
    modelId: "eleven_text_to_sound_v2",
    prompt: "Single heavy car bodywork collision thud: punchy low metal sheet compression and tight bumper knock, short dry decay, no music.",
    license: "ElevenLabs commercial sound-generation license (Anomaly)",
    provenance: "Generated offline via ElevenLabs /v1/sound-generation (eleven_text_to_sound_v2, 0.88s, -11.2 dBFS peak)",
    trimSilence: true,
    durationSeconds: 0.88,
    fallbackSynth: { durationSeconds: 0.52, baseHz: 98, endHz: 31, noiseMix: 0.58, cutoffHz: 1850, harmonicRatios: [1, 1.68, 2.92], decayRate: 7.4 },
  },
] as const

/**
 * Strips MP3 encoder delay and digital zero padding at loop endpoints so continuous loops do not click.
 */
export function trimLoopPadding(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const d = buf.getChannelData(0)
  let a = 0
  let b = d.length
  while (a < b && Math.abs(d[a]!) < 1e-5) a++
  while (b > a && Math.abs(d[b - 1]!) < 1e-5) b--
  if (b - a < 64) return buf
  const out = ctx.createBuffer(buf.numberOfChannels, b - a, buf.sampleRate)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const slice = new Float32Array(buf.getChannelData(c).subarray(a, b))
    // Micro-fade 64 samples at both ends to guarantee zero loop-seam discontinuity
    const fade = Math.min(64, Math.floor(slice.length / 4))
    for (let i = 0; i < fade; i++) {
      const w = i / fade
      slice[i]! *= w
      slice[slice.length - 1 - i]! *= w
    }
    out.copyToChannel(slice, c)
  }
  return out
}

type DecodedPcm = {
  sampleRate: number
  channels: Float32Array[]
}

/**
 * Generates a deterministic PCM stem from a metadata fallback recipe so offline/headless tests
 * and environments without network fetch still exercise the exact sample-layer graph.
 */
export function synthesizeFallbackPcm(meta: SampleAssetMeta, sampleRate = 48000): DecodedPcm {
  const spec = meta.fallbackSynth ?? {
    durationSeconds: meta.durationSeconds ?? 0.4,
    baseHz: 220,
    endHz: 110,
    noiseMix: 0.4,
    cutoffHz: 1800,
    decayRate: 8,
    loop: meta.loop,
  }
  const length = Math.max(128, Math.floor(spec.durationSeconds * sampleRate))
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const ratios = spec.harmonicRatios ?? [1, 2.0]
  let seed = 0x9e3779b9
  for (let i = 0; i < meta.id.length; i++) {
    seed = Math.imul(seed ^ meta.id.charCodeAt(i), 1664525) + 1013904223 | 0
  }
  const nextNoise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0
    return (seed >>> 0) / 2147483648 - 1
  }

  let phase = 0
  let lpL = 0
  let lpR = 0
  const alpha = Math.min(0.95, (2 * Math.PI * (spec.cutoffHz ?? 2000)) / sampleRate)

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    const progress = i / length
    const freq = spec.endHz !== undefined ? spec.baseHz + (spec.endHz - spec.baseHz) * Math.pow(progress, 0.65) : spec.baseHz
    phase += (2 * Math.PI * freq) / sampleRate
    let tone = 0
    for (let r = 0; r < ratios.length; r++) {
      const ratio = ratios[r]!
      const modeDecay = spec.loop ? 1 : Math.exp(-t * (spec.decayRate ?? 8) * Math.pow(ratio, 0.55))
      tone += (Math.sin(phase * ratio) / Math.pow(r + 1, 0.85)) * modeDecay
    }
    const nL = nextNoise()
    const nR = nextNoise() * 0.4 + nL * 0.6
    lpL += (nL - lpL) * alpha
    lpR += (nR - lpR) * alpha
    const env = spec.loop
      ? 1
      : (t < 0.004 ? t / 0.004 : 1) * Math.exp(-t * (spec.decayRate ?? 8)) * (progress > 0.9 ? (1 - progress) / 0.1 : 1)
    const mix = spec.noiseMix ?? 0.4
    left[i] = ((1 - mix) * tone + mix * lpL) * env * 0.55
    right[i] = ((1 - mix) * tone + mix * lpR) * env * 0.55
  }

  if (spec.loop || meta.loop) {
    const fade = Math.min(128, Math.floor(length / 4))
    for (let i = 0; i < fade; i++) {
      const w = i / fade
      left[i]! *= w
      right[i]! *= w
      left[length - 1 - i]! *= w
      right[length - 1 - i]! *= w
    }
  }
  return { sampleRate, channels: [left, right] }
}

export function defaultSfxBaseUrl(): string {
  const metaEnv = (import.meta as unknown as { env?: { BASE_URL?: string } }).env
  const base = metaEnv?.BASE_URL ?? "/"
  return `${base.endsWith("/") ? base : `${base}/`}sfx/`
}

export class SampleBank {
  readonly manifest = new Map<string, SampleAssetMeta>()
  private rawBytes = new Map<string, Promise<ArrayBuffer | null>>()
  private decodedPcm = new Map<string, DecodedPcm>()
  private contextCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>()
  private baseUrl = defaultSfxBaseUrl()

  constructor(entries: readonly SampleAssetMeta[] = DEFAULT_SAMPLE_MANIFEST, baseUrl = defaultSfxBaseUrl()) {
    this.registerManifest(entries, baseUrl)
  }

  registerManifest(entries: readonly SampleAssetMeta[], baseUrl = this.baseUrl): void {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
    for (const entry of entries) {
      this.manifest.set(entry.id, entry)
    }
  }

  /** Pre-populates deterministic fallback stems so offline/unit renders work immediately without network I/O. */
  seedFallbacks(sampleRate = 48000): void {
    for (const [id, meta] of this.manifest) {
      if (!this.decodedPcm.has(id)) {
        this.decodedPcm.set(id, synthesizeFallbackPcm(meta, sampleRate))
      }
    }
  }

  /** Registers an already-decoded AudioBuffer or raw PCM channels under `id`. */
  setDecoded(id: string, buffer: AudioBuffer | DecodedPcm): void {
    if ("getChannelData" in buffer) {
      const channels: Float32Array[] = []
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        channels.push(new Float32Array(buffer.getChannelData(c)))
      }
      this.decodedPcm.set(id, { sampleRate: buffer.sampleRate, channels })
    } else {
      this.decodedPcm.set(id, buffer)
    }
  }

  /** Fetches and decodes manifest URLs against `ctx`, falling back cleanly to synthesized stems if a URL is unreachable. */
  async loadAll(ctx: BaseAudioContext, fetchImpl: typeof fetch | undefined = typeof fetch !== "undefined" ? fetch : undefined): Promise<number> {
    const tasks: Promise<void>[] = []
    for (const [id, meta] of this.manifest) {
      tasks.push(
        (async () => {
          if (fetchImpl) {
            let rawPromise = this.rawBytes.get(id)
            if (!rawPromise) {
              const url = meta.url.startsWith("http") || meta.url.startsWith("/") ? meta.url : `${this.baseUrl}${meta.url}`
              rawPromise = fetchImpl(url)
                .then(r => (r.ok ? r.arrayBuffer() : null))
                .catch(() => null)
              this.rawBytes.set(id, rawPromise)
            }
            const bytes = await rawPromise
            if (bytes && bytes.byteLength > 0) {
              try {
                const decoded = await ctx.decodeAudioData(bytes.slice(0))
                const trimmed = meta.loop || meta.trimSilence ? trimLoopPadding(ctx, decoded) : decoded
                this.setDecoded(id, trimmed)
                this.cacheForContext(ctx).set(id, trimmed)
                return
              } catch {}
            }
          }
          if (!this.decodedPcm.has(id)) {
            this.decodedPcm.set(id, synthesizeFallbackPcm(meta, ctx.sampleRate))
          }
        })(),
      )
    }
    await Promise.all(tasks)
    return this.decodedPcm.size
  }

  get loadedCount(): number {
    return this.decodedPcm.size
  }

  cloneDecodedTo(target: SampleBank): void {
    for (const [id, meta] of this.manifest) {
      target.manifest.set(id, meta)
    }
    for (const [id, pcm] of this.decodedPcm) {
      target.decodedPcm.set(id, pcm)
    }
  }

  getBuffer(ctx: BaseAudioContext, id: string): AudioBuffer | undefined {
    const perCtx = this.cacheForContext(ctx)
    const existing = perCtx.get(id)
    if (existing) return existing

    let pcm = this.decodedPcm.get(id)
    if (!pcm) {
      const meta = this.manifest.get(id)
      if (!meta) return undefined
      pcm = synthesizeFallbackPcm(meta, ctx.sampleRate)
      this.decodedPcm.set(id, pcm)
    }
    const buf = ctx.createBuffer(pcm.channels.length, pcm.channels[0]!.length, pcm.sampleRate)
    for (let c = 0; c < pcm.channels.length; c++) {
      buf.copyToChannel(new Float32Array(pcm.channels[c]!), c)
    }
    perCtx.set(id, buf)
    return buf
  }

  private cacheForContext(ctx: BaseAudioContext): Map<string, AudioBuffer> {
    let map = this.contextCache.get(ctx)
    if (!map) {
      map = new Map()
      this.contextCache.set(ctx, map)
    }
    return map
  }
}
