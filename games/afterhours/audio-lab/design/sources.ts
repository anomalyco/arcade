#!/usr/bin/env bun
// Raw, ugly source material for designed sounds (monsters round 2). Generated once with ElevenLabs into
// audio-lab/sources/<id>.mp3 (not on the audition page); recipes.ts layers and processes them with lab takes.
//
//   bun audio-lab/design/sources.ts            # generate missing sources
//   bun audio-lab/design/sources.ts --force fox-scream
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { generateSfx } from "../lib/eleven"

export const SOURCE_DIR = join(import.meta.dir, "..", "sources")

export const SOURCES: Record<string, { prompt: string; duration: number; influence?: number }> = {
  "woman-scream": { prompt: "woman screaming in raw terror, close, ragged, no music", duration: 3 },
  "fox-scream": { prompt: "red fox vixen screaming at night, harsh shrill scream, close", duration: 3 },
  "pig-squeal": { prompt: "pig squealing in distress, loud harsh squeal, close", duration: 2.5 },
  "elk-bugle": { prompt: "wildlife recording of a bull elk bugle in a forest, loud eerie whistling scream rising then grunting, distant echo", duration: 4 },
  "heron-croak": { prompt: "great blue heron harsh croaking call, rough guttural squawk, close", duration: 2.5 },
  "throat-drone": { prompt: "deep tuvan throat singing, very low growling drone, no melody", duration: 6 },
  "bowed-metal": { prompt: "bowed metal sheet and cymbal, screeching resonant metallic drone, slow", duration: 5 },
  "bone-cracks": { prompt: "bones cracking and snapping, joints popping, wet celery snaps, close foley", duration: 4 },
  "wet-tear": { prompt: "wet flesh tearing and squelching, raw meat pulled apart, close foley", duration: 3 },
  "dog-pant": { prompt: "large dog panting heavily and fast, close mic", duration: 3 },
  "human-pant": { prompt: "man breathing heavily, ragged frightened panting, close mic", duration: 3 },
  "wolf-howl": { prompt: "wildlife field recording of a grey wolf howling at night in a forest, one long howl", duration: 5 },
  "female-choir": { prompt: "female choir singing a sustained wordless ahh, sorrowful, dissonant, no instruments", duration: 6 },
  "teeth-chatter": { prompt: "teeth chattering fast and jaw clicking, dry clacking, close mic", duration: 2.5 },
  "long-inhale": { prompt: "very long slow deep inhale through the mouth, hollow, close mic", duration: 4 },
  "sob": { prompt: "woman sobbing and choking on tears, close, raw", duration: 3 },
  "antler-bark": { prompt: "antler scraping hard along tree bark, rough grinding scrape, close", duration: 3.5 },
}

export const sourcePath = (id: string) => join(SOURCE_DIR, `${id}.mp3`)

if (import.meta.main) {
  const force = new Set((process.argv[process.argv.indexOf("--force") + 1] ?? "").split(",").filter(Boolean))
  mkdirSync(SOURCE_DIR, { recursive: true })
  const metaFile = join(SOURCE_DIR, "sources.json")
  const meta: Record<string, unknown> = existsSync(metaFile) ? await Bun.file(metaFile).json() : {}
  let spent = 0
  const ids = Object.keys(SOURCES).filter((id) => force.has(id) || !existsSync(sourcePath(id)))
  let i = 0
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (i < ids.length) {
        const id = ids[i++]!
        const s = SOURCES[id]!
        const { audio, cost } = await generateSfx({ prompt: s.prompt, duration: s.duration, influence: s.influence ?? 0.6 })
        await Bun.write(sourcePath(id), audio)
        spent += cost ?? 0
        meta[id] = { ...s, cost, at: new Date().toISOString() }
        console.log(`${id}: ${cost} credits`)
      }
    }),
  )
  await Bun.write(metaFile, JSON.stringify(meta, null, 2) + "\n")
  console.log(`sources: ${ids.length} generated, ${spent} credits`)
}
