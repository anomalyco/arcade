import { describe, expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { selectSfx, SFX_LIBRARY, sfxCues, sfxManifest, variantId } from "./library"
import { analyzeSfx, integratedLufs, momentaryMaxLufs } from "./sfx-analysis"

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url))

/** Ids the games rely on by name. */
const REQUIRED = [
  "gun.pistol.shot", "gun.pistol.reload", "gun.dry-fire", "door.wood.open", "door.wood.close", "door.locked", "window.slide",
  "barricade.hammer", "search.rummage", "pickup.ammo", "flashlight.click", "zombie.groan.idle", "zombie.alert", "zombie.attack",
  "zombie.hit", "zombie.death", "body.hurt", "ambience.night.suburb", "ui.click",
  ...["concrete", "grass", "wood"].flatMap(s => [`foot.${s}.walk`, `foot.${s}.run`]),
]

/**
 * Budget for files the library owns (compressed, MB). 3 → 4 for Outbreak's three stereo rain beds and thunder (AR-71,
 * +0.96 MB); 4 → 6 for the Lot storm's six positional beds, thunder by distance, wind and drips (+1.7 MB, fetched only
 * once its weather is first turned on).
 */
const LIBRARY_MB = 6

describe("sound library catalogue", () => {
  test("ids are unique, semantic and include every id the games use", () => {
    const ids = SFX_LIBRARY.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z]+(\.[a-z-]+)+$/)
    for (const id of REQUIRED) expect(ids).toContain(id)
  })

  test("every id resolves to its variants, each with a licence, provenance and a file on disk", () => {
    for (const entry of SFX_LIBRARY) {
      expect(entry.files.length, entry.id).toBe(entry.reuse ? entry.reuse.length : entry.variants)
      for (const file of entry.files) {
        expect(file.license.length, file.file).toBeGreaterThan(10)
        expect(file.provenance.length, file.file).toBeGreaterThan(10)
        expect(existsSync(repo(file.path)), file.path).toBe(true)
        expect(statSync(repo(file.path)).size, file.path).toBe(file.bytes)
      }
    }
  })

  test("files stay inside the size budget", () => {
    const owned = SFX_LIBRARY.flatMap(e => e.files).filter(f => f.path.startsWith("packages/kit/audio/sfx/"))
    const total = owned.reduce((s, f) => s + f.bytes, 0)
    expect(total / 1048576).toBeLessThan(LIBRARY_MB)
    const loops = new Set(SFX_LIBRARY.filter(e => e.loop).flatMap(e => e.files.map(f => f.file)))
    for (const f of owned) expect(f.bytes, f.file).toBeLessThan(loops.has(f.file) ? 420_000 : 60_000)
  })

  test("variants are loudness-matched to their target, unclipped, and inside the id's duration range", () => {
    for (const entry of SFX_LIBRARY) {
      for (const f of entry.files) {
        // Playback gain lands every variant on the target; generated files are normalised so that gain stays small (it only makes up for the -1 dBFS peak cap on peaky takes).
        expect(Math.abs(f.loudness + 20 * Math.log10(f.gain) - entry.target), f.file).toBeLessThan(0.15)
        if (entry.generate) expect(f.gain, f.file).toBeLessThan(1.7)
        expect(f.peakDb, f.file).toBeLessThan(-0.5)
        const [lo, hi] = entry.durationRange
        expect(f.durationSeconds, f.file).toBeGreaterThanOrEqual(lo - 0.02)
        expect(f.durationSeconds, f.file).toBeLessThanOrEqual(hi + 0.05)
      }
    }
  })

  test("cues reference exactly the manifest's variants, with seeded round-robin and jitter", () => {
    const manifest = new Set(sfxManifest(SFX_LIBRARY).map(m => m.id))
    for (const cue of sfxCues(SFX_LIBRARY)) {
      const entry = SFX_LIBRARY.find(e => e.id === cue.id)!
      const layer = cue.layers[0]!
      expect(layer.kind).toBe("sample")
      if (layer.kind !== "sample") continue
      expect(layer.selection).toBe("round-robin")
      expect(layer.samples.length).toBe(entry.files.length)
      layer.samples.forEach((s, i) => {
        const id = typeof s === "string" ? s : s.id
        expect(id).toBe(variantId(entry.id, i))
        expect(manifest.has(id)).toBe(true)
      })
      expect(cue.pitchVariation).toBe(entry.pitchJitter)
    }
  })

  test("selection by id, group prefix and game", () => {
    expect(selectSfx(undefined)).toEqual([])
    expect(selectSfx(["gun.pistol.shot"]).map(e => e.id)).toEqual(["gun.pistol.shot"])
    expect(selectSfx(["zombie.*"]).every(e => e.id.startsWith("zombie."))).toBe(true)
    expect(selectSfx(["game:outbreak"]).length).toBeGreaterThan(30)
    expect(selectSfx("all").length).toBe(SFX_LIBRARY.length)
  })
})

describe("loudness analysis", () => {
  const sine = (dbfs: number, seconds: number) => {
    const n = Math.round(48000 * seconds)
    const a = 10 ** (dbfs / 20)
    return Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * 997 * i) / 48000))
  }
  test("a full-scale 997 Hz mono sine reads -3.01 LUFS (BS.1770)", () => {
    expect(integratedLufs([sine(0, 2)])).toBeCloseTo(-3.01, 1)
    expect(momentaryMaxLufs([sine(-20, 2)])).toBeCloseTo(-23.01, 1)
  })
  test("silence trim and peak", () => {
    const x = new Float32Array(48000)
    x.set(sine(-6, 0.25), 12000)
    const s = analyzeSfx([x])
    expect(s.leadingSilence).toBeCloseTo(0.25, 2)
    expect(s.peakDb).toBeCloseTo(-6, 1)
    expect(s.clippedSamples).toBe(0)
  })
})
