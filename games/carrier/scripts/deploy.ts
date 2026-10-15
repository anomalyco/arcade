// Builds and deploys carrier. Every deploy restarts the rooms (their Durable Objects), so a game in progress resets:
// with --if-changed (CI) the deploy is skipped when what carrier ships is byte-identical to what is live, so merges
// that only touch other games or unused shared code never reset a game.
//
// The fingerprint is a hash of the built client (dist/) and the Worker bundle (`wrangler deploy --dry-run`), written to
// dist/arcade/carrier/deploy.txt and compared with the live https://anoma.ly/arcade/carrier/deploy.txt.
//
//   bun scripts/deploy.ts               build and deploy
//   bun scripts/deploy.ts --if-changed  build, then deploy only if the fingerprint differs from the live one
//   bun scripts/deploy.ts --dry         build and print the fingerprint, no deploy
import { $ } from "bun"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

const LIVE = "https://anoma.ly/arcade/carrier/deploy.txt"
const STAMP = "dist/arcade/carrier/deploy.txt"
const WORKER_OUT = ".wrangler/deploy-check"

const args = process.argv.slice(2)
const ifChanged = args.includes("--if-changed")
const dry = args.includes("--dry")

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : [p]
  })

await $`bun scripts/build-id.ts`
rmSync("dist", { recursive: true, force: true })
await $`bunx --no-install vite build`
rmSync(WORKER_OUT, { recursive: true, force: true })
await $`bunx --no-install wrangler deploy --dry-run --outdir=${WORKER_OUT}`.quiet()

const hash = createHash("sha256")
for (const root of ["dist", WORKER_OUT]) {
  for (const f of files(root).sort()) {
    // Source maps and wrangler's generated README vary between identical builds.
    if (f.endsWith(".map") || f.endsWith("README.md")) continue
    hash.update(relative(root, f))
    hash.update(readFileSync(f))
  }
}
hash.update(readFileSync("wrangler.jsonc"))
const stamp = hash.digest("hex").slice(0, 16)
writeFileSync(STAMP, `${stamp}\n`)
console.log(`carrier fingerprint ${stamp}`)

if (dry) process.exit(0)
if (ifChanged) {
  const live = await fetch(LIVE, { cache: "no-store" }).then((r) => (r.ok ? r.text() : ""), () => "")
  if (live.trim() === stamp) {
    console.log("carrier: identical to the live deploy, skipped (rooms keep running)")
    process.exit(0)
  }
  console.log(`carrier: live is ${live.trim() || "unknown"}, deploying`)
}
await $`bunx --no-install wrangler deploy`
