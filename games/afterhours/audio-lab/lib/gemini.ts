// Gemini audio-understanding helpers for the audio lab's listening QA.
import { join } from "node:path"

export const QA_MODEL = process.env.QA_MODEL ?? "gemini-3.8-flash"

let cachedKey: string | undefined
async function apiKey(): Promise<string> {
  if (cachedKey) return cachedKey
  const fromEnv = process.env.GEMINI_API_KEY
  if (fromEnv) return (cachedKey = fromEnv.trim())
  const text = await Bun.file(join(process.env.HOME ?? "", "development/.env")).text()
  const m = text.match(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/m)
  if (!m) throw new Error("GEMINI_API_KEY not found in ~/development/.env")
  return (cachedKey = m[1].trim().replace(/^["']|["']$/g, ""))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function generate(parts: unknown[], schema: Record<string, unknown>): Promise<any> {
  const key = await apiKey()
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 },
  }
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${QA_MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      const j: any = await res.json()
      const text = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? ""
      try {
        return JSON.parse(text)
      } catch {
        if (attempt >= 4) throw new Error(`Bad JSON from ${QA_MODEL}: ${text.slice(0, 200)}`)
      }
    } else {
      const detail = (await res.text()).slice(0, 300)
      if (!(res.status === 429 || res.status >= 500) || attempt >= 5) throw new Error(`Gemini HTTP ${res.status}: ${detail}`)
    }
    await sleep(2000 * 2 ** (attempt - 1))
  }
}

export interface Judgement {
  description: string
  score: number
  issues: string
}

const JUDGE_SCHEMA = {
  type: "OBJECT",
  properties: {
    description: { type: "STRING" },
    score: { type: "INTEGER" },
    issues: { type: "STRING" },
  },
  required: ["description", "score", "issues"],
}

export async function judge(audio: ArrayBuffer, intent: string): Promise<Judgement> {
  const prompt = `You are a strict game sound designer auditioning a sound effect for a realistic first-person horror game set in a 1984 federal research station in a foggy pine forest.

Listen to the attached clip. First describe exactly what this sound is, literally and physically (the objects, materials, actions, space/reverb, perspective close or distant, timing, and anything unexpected such as music, voices, synth tones, or artifacts). Do not assume it is what it is supposed to be; describe what you actually hear.

Then rate 1–5 how well it matches this intent: "${intent}"
5 = convincing, realistic, usable as-is; 4 = matches with minor flaws; 3 = recognisable but clearly off (wrong material, wrong action, extra elements, unrealistic); 2 = mostly a different sound; 1 = unrelated, music, or broken.

Return JSON: description (1–2 sentences, concrete), score (integer 1–5), issues (short; what is wrong vs the intent, or "none").`
  const parts = [
    { inline_data: { mime_type: "audio/mp3", data: Buffer.from(audio).toString("base64") } },
    { text: prompt },
  ]
  const r = await generate(parts, JUDGE_SCHEMA)
  return {
    description: String(r.description ?? "").trim(),
    score: Math.max(1, Math.min(5, Math.round(Number(r.score) || 1))),
    issues: String(r.issues ?? "").trim(),
  }
}

export async function refinePrompt(opts: {
  intent: string
  goodExample?: string
  styleExamples?: string[]
  attempts: { prompt: string; description: string; score: number; issues: string }[]
}): Promise<string> {
  const history = opts.attempts
    .map((a, i) => `Attempt ${i + 1} prompt: "${a.prompt}"\n  What it produced (score ${a.score}/5): ${a.description}\n  Issues: ${a.issues}`)
    .join("\n")
  const prompt = `You write prompts for the ElevenLabs text-to-sound-effects model. It works best with short, literal, physical sound-design descriptions: the exact object, its material, the action performed on it, the consequence sound, mic perspective (close-mic or distant), the room/space, and the length. Never ask for music or voices unless intended. Avoid mood words like "eerie" or "cinematic" unless the intent is a designed stinger; avoid listing many unrelated elements.

Target sound: "${opts.intent}"
${opts.goodExample ? `A prompt that worked well in this family: "${opts.goodExample}"\n` : ""}${
    opts.styleExamples?.length
      ? `House style: prompts whose results the director approved by ear (match their length and tone: short, lowercase, comma-separated, one concrete object/material/action, the space, close mic or distant):\n${opts.styleExamples.map((p) => `- "${p}"`).join("\n")}\n`
      : ""
  }
Previous attempts and what an expert listener heard:
${history}

Write ONE improved prompt (max 22 words, no durations, no word "loopable") that fixes those issues. Return JSON { "prompt": string }.`
  const r = await generate([{ text: prompt }], {
    type: "OBJECT",
    properties: { prompt: { type: "STRING" } },
    required: ["prompt"],
  })
  return String(r.prompt).trim()
}
