// Run the existing CI check script, substituting only its Bun test commands.
import { $ } from "bun"
import { join, resolve } from "node:path"

const runner = $.escape(join(import.meta.dir, "test-changed.ts"))
export function expandCheck(scripts: Record<string, string>, name: string): string[] {
  return scripts[name]!.split("&&").flatMap(part => {
    const cmd = part.trim()
    const run = cmd.match(/^bun run ([\w:-]+)$/)
    return run && scripts[run[1]!] ? expandCheck(scripts, run[1]!) : [cmd]
  })
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const script = args[0]?.startsWith("check:") ? args.shift()! : "check"
  for (const dir of args.length ? args : ["."]) {
    const cwd = resolve(dir)
    const { scripts } = await Bun.file(join(cwd, "package.json")).json()
    const command = expandCheck(scripts, script).map(cmd => cmd.replace(/^bun test\b/, `bun ${runner}`)).join(" && ")
    const child = Bun.spawn(["bash", "-c", command], {
      cwd, env: { ...process.env, PATH: `${join(cwd, "node_modules/.bin")}:${join(import.meta.dir, "../node_modules/.bin")}:${process.env.PATH}` },
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    })
    const code = await child.exited
    if (code) process.exit(code)
  }
}
