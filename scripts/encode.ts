import { mkdirSync } from "node:fs"
import { dirname, join, relative } from "node:path"

/** Capture against host loopback; send encoding and image composition through the fleet. */
export async function encode(args: string[]): Promise<void> {
  // Set only inside a fleet job, so assembly can run there without recursively scheduling encoding.
  if (process.env.ARCADE_ENCODE_LOCAL === "1") {
    const proc = Bun.spawn(["bun", import.meta.path, ...args], { stdout: "inherit", stderr: "inherit" })
    if (await proc.exited !== 0) throw new Error(`Encoding failed: ${args.at(-1)}`)
    return
  }
  const root = join(import.meta.dir, "..")
  const rel = args.map((arg) => arg.startsWith(root + "/") ? relative(root, arg) : arg)
  const out = rel.at(-1)!
  const proc = Bun.spawn(["hivemind", "run", "--kind", "render", "--fetch", out, "--", "bun", "scripts/encode.ts", ...rel], { cwd: root, stdout: "inherit", stderr: "inherit" })
  if (await proc.exited !== 0) throw new Error(`Encoding failed: ${out}`)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  mkdirSync(dirname(args.at(-1)!), { recursive: true })
  const proc = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", ...args], { stdout: "inherit", stderr: "inherit" })
  process.exit(await proc.exited)
}
