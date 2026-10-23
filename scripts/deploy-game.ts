// Run from games/<game>, after check + smoke in CI. The marker travels with the deployed assets, so a failed
// deploy cannot advance a separate cache. --dry builds/fingerprints only; --no-build reuses the checked build.
import { $ } from "bun"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"

export const ROOM_GAMES = new Set(["getaway", "blackout", "outbreak", "carrier", "brawl", "archers", "barbara"])
const GAMES = new Set([...ROOM_GAMES, "lab", "walkers", "lot", "nightshift"])
const WORKER_OUT = ".wrangler/deploy-check"

function files(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

/** Hash the actual shipped bytes and deploy configuration, not source paths or the triggering commit. */
export function fingerprint(cwd: string, game: string): string {
  const hash = createHash("sha256").update("arcade-deploy-v2\0")
  const add = (name: string, bytes: Uint8Array) => {
    hash.update(`${name}\0${bytes.byteLength}\0`).update(bytes)
  }
  for (const root of ["dist", WORKER_OUT]) {
    for (const path of files(join(cwd, root))) {
      const name = relative(join(cwd, root), path)
      if (root === "dist" && name === `arcade/${game}/deploy.txt`) continue
      // Wrangler's diagnostics vary with checkout location; they are not executed by the Worker.
      if (root === WORKER_OUT && (name.endsWith(".map") || name === "README.md")) continue
      add(`${root}/${name}`, readFileSync(path))
    }
  }
  add("wrangler.jsonc", readFileSync(join(cwd, "wrangler.jsonc")))
  return hash.digest("hex")
}

export function playerCount(body: unknown): number | null {
  if (!body || typeof body !== "object" || !("players" in body)) return null
  const n = body.players
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null
}

/** Confirm an empty count after 15 s, allowing delayed join reports to arrive. Unknown/error counts stay busy. */
export async function waitForIdle(
  players: () => Promise<number | null>,
  options: {
    now?: () => number
    wait?: (ms: number) => Promise<unknown>
    log?: (message: string) => void
    maxMs?: number
  } = {},
): Promise<"idle" | "deadline"> {
  const now = options.now ?? Date.now
  const wait = options.wait ?? Bun.sleep
  const log = options.log ?? console.log
  const deadline = now() + (options.maxMs ?? 30 * 60_000)
  let empty = false
  for (;;) {
    const count = await players().catch(() => null)
    if (count === 0 && empty) return "idle"
    empty = count === 0
    const remaining = deadline - now()
    if (remaining <= 0) return "deadline"
    log(count === null ? "Room count unavailable; waiting before deploy" : `${count} players; waiting before deploy`)
    await wait(Math.min(empty ? 15_000 : 60_000, remaining))
  }
}

async function liveText(url: string): Promise<string | null> {
  try {
    // A unique URL bypasses intermediary caches as well as the browser-style fetch cache.
    const res = await fetch(`${url}?deploy-check=${randomUUID()}`, {
      cache: "no-store", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(10_000),
    })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

export async function deployGame(cwd = process.cwd(), args = process.argv.slice(2)): Promise<void> {
  const game = basename(cwd)
  if (!GAMES.has(game) || basename(resolve(cwd, "..")) !== "games") throw new Error("Run deploy-game.ts from games/<game>")
  for (const arg of args) if (!["--no-build", "--dry", "--if-changed"].includes(arg)) throw new Error(`Unknown argument: ${arg}`)
  const summary = (message: string) => {
    console.log(`${game}: ${message}`)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- **${game}**: ${message}\n`)
  }
  if (!args.includes("--no-build")) {
    rmSync(join(cwd, "dist"), { recursive: true, force: true })
    await $`bun run build`.cwd(cwd)
  }
  const marker = join(cwd, "dist", "arcade", game, "deploy.txt")
  rmSync(marker, { force: true })
  rmSync(join(cwd, WORKER_OUT), { recursive: true, force: true })
  await $`bunx --no-install wrangler deploy --dry-run --outdir=${WORKER_OUT}`.cwd(cwd)
  const stamp = fingerprint(cwd, game)
  writeFileSync(marker, `${stamp}\n`)
  summary(`fingerprint \`${stamp}\``)
  if (args.includes("--dry")) return

  const base = `https://anoma.ly/arcade/${game}`
  const live = (await liveText(`${base}/deploy.txt`))?.trim()
  if (live === stamp) {
    summary("identical to the live deploy; skipped (rooms keep running)")
    return
  }
  if (ROOM_GAMES.has(game)) {
    const result = await waitForIdle(async () => {
      const text = await liveText(`${base}/api/stats`)
      return text === null ? null : playerCount(JSON.parse(text))
    })
    summary(result === "idle" ? "rooms empty; deploying" : "30-minute room wait expired; deploying with rooms possibly occupied")
  }
  await $`bunx --no-install wrangler deploy`.cwd(cwd)
  summary("deployed changed output")
}

if (import.meta.main) await deployGame()
