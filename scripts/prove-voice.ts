import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createServer } from "vite"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { browserBudget } from "./browser-budget"
import type { VoiceProof } from "./voice/client"
import { proveBarbaraVoice } from "./voice/barbara"

declare global { interface Window { proof: VoiceProof } }

const out = process.env.LEASE_OUT ?? "captures/voice-chat"
const barbara = process.argv.includes("--barbara")
await mkdir(out, { recursive: true })
// Deterministic mic: two speech-band tones, long enough for the complete proof, never sent to a speaker.
const wav = Buffer.alloc(44 + 48000 * 90 * 2)
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40)
for (let i = 0; i < (wav.length - 44) / 2; i++) wav.writeInt16LE(Math.round(4000 * (Math.sin(i / 48000 * Math.PI * 2 * 700) + Math.sin(i / 48000 * Math.PI * 2 * 2300))), 44 + i * 2)
const mic = resolve(out, "microphone.wav")
await writeFile(mic, wav)
// Wrangler's Node HTTP upgrade proxy must run on Node, not Bun's partial upgrade implementation.
const worker = spawn("node", ["node_modules/wrangler/bin/wrangler.js", "dev", "--config", barbara ? "games/barbara/wrangler.jsonc" : "scripts/voice/wrangler.jsonc", "--local", "--ip", "127.0.0.1", "--port", "0", "--inspector-port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" } })
let workerLog = ""
const ready = new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => { worker.kill(); reject(new Error(`Wrangler startup timed out: ${workerLog}`)) }, 30_000)
  worker.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Wrangler exited ${code}: ${workerLog}`)) })
  const output = (chunk: Buffer) => { workerLog += chunk.toString(); const match = workerLog.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]!) } }
  worker.stdout!.on("data", output); worker.stderr!.on("data", output)
})
const workerUrl = await ready
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "voice-proof-page", configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url === "/" || req.url?.startsWith("/?")) { res.setHeader("Content-Type", "text/html"); res.end('<script type="module" src="/scripts/voice/client.ts"></script>') } else next() }) } }] })
try {
  await vite.listen()
  await using budget = browserBudget()
  const browser = await budget.chromium.launch({ headless: true, args: ["--mute-audio", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${mic}`, "--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns", "--allow-loopback-in-peer-connection", ...(barbara ? ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist"] : [])] })
  if (barbara) {
    await proveBarbaraVoice(browser, `${workerUrl}/arcade/barbara/`, out).catch((error) => { console.error("BARBARA proof failed:", error); throw error })
  } else {
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?ws=${encodeURIComponent(`${workerUrl.replace("http:", "ws:")}/ws/test`)}`
  const contexts = await Promise.all([browser.newContext(), browser.newContext()])
  const pages = await Promise.all(contexts.map((c) => c.newPage()))
  const errors: string[] = []
  for (const page of pages) {
    page.on("pageerror", (e) => { errors.push(e.message); console.error("page error:", e.message) })
    page.on("console", (m) => { if (m.type() === "error") console.error("browser:", m.text()) })
    page.setDefaultTimeout(20_000)
    await page.goto(url)
    await page.waitForFunction(() => window.proof?.state().socket === null).catch(async (e) => { console.error("room handshake", await page.evaluate(() => window.proof?.state()), errors); throw e })
  }
  for (const page of pages) assert.equal(await page.evaluate(() => window.proof.state().permissions), 0, "no mic request on join")
  for (const page of pages) await page.locator('[data-voice="enabled"]').check()
  for (const page of pages) await page.waitForFunction(() => window.proof.state().peers.some((p) => p.connection === "connected" && p.level > 0.005)).catch(async (e) => { console.error("voice handshake", JSON.stringify(await Promise.all(pages.map((p) => p.evaluate(async () => ({ state: window.proof.state(), stats: await window.proof.stats() })))), null, 2)); throw e })
  const receiver = pages[1]!
  await receiver.waitForFunction(() => window.proof.state().peers[0]!.level > 0.01)
  const near = await receiver.evaluate(() => window.proof.level())
  const offline = await receiver.evaluate(() => window.proof.offline())
  await receiver.evaluate(() => window.proof.set(30))
  // A bounded audio settling interval, not a background-job poll.
  await receiver.waitForTimeout(400)
  const far = await receiver.evaluate(() => window.proof.level())
  await receiver.evaluate(() => window.proof.set(2, 1))
  await receiver.waitForTimeout(400)
  const occluded = await receiver.evaluate(() => window.proof.level())
  assert(near > 0.005, `received microphone: ${near}`)
  assert(far < near * 0.3, `distance: ${near} -> ${far}`)
  assert(occluded < near * 0.4, `occlusion: ${near} -> ${occluded}`)
  assert(offline.far! < offline.near! * 0.3 && offline.occluded! < offline.near! * 0.4)
  assert(offline.outOfRange! < 0.00001 && offline.radioFar! > 0.005)
  await pages[0]!.evaluate(() => window.proof.voice.setEnabled(false))
  await receiver.waitForFunction(() => window.proof.state().peers.length === 0)
  assert.deepEqual(errors, [])
  const report = { passed: true, transport: "two Chromium contexts / fake microphone / WebRTC Opus / local Wrangler RoomCore", live: { near, far, occluded }, offline, micPermissionOnlyOnOptIn: true, peerCleanupOnDisable: true, errors }
  await writeFile(`${out}/two-client.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  for (const page of pages) await page.evaluate(() => window.proof.close())
  }
} finally {
  await vite.close()
  worker.kill("SIGTERM")
  if (worker.exitCode === null) await once(worker, "exit")
  await import("node:fs/promises").then((fs) => fs.rm(mic, { force: true }))
}
