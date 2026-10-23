// One compiler per project, bounded to the HiveMind allocation (two threads outside HiveMind).
export function typecheckThreads(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.HIVEMIND_CPUS ?? "2")
  if (!Number.isFinite(value) || value <= 0) throw new Error("HIVEMIND_CPUS must be a positive finite number")
  return Math.max(1, Math.floor(value))
}

if (import.meta.main) {
  const [major, minor, patch] = Bun.version.split(".").map(Number)
  if (major! < 1 || (major === 1 && (minor! < 4 || (minor === 4 && patch! < 3)))) {
    throw new Error("Typechecking requires Bun >=1.4.3; this repository pins Bun 1.4.4")
  }
  const child = Bun.spawn([
    process.execPath, "check", "--no-script", "--no-pretty", "--all",
    "--threads", String(typecheckThreads()), ...process.argv.slice(2),
  ], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  process.exit(await child.exited)
}
