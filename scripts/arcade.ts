#!/usr/bin/env bun
// Arcade Dev Control CLI: drives open browser page(s) of the local Arcade dev server using the shared LabCommandRegistry.
// Usage:
//   bun run arcade status [--json]
//   bun run arcade pages [--json]
//   bun run arcade open <page|url> [--new] [--json]
//   bun run arcade cmd list [--json]
//   bun run arcade run <command> [json-args] [--seed <n>] [--json]
//   bun run arcade select <id|name> [--json]
//   bun run arcade camera get|set [--orbit <deg>] [--elevation <deg>] [--distance <m>] [--target x,y,z] [--frame <id>]
//   bun run arcade spawn <asset> [--at <x,z|spot>] [--yaw <deg>] [--shape <one|row|grid>] [--count <n>] [--seed <n>]
//   bun run arcade lab get [path] | lab set <path> <value> | lab preset save [name] [--out <file>] | lab preset load <name|file>
//   bun run arcade env <name> [--seed <n>]
//   bun run arcade transport play|pause|step [frames]|speed <mult>|retrigger [--seed <n>]
//   bun run arcade possess [id|name] | release
//   bun run arcade note "<title>" [--body <text>] [--step <k/n>] [--accent <color>] [--target <target>] [--clear]
//   bun run arcade tour <file.json|name> | tour --json '[...]' [--multi-tab] [--open pro|local|none] [--base-url <url>]
//   bun run arcade tour --add-step <name|file> --title "<title>" [--kind page|scene] [--url <url>] [--body <text>] [--markdown <md>] [--images <files>]
//   bun run arcade screenshot [--out <file.png>] [--max-size <px>|--downscale <px>|--full]
//   bun run arcade state [--json]

import { spawn, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import {
  buildTourStepUrl,
  normalizeNoteArgs,
  normalizeNoteTarget,
  resolveNavigationPath,
  validateTourDefinition,
  type DevPageSummary,
  type TourDefinition,
} from "../packages/kit/dev-control"
import { CONTROL_PATH, DEFAULT_CONTROL_FILENAME, type ControlFilePayload } from "./dev-control-server"

const repoRoot = resolve(import.meta.dirname, "..")

type GlobalFlags = {
  json: boolean
  inlineJson?: string
  page?: string
  controlFile?: string
  url?: string
  token?: string
  timeoutMs: number
  help: boolean
}

function parseGlobalFlags(rawArgv: string[]): { flags: GlobalFlags; rest: string[] } {
  const flags: GlobalFlags = {
    json: false,
    page: process.env.ARCADE_PAGE,
    controlFile: process.env.ARCADE_CONTROL_FILE,
    url: process.env.ARCADE_URL,
    token: process.env.ARCADE_TOKEN,
    timeoutMs: 10000,
    help: false,
  }
  const rest: string[] = []
  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i]!
    if (arg === "--json") {
      const next = rawArgv[i + 1]
      if (next && (next.trim().startsWith("[") || next.trim().startsWith("{")) && rawArgv.includes("tour")) {
        flags.inlineJson = rawArgv[++i]
      } else {
        flags.json = true
      }
    } else if (arg.startsWith("--json=")) {
      flags.inlineJson = arg.slice("--json=".length)
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true
    } else if (arg === "--page" || arg === "-p") {
      flags.page = rawArgv[++i]
    } else if (arg.startsWith("--page=")) {
      flags.page = arg.slice("--page=".length)
    } else if (arg === "--control-file") {
      flags.controlFile = rawArgv[++i]
    } else if (arg.startsWith("--control-file=")) {
      flags.controlFile = arg.slice("--control-file=".length)
    } else if (arg === "--url") {
      flags.url = rawArgv[++i]
    } else if (arg.startsWith("--url=")) {
      flags.url = arg.slice("--url=".length)
    } else if (arg === "--token") {
      flags.token = rawArgv[++i]
    } else if (arg.startsWith("--token=")) {
      flags.token = arg.slice("--token=".length)
    } else if (arg === "--timeout") {
      flags.timeoutMs = Number(rawArgv[++i]) || 10000
    } else {
      rest.push(arg)
    }
  }
  return { flags, rest }
}

function resolveTargetConfig(flags: GlobalFlags): { origin: string; token: string; controlPath: string; sourceFile?: string } {
  if (flags.url && flags.token) {
    return { origin: flags.url.replace(/\/$/, ""), token: flags.token, controlPath: CONTROL_PATH }
  }
  const candidates = flags.controlFile
    ? [resolve(flags.controlFile)]
    : [
        join(process.cwd(), DEFAULT_CONTROL_FILENAME),
        join(repoRoot, DEFAULT_CONTROL_FILENAME),
        join(homedir(), ".cache", "arcade", "dev-control.json"),
      ]

  for (const file of candidates) {
    if (!existsSync(file)) continue
    const st = statSync(file)
    const mode = st.mode & 0o777
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
      throw new CliError(1, "insecure_token_file", `Refusing to read control file ${file} with permissions 0${mode.toString(8)} (expected 0600).`)
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as ControlFilePayload
      if (parsed && typeof parsed.origin === "string" && typeof parsed.token === "string") {
        return {
          origin: flags.url ? flags.url.replace(/\/$/, "") : parsed.origin.replace(/\/$/, ""),
          token: flags.token ?? parsed.token,
          controlPath: parsed.controlPath || CONTROL_PATH,
          sourceFile: file,
        }
      }
    } catch {}
  }

  throw new CliError(
    1,
    "no_control_server",
    `No active Arcade dev control file found (checked ${candidates.join(", ")}). Start the dev server with 'bun run dev'.`,
  )
}

class CliError extends Error {
  constructor(
    public readonly exitCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

function exitCodeForErrorCode(code: string | undefined): number {
  if (code === "no_page_connected" || code === "page_not_found") return 2
  if (code === "unavailable" || code === "busy") return 3
  if (code === "unknown_command" || code === "invalid_args") return 4
  return 1
}

async function fetchStatus(target: { origin: string; token: string; controlPath: string }) {
  let res: Response
  try {
    res = await fetch(`${target.origin}${target.controlPath}/status`, {
      headers: { authorization: `Bearer ${target.token}` },
    })
  } catch (err) {
    throw new CliError(
      1,
      "server_unreachable",
      `Could not connect to Arcade dev server at ${target.origin}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, any>
  if (!res.ok || !body.ok) {
    const code = String(body.code ?? "server_error")
    throw new CliError(exitCodeForErrorCode(code), code, String(body.error ?? `HTTP ${res.status}`))
  }
  return body as {
    ok: true
    server: {
      pid: number
      origin: string
      publicOrigin?: string
      pageHosts?: string[]
      host: string
      port: number
      games: string[]
      workers: boolean
      uptimeMs: number
    }
    connectedPages: number
    activePageId: string | null
    pages: DevPageSummary[]
  }
}

async function invokeRemote(
  target: { origin: string; token: string; controlPath: string },
  flags: GlobalFlags,
  command: string,
  args?: Record<string, unknown>,
) {
  let res: Response
  try {
    res = await fetch(`${target.origin}${target.controlPath}/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.token}`,
      },
      body: JSON.stringify({
        pageId: flags.page,
        command,
        args,
        timeoutMs: flags.timeoutMs,
      }),
    })
  } catch (err) {
    throw new CliError(
      1,
      "server_unreachable",
      `Could not reach Arcade dev server at ${target.origin}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, any>
  if (!res.ok || !body.ok) {
    const code = String(body.code ?? "error")
    throw new CliError(exitCodeForErrorCode(code), code, String(body.error ?? `Command "${command}" failed (HTTP ${res.status})`), {
      command: body.command ?? command,
      page: body.page,
    })
  }
  return body as {
    ok: true
    id: string
    command: string
    label: string
    undoable: boolean
    state: any
    result: any
    page: { id: string; kind: string; url: string; pathname: string; hash: string; title: string; mode: string; section?: string }
  }
}

function parseAutoValue(raw: string): string | number | boolean {
  const trimmed = raw.trim()
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (trimmed !== "" && !Number.isNaN(Number(trimmed)) && Number.isFinite(Number(trimmed))) {
    return Number(trimmed)
  }
  return raw
}

function printHelp() {
  console.log(`Arcade Dev Control CLI — drive open browser pages of the Arcade dev server

Read-only inspection commands:
  arcade status                                Server health & connected browser pages
  arcade pages                                 List connected browser pages
  arcade cmd list                              List commands registered on the active page
  arcade state                                 Scene JSON: actors, selection, camera, settings
  arcade camera get                            Read camera orbit, elevation, distance & target
  arcade lab get [path]                        Read one or all Lab settings & control metadata
  arcade lab preset save [name] [--out <file>] Export current preset JSON (and optionally save)
  arcade screenshot [--out <file>] [--max-size <px>|--full]
                                               Capture page canvas to PNG over the bridge

Mutating commands (show unobtrusive page indicator, respect live user input, record Undo):
  arcade open <page|url> [--new]               Navigate connected page (opens tab ONLY if 0 connected & --new)
  arcade select <id|name>                      Select object, asset, catalog fixture, or section (object.select)
  arcade camera set [--orbit <deg>] [--elevation <deg>] [--distance <m>] [--target x,y,z] [--frame <id>]
  arcade spawn <asset> [--at <x,z|spot>] [--yaw <deg>] [--shape <one|row|grid>] [--count <n>] [--seed <n>]
  arcade lab set <path> <value>                Update a Lab control (scene.set-param)
  arcade lab preset load <name|file|json>      Validate and apply a saved or JSON preset (preset.import)
  arcade env <name> [--seed <n>]               Switch scene environment or lighting setup (scene.set-env)
  arcade transport play|pause|step [n]|speed <mult>|retrigger [--seed <n>]
  arcade possess [id|name]                     Possess character / enter Play mode (mode.play)
  arcade release                               Exit Play mode & release held input (mode.play)
  arcade note "<title>" [--body <text>] [--step <k/n>] [--accent <color>] [--target <target>] [--clear]
                                               Pin a "Show me" card & optional highlight ring on the active page
  arcade tour <file.json|name> [--multi-tab] [--open pro|local|none] [--base-url <url>]
  arcade tour --json '[...]'                   Open a single-tab studio tour (or --multi-tab) and persist in .arcade-tours/
  arcade tour --add-step <tour> --title "<t>"  Append a scene or page step to a tour in .arcade-tours/
  arcade run <command> [json-args] [--seed <n>] Run any command ID from 'arcade cmd list'

Global options:
  --json                 Machine-readable JSON output
  --page <id|kind>       Target a specific connected page (default: focused/visible page)
  --control-file <path>  Path to .arcade-control.json (or ARCADE_CONTROL_FILE)
  --timeout <ms>         RPC timeout in milliseconds (default: 10000)

Exit codes:
  0  Success
  1  Server unreachable or runtime error
  2  No page connected or target page not found
  3  Unavailable in current mode (e.g. Play mode) or blocked by live user input
  4  Unknown command or invalid arguments`)
}

async function main() {
  const { flags, rest } = parseGlobalFlags(process.argv.slice(2))
  if (flags.help || rest.length === 0) {
    printHelp()
    process.exit(0)
  }

  const sub = rest[0]!
  const args = rest.slice(1)

  try {
    const target = resolveTargetConfig(flags)

    if (sub === "status") {
      const status = await fetchStatus(target)
      if (flags.json) {
        console.log(JSON.stringify({ ...status, controlFile: target.sourceFile ?? null }, null, 2))
      } else {
        console.log(`Server: ${status.server.origin} (pid ${status.server.pid}, games: ${status.server.games.join(", ")})`)
        console.log(`Connected pages: ${status.connectedPages}`)
        for (const p of status.pages) {
          const activeMark = p.id === status.activePageId ? "*" : " "
          const stateFlags = [p.focused ? "focused" : null, p.visible ? "visible" : "hidden", p.mode !== "view" ? `mode=${p.mode}` : null, p.section ? `sec=${p.section}` : null].filter(Boolean).join(", ")
          console.log(`  ${activeMark} ${p.id}  [${p.kind}]  ${p.pathname}${p.hash}  (${stateFlags})  ${p.commands.length} cmds`)
        }
      }
      return
    }

    if (sub === "pages") {
      const status = await fetchStatus(target)
      if (flags.json) {
        console.log(JSON.stringify({ ok: true, activePageId: status.activePageId, pages: status.pages }, null, 2))
      } else if (status.pages.length === 0) {
        console.log("No browser pages connected.")
      } else {
        for (const p of status.pages) {
          const activeMark = p.id === status.activePageId ? "*" : " "
          console.log(`${activeMark} ${p.id}\t${p.kind}\t${p.url}\t${p.title}\tfocused=${p.focused} visible=${p.visible} mode=${p.mode}`)
        }
      }
      return
    }

    if (sub === "cmd") {
      const action = args[0] ?? "list"
      if (action !== "list") {
        throw new CliError(4, "invalid_args", `Unknown subcommand "cmd ${action}". Expected: arcade cmd list`)
      }
      const status = await fetchStatus(target)
      if (status.pages.length === 0) {
        throw new CliError(2, "no_page_connected", `No browser page is connected to ${target.origin}.`)
      }
      const page = flags.page
        ? status.pages.find(p => p.id === flags.page || p.kind === flags.page || p.pathname.includes(flags.page!))
        : status.pages[0]
      if (!page) {
        throw new CliError(2, "page_not_found", `No connected page matches "${flags.page}".`)
      }
      if (flags.json) {
        console.log(JSON.stringify({ ok: true, pageId: page.id, kind: page.kind, url: page.url, commands: page.commands }, null, 2))
      } else {
        console.log(`Commands on ${page.id} (${page.kind} · ${page.pathname}${page.hash}):`)
        for (const c of page.commands) {
          const avail = c.available ? "ready" : `disabled: ${c.disabledReason ?? "unavailable"}`
          const undoTag = c.undoable ? "undoable" : "direct"
          const argKeys = c.args ? Object.entries(c.args).map(([k, s]) => `${k}${s.required ? "" : "?"}:${s.type}`).join(", ") : ""
          console.log(`  ${c.id.padEnd(22)} [${c.category}] (${undoTag}, ${avail}) ${argKeys ? `{ ${argKeys} }` : ""} — ${c.label}`)
        }
      }
      return
    }

    if (sub === "open") {
      let allowNew = false
      let dest = ""
      for (const a of args) {
        if (a === "--new") allowNew = true
        else if (!dest) dest = a
      }
      if (!dest) {
        throw new CliError(4, "invalid_args", "Usage: arcade open <page|url> [--new]")
      }
      let resolvedPath: string
      try {
        resolvedPath = resolveNavigationPath(dest)
      } catch (err) {
        throw new CliError(4, "invalid_args", err instanceof Error ? err.message : String(err))
      }

      const status = await fetchStatus(target)
      if (status.pages.length === 0) {
        if (!allowNew) {
          throw new CliError(
            2,
            "no_page_connected",
            `No browser page is connected to ${target.origin}. Pass --new to open a new browser tab, or open ${target.origin}${resolvedPath} first.`,
          )
        }
        const fullUrl = `${target.origin}${resolvedPath}`
        if (process.platform === "darwin") {
          spawn("open", ["-g", fullUrl], { detached: true, stdio: "ignore" }).unref()
        } else {
          spawn("xdg-open", [fullUrl], { detached: true, stdio: "ignore" }).unref()
        }
        const deadline = Date.now() + 8000
        let connected: DevPageSummary | undefined
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 150))
          const poll = await fetchStatus(target)
          if (poll.pages.length > 0) {
            connected = poll.pages[0]
            break
          }
        }
        if (!connected) {
          throw new CliError(2, "no_page_connected", `Opened ${fullUrl}, but no browser tab connected within 8s.`)
        }
        if (flags.json) {
          console.log(JSON.stringify({ ok: true, command: "nav.open", openedNewTab: true, page: connected }, null, 2))
        } else {
          console.log(`Opened ${connected.url} (${connected.id} · ${connected.kind})`)
        }
        return
      }

      const res = await invokeRemote(target, flags, "nav.open", { target: dest })
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2))
      } else {
        console.log(`Navigated ${res.page.id} -> ${res.page.url} [${res.page.kind}]`)
      }
      return
    }

    if (sub === "run") {
      const cmdId = args[0]
      if (!cmdId) {
        throw new CliError(4, "invalid_args", "Usage: arcade run <command> [json-args] [--seed <n>]")
      }
      let parsedArgs: Record<string, unknown> = {}
      for (let i = 1; i < args.length; i++) {
        const token = args[i]!
        if (token === "--seed") {
          parsedArgs.seed = Number(args[++i])
        } else if (token.startsWith("{")) {
          try {
            const obj = JSON.parse(token)
            if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
              throw new Error("Expected JSON object")
            }
            parsedArgs = { ...parsedArgs, ...obj }
          } catch (err) {
            throw new CliError(4, "invalid_args", `Invalid JSON arguments for "${cmdId}": ${err instanceof Error ? err.message : String(err)}`)
          }
        } else {
          throw new CliError(4, "invalid_args", `Unexpected argument "${token}". Pass JSON object as second argument.`)
        }
      }
      const res = await invokeRemote(target, flags, cmdId, parsedArgs)
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2))
      } else {
        console.log(`${res.command}: ${JSON.stringify(res.result)}`)
      }
      return
    }

    if (sub === "select") {
      const selTarget = args.join(" ").trim()
      if (!selTarget) {
        throw new CliError(4, "invalid_args", "Usage: arcade select <id|name>")
      }
      const res = await invokeRemote(target, flags, "object.select", { id: selTarget })
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2))
      } else {
        const s = res.result?.selected
        console.log(`Selected ${s?.id ?? selTarget}${s?.label ? ` (${s.label})` : ""}`)
      }
      return
    }

    if (sub === "camera") {
      const action = args[0] ?? "get"
      if (action === "get") {
        const res = await invokeRemote(target, flags, "camera.get", {})
        if (flags.json) {
          console.log(JSON.stringify(res, null, 2))
        } else {
          const c = res.result
          console.log(`Camera: orbit=${c.orbit}° elevation=${c.elevation}° distance=${c.distance}m target=[${(c.target ?? c.focus ?? []).join(", ")}]`)
        }
        return
      }
      if (action === "set") {
        const camArgs: Record<string, unknown> = {}
        for (let i = 1; i < args.length; i++) {
          const a = args[i]!
          if (a === "--orbit") camArgs.orbit = Number(args[++i])
          else if (a === "--elevation") camArgs.elevation = Number(args[++i])
          else if (a === "--distance") camArgs.distance = Number(args[++i])
          else if (a === "--target") {
            const rawT = String(args[++i] ?? "")
            const nums = rawT.split(",").map(s => Number(s.trim()))
            if (nums.length === 2 && nums.every(Number.isFinite)) {
              camArgs.targetX = nums[0]
              camArgs.targetZ = nums[1]
            } else if (nums.length === 3 && nums.every(Number.isFinite)) {
              camArgs.targetX = nums[0]
              camArgs.targetY = nums[1]
              camArgs.targetZ = nums[2]
            } else {
              throw new CliError(4, "invalid_args", `Invalid --target "${rawT}". Expected x,y,z or x,z.`)
            }
          } else if (a === "--frame") {
            camArgs.frame = String(args[++i] ?? "")
          } else {
            throw new CliError(4, "invalid_args", `Unknown camera set flag "${a}".`)
          }
        }
        const res = await invokeRemote(target, flags, "camera.set", camArgs)
        if (flags.json) {
          console.log(JSON.stringify(res, null, 2))
        } else {
          const c = res.result
          console.log(`Camera set: orbit=${c.orbit}° elevation=${c.elevation}° distance=${c.distance}m target=[${(c.target ?? c.focus ?? []).join(", ")}]`)
        }
        return
      }
      throw new CliError(4, "invalid_args", `Unknown camera subcommand "${action}". Expected: camera get | camera set`)
    }

    if (sub === "spawn") {
      const asset = args[0]
      if (!asset || asset.startsWith("--")) {
        throw new CliError(4, "invalid_args", "Usage: arcade spawn <asset> [--at <x,z|named-spot>] [--yaw <deg>] [--shape <one|row|grid>] [--count <n>] [--seed <n>]")
      }
      const spawnArgs: Record<string, unknown> = { asset }
      for (let i = 1; i < args.length; i++) {
        const a = args[i]!
        if (a === "--at") spawnArgs.at = String(args[++i] ?? "")
        else if (a === "--yaw") spawnArgs.yaw = Number(args[++i])
        else if (a === "--shape") spawnArgs.shape = String(args[++i] ?? "")
        else if (a === "--count") spawnArgs.count = Number(args[++i])
        else if (a === "--seed") spawnArgs.seed = Number(args[++i])
        else throw new CliError(4, "invalid_args", `Unknown spawn flag "${a}".`)
      }
      const res = await invokeRemote(target, flags, "ground.spawn-here", spawnArgs)
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2))
      } else {
        const r = res.result
        console.log(`Spawned ${r.spawned} ${r.id ?? r.kind} (${r.label ?? r.kind}) at (${r.at?.x}, ${r.at?.z})`)
      }
      return
    }

    if (sub === "lab") {
      const action = args[0]
      if (action === "get") {
        const path = args[1]
        const res = await invokeRemote(target, flags, "lab.get", path ? { path } : {})
        if (flags.json) {
          console.log(JSON.stringify(res, null, 2))
        } else if (path) {
          const r = res.result
          console.log(`${r.group ? `${r.group} · ` : ""}${r.label ?? r.key} (${r.key}) = ${r.formatted ?? r.value}`)
        } else {
          for (const [k, v] of Object.entries(res.result?.settings ?? {})) {
            console.log(`  ${k}: ${String(v)}`)
          }
        }
        return
      }
      if (action === "set") {
        const path = args[1]
        const rawVal = args[2]
        if (!path || rawVal === undefined) {
          throw new CliError(4, "invalid_args", "Usage: arcade lab set <path> <value>")
        }
        const res = await invokeRemote(target, flags, "scene.set-param", { key: path, value: parseAutoValue(rawVal) })
        if (flags.json) {
          console.log(JSON.stringify(res, null, 2))
        } else {
          const r = res.result
          console.log(`Set ${r.label ?? r.key} (${r.key}): ${String(r.before)} -> ${r.formatted ?? String(r.value)}`)
        }
        return
      }
      if (action === "preset") {
        const pAction = args[1]
        if (pAction === "save") {
          let name: string | undefined
          let outFile: string | undefined
          for (let i = 2; i < args.length; i++) {
            const a = args[i]!
            if (a === "--out" || a === "-o") outFile = args[++i]
            else if (!name) name = a
          }
          const res = await invokeRemote(target, flags, "preset.export", name ? { name } : {})
          if (outFile) {
            const abs = resolve(outFile)
            mkdirSync(dirname(abs), { recursive: true })
            writeFileSync(abs, res.result.json ?? JSON.stringify(res.result.preset ?? res.result, null, 2))
          }
          if (flags.json) {
            console.log(JSON.stringify({ ...res, outFile: outFile ? resolve(outFile) : null }, null, 2))
          } else {
            console.log(`Saved preset${name ? ` "${name}"` : ""}${outFile ? ` to ${resolve(outFile)}` : ""}`)
            if (!outFile) console.log(res.result.json ?? JSON.stringify(res.result, null, 2))
          }
          return
        }
        if (pAction === "load") {
          const source = args[2]
          if (!source) {
            throw new CliError(4, "invalid_args", "Usage: arcade lab preset load <name|file.json|inline-json>")
          }
          let loadArgs: Record<string, unknown>
          if (source.trim().startsWith("{")) {
            loadArgs = { json: source }
          } else if (existsSync(source)) {
            loadArgs = { json: readFileSync(source, "utf8") }
          } else {
            loadArgs = { name: source }
          }
          const res = await invokeRemote(target, flags, "preset.import", loadArgs)
          if (flags.json) {
            console.log(JSON.stringify(res, null, 2))
          } else {
            console.log(`Loaded preset into section "${res.result.section}"`)
          }
          return
        }
        throw new CliError(4, "invalid_args", "Usage: arcade lab preset save [name] [--out <file>] | arcade lab preset load <name|file>")
      }
      throw new CliError(4, "invalid_args", "Usage: arcade lab get [path] | arcade lab set <path> <value> | arcade lab preset save|load")
    }

    if (sub === "look") {
      const action = args[0]
      if (action === "preset") {
        const preset = args[1]
        if (!preset) throw new CliError(4, "invalid_args", "Usage: arcade look preset <current|noir|painterly|cinematic_dusk|sodium_70s|cozy_golden_hour>")
        const res = await invokeRemote(target, flags, "look.preset", { preset })
        if (flags.json) console.log(JSON.stringify(res, null, 2))
        else console.log(`Look preset: ${res.result.label} (${res.result.preset})`)
        return
      }
      if (action === "set") {
        const key = args[1]
        const rawVal = args[2]
        if (!key || rawVal === undefined) throw new CliError(4, "invalid_args", "Usage: arcade look set <key> <value>")
        const res = await invokeRemote(target, flags, "look.set", { key, value: parseAutoValue(rawVal) })
        if (flags.json) console.log(JSON.stringify(res, null, 2))
        else console.log(`Look set ${res.result.key}: ${String(res.result.before)} -> ${String(res.result.value)}`)
        return
      }
      if (action === "randomize") {
        const rArgs: Record<string, unknown> = {}
        for (let i = 1; i < args.length; i++) {
          const a = args[i]!
          if (a === "--seed") rArgs.seed = Number(args[++i])
          else if (!a.startsWith("-") && !rArgs.group) rArgs.group = a
        }
        const res = await invokeRemote(target, flags, "look.randomize", rArgs)
        if (flags.json) console.log(JSON.stringify(res, null, 2))
        else console.log(`Look randomized (${res.result.group}, tuningSeed=${res.result.tuningSeed}, roomSeed=${res.result.roomSeed})`)
        return
      }
      throw new CliError(4, "invalid_args", "Usage: arcade look preset <id> | arcade look set <key> <value> | arcade look randomize [group] [--seed <n>]")
    }

    if (sub === "env") {
      const name = args[0]
      if (!name || name.startsWith("--")) {
        throw new CliError(4, "invalid_args", "Usage: arcade env <name> [--seed <n>]")
      }
      const envArgs: Record<string, unknown> = { name }
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--seed") envArgs.seed = Number(args[++i])
      }
      const res = await invokeRemote(target, flags, "scene.set-env", envArgs)
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2))
      } else {
        console.log(`Environment: ${res.result.label ?? res.result.environment}${res.result.seed !== undefined ? ` (seed ${res.result.seed})` : ""}`)
      }
      return
    }

    if (sub === "transport") {
      const action = args[0]
      if (action === "play" || action === "pause") {
        const res = await invokeRemote(target, flags, "transport.toggle", { action })
        if (flags.json) console.log(JSON.stringify(res, null, 2))
        else console.log(`Transport ${action === "play" ? "playing" : "paused"} (f${res.result.frames} · ${res.result.elapsed}s)`)
        return
      }
      if (action === "step") {
        const count = args[1] !== undefined ? Number(args[1]) : 1
        const res = await invokeRemote(target, flags, "transport.step", { frames: count })
        if (flags.json) console.log(JSON.stringify(res, null, 2))
        else console.log(`Stepped +${res.result.stepped} frame(s) -> f${res.result.frames} (${res.result.elapsed}s)`)
        return
      }
      if (action === "speed") {
        const mult = Number(args[1])
        if (!Number.isFinite(mult)) {
          throw new CliError(4, "invalid_args", "Usage: arcade transport speed <multiplier>")
        }
        const res = await invokeRemote(target, flags, "transport.speed", { speed: mult })
        if (flags.json) console.log(JSON.stringify(res, null, 2))
        else console.log(`Transport speed: ${res.result.speed}×`)
        return
      }
      if (action === "retrigger") {
        const rtArgs: Record<string, unknown> = {}
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--seed") rtArgs.seed = Number(args[++i])
        }
        const res = await invokeRemote(target, flags, "ground.trigger-here", rtArgs)
        if (flags.json) console.log(JSON.stringify(res, null, 2))
        else console.log("Transport retriggered (f0 · 0.00s)")
        return
      }
      throw new CliError(4, "invalid_args", "Usage: arcade transport play | pause | step [frames] | speed <multiplier> | retrigger [--seed <n>]")
    }

    if (sub === "possess") {
      const charTarget = args[0]
      const res = await invokeRemote(target, flags, "mode.play", { mode: "play", ...(charTarget ? { target: charTarget } : {}) })
      if (flags.json) console.log(JSON.stringify(res, null, 2))
      else console.log(`Possessing ${res.result.characterLabel ?? res.result.characterId ?? "character"} (mode=${res.result.mode})`)
      return
    }

    if (sub === "release") {
      const res = await invokeRemote(target, flags, "mode.play", { mode: "edit" })
      if (flags.json) console.log(JSON.stringify(res, null, 2))
      else console.log(`Released character -> mode=${res.result.mode}`)
      return
    }

    if (sub === "note") {
      let clear = false
      let title = ""
      let body: string | undefined
      let step: string | undefined
      let accent: string | undefined
      let rawTarget: unknown
      let dismissible = true

      for (let i = 0; i < args.length; i++) {
        const a = args[i]!
        if (a === "--clear" || a === "--dismiss" || a === "clear" || a === "dismiss") {
          clear = true
        } else if (a === "--body" || a === "-b") {
          body = String(args[++i] ?? "")
        } else if (a.startsWith("--body=")) {
          body = a.slice("--body=".length)
        } else if (a === "--step" || a === "-s") {
          step = String(args[++i] ?? "")
        } else if (a.startsWith("--step=")) {
          step = a.slice("--step=".length)
        } else if (a === "--accent" || a === "-a") {
          accent = String(args[++i] ?? "")
        } else if (a.startsWith("--accent=")) {
          accent = a.slice("--accent=".length)
        } else if (a === "--target" || a === "-t") {
          rawTarget = String(args[++i] ?? "")
        } else if (a.startsWith("--target=")) {
          rawTarget = a.slice("--target=".length)
        } else if (a === "--object") {
          rawTarget = { objectId: String(args[++i] ?? "") }
        } else if (a === "--setting" || a === "--key") {
          rawTarget = { setting: String(args[++i] ?? "") }
        } else if (a === "--rect") {
          rawTarget = `rect:${String(args[++i] ?? "")}`
        } else if (a === "--world" || a === "--point") {
          rawTarget = `world:${String(args[++i] ?? "")}`
        } else if (a === "--selector") {
          rawTarget = { selector: String(args[++i] ?? "") }
        } else if (a === "--no-dismiss") {
          dismissible = false
        } else if (a.startsWith("-")) {
          throw new CliError(4, "invalid_args", `Unknown note flag "${a}".`)
        } else if (!title) {
          title = a
        } else if (!body) {
          body = a
        } else {
          throw new CliError(4, "invalid_args", `Unexpected note argument "${a}".`)
        }
      }

      let noteArgs: Record<string, unknown>
      try {
        if (clear) {
          noteArgs = { clear: true }
        } else {
          const targetObj = rawTarget !== undefined ? normalizeNoteTarget(rawTarget) : undefined
          const validated = normalizeNoteArgs({
            title,
            ...(body !== undefined ? { body } : {}),
            ...(step !== undefined ? { step } : {}),
            ...(accent !== undefined ? { accent } : {}),
            ...(targetObj !== undefined ? { target: targetObj } : {}),
            dismissible,
          })
          noteArgs = validated.clear ? { clear: true } : (validated.note as unknown as Record<string, unknown>)
        }
      } catch (err) {
        throw new CliError(4, "invalid_args", err instanceof Error ? err.message : String(err))
      }

      const res = await invokeRemote(target, flags, "ui.note", noteArgs)
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2))
      } else if (clear) {
        console.log(`Cleared note on ${res.page.id} (${res.page.title})`)
      } else {
        console.log(`Pinned note on ${res.page.id}: ${res.result.documentTitle}${res.result.body ? ` — ${res.result.body}` : ""}`)
      }
      return
    }

    if (sub === "tour") {
      const toursDir = join(repoRoot, ".arcade-tours")
      if (args[0] === "list") {
        mkdirSync(toursDir, { recursive: true })
        const files = readdirSync(toursDir).filter(f => f.endsWith(".json")).sort()
        if (flags.json) {
          console.log(JSON.stringify({ ok: true, directory: toursDir, tours: files.map(f => f.replace(/\.json$/, "")) }, null, 2))
        } else if (files.length === 0) {
          console.log("No saved tours in .arcade-tours/.")
        } else {
          for (const f of files) console.log(`  ${f.replace(/\.json$/, "")}\t(${join(toursDir, f)})`)
        }
        return
      }

      let singleTabOverride: boolean | undefined
      let openMode: string | undefined
      let baseUrl: string | undefined
      let tourIdOverride: string | undefined
      let inlineJson = flags.inlineJson
      let sourceArg: string | undefined
      let addStepMode = false
      let stepTitle: string | undefined
      let stepBody: string | undefined
      let stepKind: "scene" | "page" | undefined
      let stepUrl: string | undefined
      let stepMarkdown: string | undefined
      let stepImages: string[] | undefined
      let stepSetupRaw: string | undefined
      let stepTargetRaw: string | undefined
      let stepAccent: string | undefined

      for (let i = 0; i < args.length; i++) {
        const a = args[i]!
        if (a === "--single-tab") {
          singleTabOverride = true
        } else if (a === "--multi-tab") {
          singleTabOverride = false
        } else if (a === "--no-open" || a === "--dry-run") {
          openMode = "none"
        } else if (a === "--open") {
          openMode = String(args[++i] ?? "")
        } else if (a.startsWith("--open=")) {
          openMode = a.slice("--open=".length)
        } else if (a === "--base-url") {
          baseUrl = String(args[++i] ?? "")
        } else if (a.startsWith("--base-url=")) {
          baseUrl = a.slice("--base-url=".length)
        } else if (a === "--id") {
          tourIdOverride = String(args[++i] ?? "")
        } else if (a.startsWith("--id=")) {
          tourIdOverride = a.slice("--id=".length)
        } else if (a === "--add-step") {
          addStepMode = true
          if (args[i + 1] && !args[i + 1]!.startsWith("-") && !sourceArg) {
            sourceArg = args[++i]
          }
        } else if (a === "--title") {
          stepTitle = String(args[++i] ?? "")
        } else if (a.startsWith("--title=")) {
          stepTitle = a.slice("--title=".length)
        } else if (a === "--body") {
          stepBody = String(args[++i] ?? "")
        } else if (a.startsWith("--body=")) {
          stepBody = a.slice("--body=".length)
        } else if (a === "--kind") {
          const k = String(args[++i] ?? "").toLowerCase()
          if (k !== "scene" && k !== "page") throw new CliError(4, "invalid_args", `Invalid --kind "${k}". Expected "scene" or "page".`)
          stepKind = k
        } else if (a === "--step-url") {
          stepUrl = String(args[++i] ?? "")
        } else if (a === "--markdown") {
          stepMarkdown = String(args[++i] ?? "")
        } else if (a === "--images") {
          stepImages = String(args[++i] ?? "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean)
        } else if (a === "--setup") {
          stepSetupRaw = String(args[++i] ?? "")
        } else if (a === "--target") {
          stepTargetRaw = String(args[++i] ?? "")
        } else if (a === "--accent") {
          stepAccent = String(args[++i] ?? "")
        } else if (a.startsWith("-")) {
          throw new CliError(4, "invalid_args", `Unknown tour flag "${a}".`)
        } else if (!sourceArg) {
          sourceArg = a
        } else {
          throw new CliError(4, "invalid_args", `Unexpected tour argument "${a}".`)
        }
      }

      let rawTourData: unknown
      if (addStepMode) {
        const tourId = (tourIdOverride || sourceArg || "tour").replace(/\.json$/, "")
        if (!stepTitle?.trim()) {
          throw new CliError(4, "invalid_args", "arcade tour --add-step requires --title \"<title>\".")
        }
        const existingFile = [resolve(sourceArg ?? ""), join(toursDir, `${tourId}.json`)].find(p => existsSync(p) && statSync(p).isFile())
        let existingTour: { id: string; title?: string; singleTab?: boolean; steps: unknown[] } = {
          id: tourId,
          singleTab: true,
          steps: [],
        }
        if (existingFile) {
          try {
            const parsed = JSON.parse(readFileSync(existingFile, "utf8"))
            if (parsed && typeof parsed === "object" && Array.isArray(parsed.steps)) {
              existingTour = parsed
            }
          } catch {}
        }
        const newStep: Record<string, unknown> = {
          title: stepTitle.trim(),
          ...(stepKind ? { kind: stepKind } : {}),
          ...(stepBody ? { body: stepBody } : {}),
          ...(stepUrl ? { url: stepUrl } : {}),
          ...(stepMarkdown ? { markdown: stepMarkdown } : {}),
          ...(stepImages?.length ? { images: stepImages } : {}),
          ...(stepSetupRaw ? { setup: JSON.parse(stepSetupRaw) } : {}),
          ...(stepTargetRaw ? { target: stepTargetRaw } : {}),
          ...(stepAccent ? { accent: stepAccent } : {}),
        }
        rawTourData = {
          ...existingTour,
          steps: [...existingTour.steps, newStep],
        }
        sourceArg = undefined
        if (!openMode) openMode = "none"
      }

      if (!inlineJson && sourceArg && (sourceArg.trim().startsWith("[") || sourceArg.trim().startsWith("{"))) {
        inlineJson = sourceArg
        sourceArg = undefined
      }

      let defaultId = tourIdOverride || "tour"
      if (rawTourData !== undefined) {
        defaultId = (rawTourData as { id?: string }).id || defaultId
      } else if (inlineJson) {
        try {
          rawTourData = JSON.parse(inlineJson)
        } catch (err) {
          throw new CliError(4, "invalid_args", `Invalid tour --json payload: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else if (sourceArg) {
        const candidatePaths = [
          resolve(sourceArg),
          join(toursDir, sourceArg),
          join(toursDir, `${sourceArg}.json`),
        ]
        const foundFile = candidatePaths.find(p => existsSync(p) && statSync(p).isFile())
        if (!foundFile) {
          throw new CliError(4, "invalid_args", `Tour file not found: "${sourceArg}" (also checked ${join(toursDir, `${sourceArg}.json`)}).`)
        }
        if (!tourIdOverride) {
          defaultId = basename(foundFile, ".json")
        }
        try {
          rawTourData = JSON.parse(readFileSync(foundFile, "utf8"))
        } catch (err) {
          throw new CliError(4, "invalid_args", `Failed to parse tour JSON ${foundFile}: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else {
        throw new CliError(4, "invalid_args", "Usage: arcade tour <file.json|name> | arcade tour --json '[...]' [--multi-tab] [--open pro|local|none]")
      }

      let validated: TourDefinition
      try {
        validated = validateTourDefinition(rawTourData, defaultId)
        if (tourIdOverride) {
          validated.id = tourIdOverride.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || validated.id
        }
      } catch (err) {
        throw new CliError(4, "invalid_args", err instanceof Error ? err.message : String(err))
      }

      // Copy any referenced local image files into .arcade-tours/assets/<id>/ and normalize their src to the basename
      const assetsDir = join(toursDir, "assets", validated.id)
      const cacheAssetsDir = join(homedir(), ".cache", "arcade", "tour-assets", validated.id)
      for (const step of validated.steps) {
        if (!step.images?.length) continue
        mkdirSync(assetsDir, { recursive: true })
        mkdirSync(cacheAssetsDir, { recursive: true })
        for (const img of step.images) {
          const expanded = img.src.startsWith("~/") ? join(homedir(), img.src.slice(2)) : img.src
          const localCandidates = [
            resolve(expanded),
            join(assetsDir, basename(expanded)),
            join(homedir(), "code", "home", "artifacts", "2026-10-14-outbreak-review", basename(expanded)),
          ]
          const existingAsset = localCandidates.find(p => existsSync(p) && statSync(p).isFile())
          if (existingAsset) {
            const base = basename(existingAsset)
            const dstLocal = join(assetsDir, base)
            const dstCache = join(cacheAssetsDir, base)
            if (resolve(existingAsset) !== resolve(dstLocal)) {
              try {
                copyFileSync(existingAsset, dstLocal)
              } catch {}
            }
            if (resolve(existingAsset) !== resolve(dstCache)) {
              try {
                copyFileSync(existingAsset, dstCache)
              } catch {}
            }
            if (!img.src.startsWith("http") && !img.src.startsWith("/")) {
              img.src = base
            }
          }
        }
      }

      // Persist in .arcade-tours/<id>.json for replay (without baking transient CLI --base-url / --multi-tab overrides)
      mkdirSync(toursDir, { recursive: true })
      const savedFile = join(toursDir, `${validated.id}.json`)
      writeFileSync(savedFile, JSON.stringify(validated, null, 2) + "\n", "utf8")

      const runtimeSingleTab = singleTabOverride !== undefined ? singleTabOverride : validated.singleTab !== false
      const runtimeBaseUrl = baseUrl ? baseUrl.replace(/\/$/, "") : validated.baseUrl

      // Register tour on the dev control server
      let statusInfo: Awaited<ReturnType<typeof fetchStatus>> | null = null
      let serverStepUrls: { step: number; title: string; body: string | null; url: string; localUrl: string }[] | null = null
      try {
        statusInfo = await fetchStatus(target)
        const postRes = await fetch(`${target.origin}${target.controlPath}/tour`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${target.token}`,
          },
          body: JSON.stringify({
            tour: validated,
            id: validated.id,
            singleTab: runtimeSingleTab,
            ...(runtimeBaseUrl ? { baseUrl: runtimeBaseUrl } : {}),
          }),
        })
        const postBody = (await postRes.json().catch(() => ({}))) as Record<string, any>
        if (postRes.ok && postBody.ok && Array.isArray(postBody.stepUrls)) {
          serverStepUrls = postBody.stepUrls
        }
      } catch (err) {
        if (err instanceof CliError) throw err
        throw new CliError(1, "server_unreachable", `Could not register tour on ${target.origin}: ${err instanceof Error ? err.message : String(err)}`)
      }

      const resolvedOpener = (openMode ?? process.env.ARCADE_OPEN ?? "local").trim()
      const effectiveOrigin =
        runtimeBaseUrl ||
        process.env.ARCADE_PUBLIC_URL?.replace(/\/$/, "") ||
        (resolvedOpener === "pro" && statusInfo?.server.publicOrigin ? statusInfo.server.publicOrigin : target.origin)

      const stepUrls = validated.steps.map((s, idx) => ({
        step: idx + 1,
        title: s.title,
        body: s.body ?? null,
        url: buildTourStepUrl(effectiveOrigin, s.url, validated.id, idx + 1, runtimeSingleTab),
      }))
      void serverStepUrls

      const urlsToOpen = runtimeSingleTab ? [stepUrls[0]!.url] : stepUrls.map(s => s.url)
      if (resolvedOpener !== "none") {
        if (resolvedOpener === "pro") {
          const remoteCmd = urlsToOpen.map(u => `open ${JSON.stringify(u)}`).join("; sleep 0.12; ")
          const res = spawnSync("ssh", ["pro", remoteCmd], { stdio: "pipe", timeout: 15000 })
          if (res.status !== 0) {
            const stderr = res.stderr?.toString("utf8").trim() || `exit ${res.status}`
            throw new CliError(1, "open_failed", `Failed to open tour tabs on 'pro' via ssh: ${stderr}`)
          }
        } else if (resolvedOpener === "local") {
          for (const u of urlsToOpen) {
            if (process.platform === "darwin") {
              spawn("open", [u], { detached: true, stdio: "ignore" }).unref()
            } else {
              spawn("xdg-open", [u], { detached: true, stdio: "ignore" }).unref()
            }
            if (urlsToOpen.length > 1) {
              await new Promise(r => setTimeout(r, 90))
            }
          }
        } else {
          for (const u of urlsToOpen) {
            spawn("sh", ["-c", `${resolvedOpener} "$1"`, "--", u], { detached: true, stdio: "ignore" }).unref()
          }
        }
      }

      const payload = {
        ok: true,
        id: validated.id,
        title: validated.title ?? validated.id,
        savedFile,
        opener: resolvedOpener,
        singleTab: runtimeSingleTab,
        openedTabs: resolvedOpener === "none" ? 0 : urlsToOpen.length,
        steps: stepUrls,
      }
      if (flags.json || (flags.inlineJson && process.argv.filter(a => a === "--json").length > 1)) {
        console.log(JSON.stringify(payload, null, 2))
      } else {
        console.log(`Tour "${validated.id}" (${stepUrls.length} steps) saved to ${savedFile}`)
        console.log(`Opener: ${resolvedOpener} (${payload.openedTabs} tab${payload.openedTabs === 1 ? "" : "s"} opened)`)
        for (const s of stepUrls) {
          console.log(`  [${s.step}/${stepUrls.length}] ▸ ${s.title} -> ${s.url}`)
        }
      }
      return
    }

    if (sub === "screenshot") {
      let outPath: string | undefined
      let maxSize = 1280
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!
        if (a === "--out" || a === "-o") outPath = args[++i]
        else if (a === "--max-size" || a === "--downscale") maxSize = Number(args[++i])
        else if (a === "--full") maxSize = 0
        else if (!a.startsWith("-") && !outPath) outPath = a
      }
      const res = await invokeRemote(target, flags, "screenshot", { maxSize })
      const dataUrl = String(res.result?.dataUrl ?? "")
      const prefix = "data:image/png;base64,"
      if (!dataUrl.startsWith(prefix)) {
        throw new CliError(1, "screenshot_error", "Page did not return a valid PNG dataUrl.")
      }
      const pngBuffer = Buffer.from(dataUrl.slice(prefix.length), "base64")
      const resolvedOut = resolve(outPath ?? join(tmpdir(), `arcade-screenshot-${Date.now()}.png`))
      mkdirSync(dirname(resolvedOut), { recursive: true })
      writeFileSync(resolvedOut, pngBuffer)
      const payload = {
        ok: true,
        path: resolvedOut,
        bytes: pngBuffer.byteLength,
        width: res.result.width,
        height: res.result.height,
        sourceWidth: res.result.sourceWidth,
        sourceHeight: res.result.sourceHeight,
        page: res.page,
      }
      if (flags.json) {
        console.log(JSON.stringify(payload, null, 2))
      } else {
        console.log(`Saved screenshot: ${resolvedOut} (${payload.width}×${payload.height}, ${payload.bytes} bytes)`)
      }
      return
    }

    if (sub === "state") {
      const res = await invokeRemote(target, flags, "state", {})
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2))
      } else {
        console.log(JSON.stringify(res.result, null, 2))
      }
      return
    }

    throw new CliError(4, "unknown_command", `Unknown arcade subcommand "${sub}". Run 'arcade --help' for usage.`)
  } catch (err) {
    if (err instanceof CliError) {
      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              ok: false,
              code: err.code,
              error: err.message,
              ...(err.details ?? {}),
            },
            null,
            2,
          ),
        )
      } else {
        console.error(`Error [${err.code}]: ${err.message}`)
      }
      process.exit(err.exitCode)
    }
    const message = err instanceof Error ? err.message : String(err)
    if (flags.json) {
      console.log(JSON.stringify({ ok: false, code: "error", error: message }, null, 2))
    } else {
      console.error(`Error: ${message}`)
    }
    process.exit(1)
  }
}

void main()
