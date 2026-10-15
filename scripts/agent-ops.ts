// Operator CLI for Arcade agent coordination, guardrails, durable reports, watchdog checks, and board hygiene.
//
// Subcommands:
//   bun scripts/agent-ops.ts state [--base <ref>] [--head <ref>] [--from-ref <ref>] [--require-deploys-on] [--prune-retired] [--json]
//   bun scripts/agent-ops.ts report write --session <ses_...> [--card <AR-n>] [--pr <n>] [--title <t>] [--file <path> | --text <md>]
//   bun scripts/agent-ops.ts report read <ses_...>
//   bun scripts/agent-ops.ts report recover [--parent <ses_...>] [--hours <n>]
//   bun scripts/agent-ops.ts msg <ses_...> <message> [--force] [--dry-run]
//   bun scripts/agent-ops.ts watchdog [--parent <ses_...>] [--hours <n>] [--json]
//   bun scripts/agent-ops.ts gallery-link <capture-dir> <slug> [--port <n>]
//   bun scripts/agent-ops.ts board-hygiene [--hours <n>] [--json]
import { Database } from "bun:sqlite"
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export type AgentState = {
  deploys: "on" | "off"
  allowed_base: string
  retired_branches: string[]
  browser_proofs_default: "on" | "off"
  preview_worktree: string
  preview_hub_port: number
}

const repo = resolve(import.meta.dir, "..")
const statePath = resolve(repo, "docs/agent-state.md")
const defaultDbPath = join(homedir(), ".local/share/opencode-studio-migration/opencode.db")
const reportsDir = join(homedir(), "code/home/artifacts/agent-reports")
const boardCliPath = join(homedir(), "code/home/tools/arcade-board/board.ts")

export function parseAgentState(markdown: string): AgentState {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) throw new Error("docs/agent-state.md is missing YAML frontmatter")
  const raw = Bun.YAML.parse(match[1]) as Record<string, unknown>
  const deploys =
    raw.deploys === true || raw.deploys === "on"
      ? "on"
      : raw.deploys === false || raw.deploys === "off"
        ? "off"
        : undefined
  if (!deploys) throw new Error(`docs/agent-state.md: invalid deploys value ${JSON.stringify(raw.deploys)}`)
  const allowed_base = typeof raw.allowed_base === "string" && raw.allowed_base.trim() ? raw.allowed_base.trim() : ""
  if (!allowed_base) throw new Error("docs/agent-state.md: missing allowed_base")
  const retired_branches = Array.isArray(raw.retired_branches)
    ? raw.retired_branches.map((b) => String(b).trim()).filter(Boolean)
    : []
  const browser_proofs_default =
    raw.browser_proofs_default === true || raw.browser_proofs_default === "on" ? "on" : "off"
  const preview_worktree =
    typeof raw.preview_worktree === "string" ? raw.preview_worktree : "/Users/kit/worktrees/arcade/release-4"
  const preview_hub_port = typeof raw.preview_hub_port === "number" ? raw.preview_hub_port : 5187
  return {
    deploys,
    allowed_base,
    retired_branches,
    browser_proofs_default,
    preview_worktree,
    preview_hub_port,
  }
}

export function loadAgentState(fromRef?: string): AgentState {
  if (fromRef) {
    const shown = Bun.spawnSync(["git", "-C", repo, "show", `${fromRef}:docs/agent-state.md`])
    if (shown.exitCode === 0) return parseAgentState(shown.stdout.toString())
  }
  return parseAgentState(readFileSync(statePath, "utf8"))
}

// ---- SQLite session inspection ------------------------------------------------------------------------------

type SessionInspect = {
  id: string
  parent_id: string | null
  title: string
  directory: string
  time_created: number
  time_updated: number
  msg_count: number
  user_msgs: number
  busy: boolean
  last_role: string | null
  last_error: string | null
  last_model: string | null
  last_assistant_len: number
  last_assistant_text: string
  max_assistant_len: number
  max_assistant_text: string
  overwrite_victim: boolean
  stalled_mid_turn: boolean
  silent_error_exit: boolean
}

function inspectSession(db: Database, row: {
  id: string
  parent_id: string | null
  title: string
  directory: string
  time_created: number
  time_updated: number
}): SessionInspect {
  const msgs = db
    .query("SELECT type, data, time_created FROM session_message WHERE session_id = ? ORDER BY seq ASC")
    .all(row.id) as { type: string; data: string; time_created: number }[]

  let user_msgs = 0
  let last_role: string | null = null
  let last_error: string | null = null
  let last_model: string | null = null
  let last_assistant_len = 0
  let last_assistant_text = ""
  let max_assistant_len = 0
  let max_assistant_text = ""
  let total_tool_calls = 0

  for (const m of msgs) {
    last_role = m.type
    const parsed = JSON.parse(m.data) as {
      model?: { id?: string }
      content?: { type?: string; text?: string }[]
      outcome?: string
      error?: { type?: string; message?: string }
    }
    if (m.type === "user") {
      user_msgs++
      last_error = null
    } else if (m.type === "assistant") {
      last_model = parsed.model?.id ?? last_model
      const content = parsed.content ?? []
      const text = content
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")
        .trim()
      const tools = content.filter((p) => p.type === "tool" || p.type === "tool-call").length
      total_tool_calls += tools
      last_assistant_len = text.length
      last_assistant_text = text
      if (text.length >= max_assistant_len) {
        max_assistant_len = text.length
        max_assistant_text = text
      }
    } else if (m.type === "idle") {
      if (parsed.outcome === "failed" || parsed.error) {
        last_error = parsed.error ? `${parsed.error.type ?? "error"}: ${parsed.error.message ?? ""}` : "idle_failed"
      }
    }
  }

  const ageMs = Date.now() - row.time_updated
  const incompleteTurn = msgs.length > 0 && last_role !== "idle"
  const busy = incompleteTurn && ageMs < 10 * 60 * 1000
  const stalled_mid_turn = incompleteTurn && ageMs >= 10 * 60 * 1000
  const silent_error_exit =
    Boolean(last_error) || (msgs.length > 0 && last_role === "idle" && max_assistant_len === 0 && total_tool_calls === 0)
  const overwrite_victim = user_msgs > 1 && max_assistant_len >= 500 && last_assistant_len > 0 && last_assistant_len < 350

  return {
    ...row,
    msg_count: msgs.length,
    user_msgs,
    busy,
    last_role,
    last_error,
    last_model,
    last_assistant_len,
    last_assistant_text,
    max_assistant_len,
    max_assistant_text,
    overwrite_victim,
    stalled_mid_turn,
    silent_error_exit,
  }
}

// ---- Subcommands --------------------------------------------------------------------------------------------

function cmdState(argv: string[]) {
  const flag = (name: string) => argv.includes(name)
  const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)

  const state = loadAgentState(option("--from-ref"))
  if (flag("--json")) {
    console.log(JSON.stringify(state, null, 2))
    return
  }

  const errors: string[] = []
  const base = (option("--base") ?? process.env.GITHUB_BASE_REF ?? "").replace(/^refs\/heads\//, "").replace(/^origin\//, "")
  const head = (option("--head") ?? process.env.GITHUB_HEAD_REF ?? "").replace(/^refs\/heads\//, "").replace(/^origin\//, "")

  if (base) {
    if (state.retired_branches.includes(base)) {
      errors.push(
        `PR target branch '${base}' is retired (retired_branches: ${state.retired_branches.join(", ")}). Retarget to '${state.allowed_base}': gh pr edit --base ${state.allowed_base}`,
      )
    } else if (base !== state.allowed_base) {
      errors.push(
        `PR target branch '${base}' does not match allowed_base '${state.allowed_base}' in docs/agent-state.md. Retarget with: gh pr edit --base ${state.allowed_base}`,
      )
    }
  }

  if (head && state.retired_branches.includes(head)) {
    errors.push(`Branch '${head}' is listed in retired_branches (${state.retired_branches.join(", ")}) and must not be recreated.`)
  }

  if (flag("--require-deploys-on") && state.deploys !== "on") {
    errors.push(
      `deploys is '${state.deploys}' in docs/agent-state.md (allowed_base: ${state.allowed_base}). Do not deploy or merge to main until deploys is 'on'.`,
    )
  }

  const remotes = Bun.spawnSync(["git", "-C", repo, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"]).stdout
    .toString()
    .split("\n")
    .map((r) => r.trim().replace(/^origin\//, ""))
    .filter(Boolean)
  const lingering = state.retired_branches.filter((b) => remotes.includes(b))

  if (lingering.length > 0 && flag("--prune-retired")) {
    const del = Bun.spawnSync(["git", "-C", repo, "push", "origin", "--delete", ...lingering])
    if (del.exitCode === 0) {
      console.log(`Deleted retired remote branches on origin: ${lingering.join(", ")}`)
    } else {
      errors.push(`Failed to delete retired remote branches (${lingering.join(", ")}): ${del.stderr.toString().trim()}`)
    }
  } else if (lingering.length > 0) {
    console.warn(
      `Warning: retired branches present in local origin refs: ${lingering.join(", ")} (run 'git fetch --prune origin' or 'bun scripts/agent-ops.ts state --prune-retired')`,
    )
  }

  console.log(
    `agent-state: deploys=${state.deploys} allowed_base=${state.allowed_base} browser_proofs_default=${state.browser_proofs_default} retired=[${state.retired_branches.join(", ")}]`,
  )

  if (errors.length > 0) {
    for (const err of errors) console.error(`ERROR: ${err}`)
    process.exit(1)
  }
}

function cmdReport(argv: string[]) {
  const sub = argv[0] ?? "help"
  const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
  mkdirSync(reportsDir, { recursive: true })

  if (sub === "write") {
    const session = option("--session") ?? process.env.OPENCODE_SESSION_ID ?? "manual"
    const card = option("--card")
    const pr = option("--pr")
    const title = option("--title") ?? session
    const file = option("--file")
    const textArg = option("--text")
    const body = file ? readFileSync(resolve(file), "utf8") : (textArg ?? "")
    if (!body.trim()) throw new Error("report write: provide --file <path> or --text <markdown>")

    const outPath = join(reportsDir, `${session}.md`)
    const header = [
      "---",
      `session: ${session}`,
      ...(card ? [`card: ${card}`] : []),
      ...(pr ? [`pr: ${pr}`] : []),
      `title: ${JSON.stringify(title)}`,
      `written_at: ${new Date().toISOString()}`,
      "---",
      "",
    ].join("\n")
    writeFileSync(outPath, header + body.trim() + "\n")
    console.log(`Wrote persistent report: ${outPath}`)
    return
  }

  if (sub === "read") {
    const session = argv[1]
    if (!session) throw new Error("Usage: bun scripts/agent-ops.ts report read <ses_...>")
    const filePath = join(reportsDir, `${session}.md`)
    if (existsSync(filePath)) {
      console.log(readFileSync(filePath, "utf8"))
      return
    }
    if (!existsSync(defaultDbPath)) throw new Error(`No report file at ${filePath} and no opencode.db at ${defaultDbPath}`)
    const db = new Database(defaultDbPath, { readonly: true })
    const row = db
      .query("SELECT id, parent_id, title, directory, time_created, time_updated FROM session_v2 WHERE id = ?")
      .get(session) as { id: string; parent_id: string | null; title: string; directory: string; time_created: number; time_updated: number } | null
    if (!row) throw new Error(`Session ${session} not found in opencode.db`)
    const info = inspectSession(db, row)
    console.log(`# ${info.title} (${info.id})\n`)
    console.log(info.max_assistant_text || info.last_assistant_text || "(no assistant text)")
    return
  }

  if (sub === "recover") {
    const hours = Number(option("--hours") ?? "36")
    const parent = option("--parent")
    const since = Date.now() - hours * 3600 * 1000
    const db = new Database(defaultDbPath, { readonly: true })
    const rows = (
      parent
        ? db
            .query(
              "SELECT id, parent_id, title, directory, time_created, time_updated FROM session_v2 WHERE parent_id = ? AND time_created >= ? ORDER BY time_created DESC",
            )
            .all(parent, since)
        : db
            .query(
              "SELECT id, parent_id, title, directory, time_created, time_updated FROM session_v2 WHERE time_created >= ? AND (directory LIKE '%arcade%' OR title LIKE '%AR-%' OR title LIKE '%Outbreak%' OR title LIKE '%Blackout%' OR title LIKE '%Getaway%' OR title LIKE '%Lab%') ORDER BY time_created DESC",
            )
            .all(since)
    ) as { id: string; parent_id: string | null; title: string; directory: string; time_created: number; time_updated: number }[]

    let recovered = 0
    for (const r of rows) {
      const info = inspectSession(db, r)
      if (!info.overwrite_victim) continue
      const outPath = join(reportsDir, `${info.id}.md`)
      const doc = [
        "---",
        `session: ${info.id}`,
        `parent_session: ${info.parent_id ?? ""}`,
        `title: ${JSON.stringify(info.title)}`,
        `recovered_at: ${new Date().toISOString()}`,
        `max_assistant_chars: ${info.max_assistant_len}`,
        `final_ack_chars: ${info.last_assistant_len}`,
        "---",
        "",
        `# Recovered Report: ${info.title}`,
        "",
        info.max_assistant_text,
        "",
        "---",
        `### Overwriting final ack (${info.last_assistant_len} chars)`,
        "",
        info.last_assistant_text,
        "",
      ].join("\n")
      writeFileSync(outPath, doc)
      recovered++
      console.log(`Recovered ${info.id} (${info.max_assistant_len} chars -> ${info.last_assistant_len} chars): ${info.title}`)
    }
    console.log(`Recovered ${recovered} overwritten session report(s) into ${reportsDir}`)
    return
  }

  throw new Error(`Unknown report subcommand '${sub}'. Use: write | read | recover`)
}

function cmdMsg(argv: string[]) {
  const flag = (name: string) => argv.includes(name)
  const positional = argv.filter((a) => !a.startsWith("--"))
  const sessionId = positional[0]
  const text = positional.slice(1).join(" ").trim()
  if (!sessionId || !text) {
    throw new Error("Usage: bun scripts/agent-ops.ts msg <ses_...> <message> [--force] [--dry-run]")
  }

  const db = new Database(defaultDbPath, { readonly: true })
  const row = db
    .query("SELECT id, parent_id, title, directory, time_created, time_updated FROM session_v2 WHERE id = ?")
    .get(sessionId) as { id: string; parent_id: string | null; title: string; directory: string; time_created: number; time_updated: number } | null
  if (!row) throw new Error(`Session ${sessionId} not found in ${defaultDbPath}`)

  const info = inspectSession(db, row)
  if (info.last_error) {
    console.warn(`WARNING: ${sessionId} ("${info.title}") ended its last turn with error: ${info.last_error}`)
    console.warn(`Check its worktree (${info.directory}) before sending follow-up instructions.`)
  }
  if (info.busy && !flag("--force")) {
    console.error(
      `REFUSED: ${sessionId} ("${info.title}") is currently mid-turn (last_role=${info.last_role}, updated ${Math.round((Date.now() - info.time_updated) / 1000)}s ago).`,
    )
    console.error(
      `Sending a message while a subagent is busy queues a follow-up turn that overwrites its <subagent> completion summary (27.2% loss rate in audit).`,
    )
    console.error(`Wait for the session to finish its turn, or pass --force if you intentionally want to queue a steer.`)
    process.exit(2)
  }

  if (flag("--dry-run")) {
    console.log(`OK (dry-run): ${sessionId} ("${info.title}") is idle (last_role=${info.last_role}, max_report=${info.max_assistant_len} chars). Safe to message.`)
    return
  }

  // Save the session's current best report before sending a follow-up turn so it can never be lost.
  if (info.max_assistant_len >= 400) {
    mkdirSync(reportsDir, { recursive: true })
    const backupPath = join(reportsDir, `${sessionId}.md`)
    if (!existsSync(backupPath)) {
      writeFileSync(
        backupPath,
        `---\nsession: ${sessionId}\ntitle: ${JSON.stringify(info.title)}\nbacked_up_before_msg_at: ${new Date().toISOString()}\n---\n\n${info.max_assistant_text}\n`,
      )
      console.log(`Backed up existing report (${info.max_assistant_len} chars) to ${backupPath}`)
    }
  }

  const serverUrl = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096"
  const res = Bun.spawnSync([
    "curl",
    "-sS",
    "-X",
    "POST",
    `${serverUrl}/session/${sessionId}/prompt_async`,
    "-H",
    "content-type: application/json",
    "-d",
    JSON.stringify({ parts: [{ type: "text", text }] }),
  ])
  if (res.exitCode !== 0) {
    throw new Error(`Failed to send prompt_async to ${serverUrl}: ${res.stderr.toString().trim()}`)
  }
  console.log(`Sent message to idle session ${sessionId} ("${info.title}").`)
}

function cmdWatchdog(argv: string[]) {
  const flag = (name: string) => argv.includes(name)
  const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
  const hours = Number(option("--hours") ?? "24")
  const parent = option("--parent")
  const since = Date.now() - hours * 3600 * 1000

  const db = new Database(defaultDbPath, { readonly: true })
  const rows = (
    parent
      ? db
          .query(
            "SELECT id, parent_id, title, directory, time_created, time_updated FROM session_v2 WHERE parent_id = ? AND time_created >= ? ORDER BY time_updated DESC",
          )
          .all(parent, since)
      : db
          .query(
            "SELECT id, parent_id, title, directory, time_created, time_updated FROM session_v2 WHERE time_created >= ? AND (directory LIKE '%arcade%' OR title LIKE '%AR-%' OR title LIKE '%Outbreak%' OR title LIKE '%Blackout%' OR title LIKE '%Getaway%' OR title LIKE '%Lab%') ORDER BY time_updated DESC",
          )
          .all(since)
  ) as { id: string; parent_id: string | null; title: string; directory: string; time_created: number; time_updated: number }[]

  const inspected = rows.map((r) => inspectSession(db, r))
  const active = inspected.filter((s) => s.busy)
  const stalled = inspected.filter((s) => s.stalled_mid_turn)
  const errored = inspected.filter((s) => s.silent_error_exit)
  const overwritten = inspected.filter((s) => s.overwrite_victim)

  // Check worktree collisions among sessions updated in the last 30 minutes.
  const recentWindow = Date.now() - 30 * 60 * 1000
  const byDir = new Map<string, SessionInspect[]>()
  for (const s of inspected.filter((x) => x.time_updated >= recentWindow)) {
    const list = byDir.get(s.directory) ?? []
    list.push(s)
    byDir.set(s.directory, list)
  }
  const collisions = [...byDir.entries()]
    .filter(([dir, list]) => list.length > 1 && !dir.endsWith("/code/arcade"))
    .map(([directory, sessions]) => ({
      directory,
      sessions: sessions.map((s) => ({ id: s.id, title: s.title, busy: s.busy })),
    }))

  // Check preview worktree state.
  const state = loadAgentState()
  let previewStatus = { path: state.preview_worktree, ok: true, detail: "clean and on main" }
  if (existsSync(state.preview_worktree)) {
    const branch = Bun.spawnSync(["git", "-C", state.preview_worktree, "rev-parse", "--abbrev-ref", "HEAD"]).stdout.toString().trim()
    const head = Bun.spawnSync(["git", "-C", state.preview_worktree, "rev-parse", "--short", "HEAD"]).stdout.toString().trim()
    const dirty = Bun.spawnSync(["git", "-C", state.preview_worktree, "status", "--porcelain", "--untracked-files=no"]).stdout.toString().trim()
    if (branch !== "main" || dirty) {
      previewStatus = {
        path: state.preview_worktree,
        ok: false,
        detail: `branch=${branch} (${head}), dirty=${dirty ? "yes" : "no"}`,
      }
    } else {
      previewStatus = { path: state.preview_worktree, ok: true, detail: `branch=${branch} (${head}), clean` }
    }
  }

  const summary = {
    window_hours: hours,
    total_sessions: inspected.length,
    active_busy: active.map((s) => ({ id: s.id, title: s.title, directory: s.directory })),
    stalled_mid_turn: stalled.map((s) => ({
      id: s.id,
      title: s.title,
      model: s.last_model,
      idle_min: Math.round((Date.now() - s.time_updated) / 60000),
    })),
    silent_error_exits: errored.map((s) => ({
      id: s.id,
      title: s.title,
      model: s.last_model,
      error: s.last_error ?? "empty_0_char_turn",
    })),
    overwritten_reports: overwritten.map((s) => ({
      id: s.id,
      title: s.title,
      report_chars: s.max_assistant_len,
      final_ack_chars: s.last_assistant_len,
      saved_on_disk: existsSync(join(reportsDir, `${s.id}.md`)),
    })),
    worktree_collisions_30m: collisions,
    preview_worktree: previewStatus,
  }

  if (flag("--json")) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }

  console.log(`watchdog (${hours}h): ${inspected.length} sessions | ${active.length} busy | ${stalled.length} stalled | ${errored.length} errored | ${overwritten.length} overwritten reports`)
  if (stalled.length > 0) {
    console.log("\nStalled mid-turn (>10m with no completion):")
    for (const s of summary.stalled_mid_turn) console.log(`  - ${s.id} [${s.model}] (${s.idle_min}m idle): ${s.title}`)
  }
  if (errored.length > 0) {
    console.log("\nSilent error / empty exits:")
    for (const s of summary.silent_error_exits) console.log(`  - ${s.id} [${s.model}] (${s.error}): ${s.title}`)
  }
  if (overwritten.length > 0) {
    const unsaved = summary.overwritten_reports.filter((s) => !s.saved_on_disk)
    console.log(`\nOverwritten completion reports (${overwritten.length} total, ${unsaved.length} unsaved on disk):`)
    for (const s of summary.overwritten_reports.slice(0, 10)) {
      console.log(`  - ${s.id} (${s.report_chars} chars -> ${s.final_ack_chars} chars, saved=${s.saved_on_disk}): ${s.title}`)
    }
    if (unsaved.length > 0) console.log(`  Run: bun scripts/agent-ops.ts report recover --hours ${hours}`)
  }
  if (collisions.length > 0) {
    console.log("\nWorktree collisions (last 30m):")
    for (const c of collisions) {
      console.log(`  - ${c.directory}: ${c.sessions.map((s) => `${s.id} (${s.title})`).join(", ")}`)
    }
  }
  console.log(`\nPreview worktree (${previewStatus.path}): ${previewStatus.ok ? "OK" : "DRIFT"} — ${previewStatus.detail}`)
}

async function cmdGalleryLink(argv: string[]) {
  const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
  const positional = argv.filter((a) => !a.startsWith("--"))
  const sourceArg = positional[0]
  const slug = positional[1]
  if (!sourceArg || !slug) {
    throw new Error("Usage: bun scripts/agent-ops.ts gallery-link <capture-dir> <slug> [--port 5187]")
  }

  const state = loadAgentState()
  const port = Number(option("--port") ?? String(state.preview_hub_port))
  const sourceDir = resolve(sourceArg)
  if (!existsSync(sourceDir)) throw new Error(`Capture directory does not exist: ${sourceDir}`)

  const targetDir = join(state.preview_worktree, "captures", slug)
  mkdirSync(dirname(targetDir), { recursive: true })
  try {
    const st = lstatSync(targetDir)
    if (st.isSymbolicLink() || st.isFile()) unlinkSync(targetDir)
  } catch {
    // targetDir does not exist yet
  }
  if (!existsSync(targetDir)) {
    symlinkSync(sourceDir, targetDir)
  }

  const entryFile = existsSync(join(sourceDir, "compare.html"))
    ? "compare.html"
    : existsSync(join(sourceDir, "index.html"))
      ? "index.html"
      : ""
  const relUrl = `/captures/${slug}${entryFile ? `/${entryFile}` : "/"}`
  const localUrl = `http://127.0.0.1:${port}${relUrl}`
  const publicUrl = `https://arcade.lwoyjcaeyxv6.opentunnel.xyz${relUrl}`

  const res = await fetch(localUrl).catch(() => null)
  if (!res || !res.ok) {
    throw new Error(`Gallery link preflight failed (${res ? res.status : "connection refused"}): ${localUrl} (target: ${targetDir} -> ${sourceDir})`)
  }
  console.log(`Verified HTTP ${res.status}: ${publicUrl}`)
}

function cmdBoardHygiene(argv: string[]) {
  const flag = (name: string) => argv.includes(name)
  const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
  const hours = Number(option("--hours") ?? "48")
  const sinceMs = Date.now() - hours * 3600 * 1000

  const boardRaw = Bun.spawnSync(["bun", boardCliPath, "snapshot-json", "--project", "arcade"]).stdout.toString()
  const parsedSnap = JSON.parse(boardRaw) as {
    board?: {
      features: {
        id: string
        title: string
        status: string
        archivedAt?: number | null
        plan?: string
        activity?: { text?: string }[]
        attachments?: { title?: string; url?: string }[]
      }[]
      decisions: {
        id: string
        n: number
        feature?: string | null
        title?: string | null
        question?: string
        status: string
        chosen?: string | null
        votes?: { person: string; option: string; at: number }[]
        selections?: { person: string; options?: string[]; option?: string }[]
      }[]
      reviews: {
        id: string
        n: number
        feature?: string | null
        title: string
        status: string
      }[]
      items?: {
        id: string
        kind: string
        feature?: string | null
        decision?: number | null
        review?: number | null
        sentAt?: number | null
        handledAt?: number | null
      }[]
    }
  }
  const board = parsedSnap.board ?? (parsedSnap as unknown as NonNullable<typeof parsedSnap.board>)

  const prsRaw = Bun.spawnSync([
    "gh",
    "pr",
    "list",
    "--repo",
    "anomalyco/arcade",
    "--state",
    "merged",
    "--limit",
    "150",
    "--json",
    "number,title,headRefName,baseRefName,mergedAt,mergeCommit",
  ]).stdout.toString()
  const prs = (JSON.parse(prsRaw) as {
    number: number
    title: string
    headRefName: string
    baseRefName: string
    mergedAt: string
    mergeCommit?: { oid?: string }
  }[]).filter((p) => p.baseRefName === "main" && Date.parse(p.mergedAt) >= sinceMs)

  const openCards = board.features.filter((f) => !f.archivedAt && f.status !== "done")
  const staleCards: { id: string; title: string; status: string; matches: string[] }[] = []

  for (const card of openCards) {
    const text = [
      card.title,
      card.plan ?? "",
      ...(card.activity ?? []).map((a) => a.text ?? ""),
      ...(card.attachments ?? []).map((a) => `${a.title ?? ""} ${a.url ?? ""}`),
    ].join("\n")

    const matches: string[] = []
    for (const pr of prs) {
      const sha7 = pr.mergeCommit?.oid?.slice(0, 7)
      const mentionsPr = new RegExp(`(#|PR\\s*|pull/)${pr.number}\\b`, "i").test(text) || pr.title.includes(card.id)
      const mentionsBranch = pr.headRefName.length > 4 && new RegExp(`\`${pr.headRefName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``).test(text)
      const mentionsSha = Boolean(sha7 && text.includes(sha7))
      if (mentionsPr || mentionsBranch || mentionsSha) {
        matches.push(`#${pr.number} (${pr.headRefName}${sha7 ? ` ${sha7}` : ""}): ${pr.title}`)
      }
    }
    if (matches.length > 0) {
      staleCards.push({ id: card.id, title: card.title, status: card.status, matches })
    }
  }

  const unsentDecisions = board.decisions
    .filter((d) => d.status === "open" || d.status === "decided")
    .flatMap((d) => {
      const starred = (d.selections ?? []).flatMap((s) => s.options ?? (s.option ? [s.option] : []))
      const votes = (d.votes ?? []).map((v) => v.option)
      const pendingItems = (board.items ?? []).filter(
        (i) => i.decision === d.n && (!i.sentAt || !i.handledAt),
      )
      if ((d.status === "open" && starred.length > 0) || pendingItems.length > 0) {
        return [
          {
            id: d.id,
            status: d.status,
            title: d.title ?? d.question ?? d.id,
            starred,
            chosen: d.chosen ?? votes[0] ?? null,
            pendingItems: pendingItems.map((i) => `${i.id} (sent=${Boolean(i.sentAt)}, handled=${Boolean(i.handledAt)})`),
          },
        ]
      }
      return []
    })

  const waitingReviews = (board.reviews ?? [])
    .filter((r) => r.status === "waiting" || r.status === "changes")
    .map((r) => ({ id: r.id, status: r.status, feature: r.feature ?? null, title: r.title }))

  const out = { staleCards, unsentDecisions, waitingReviews }
  if (flag("--json")) {
    console.log(JSON.stringify(out, null, 2))
    return
  }

  console.log(
    `board-hygiene (${hours}h): ${staleCards.length} open card(s) with merged main PRs | ${unsentDecisions.length} decision(s) with unsent/unhandled ★ picks | ${waitingReviews.length} waiting/changes review(s)`,
  )
  for (const c of staleCards) {
    console.log(`  - ${c.id} [${c.status}] "${c.title}" -> ${c.matches.join("; ")}`)
  }
  for (const d of unsentDecisions) {
    console.log(
      `  - ${d.id} [${d.status}] "${d.title}" -> starred=${d.starred.join(",") || "none"} chosen=${d.chosen ?? "none"} items=[${d.pendingItems.join(", ")}]`,
    )
  }
  for (const r of waitingReviews) {
    console.log(`  - ${r.id} [${r.status}] "${r.title}" (feature=${r.feature ?? "none"})`)
  }
}

// ---- Main ---------------------------------------------------------------------------------------------------

if (import.meta.main) {
  const [sub, ...rest] = process.argv.slice(2)
  switch (sub) {
    case "state":
      cmdState(rest)
      break
    case "report":
      cmdReport(rest)
      break
    case "msg":
      cmdMsg(rest)
      break
    case "watchdog":
      cmdWatchdog(rest)
      break
    case "gallery-link":
      await cmdGalleryLink(rest)
      break
    case "board-hygiene":
      cmdBoardHygiene(rest)
      break
    default:
      console.log(
        [
          "Usage: bun scripts/agent-ops.ts <subcommand> [options]",
          "  state          Validate docs/agent-state.md, PR base/head, deploy switch, and retired branches",
          "  report         Write, read, or recover durable subagent reports in ~/code/home/artifacts/agent-reports/",
          "  msg            Safely message a session (refuses if mid-turn unless --force; backs up report first)",
          "  watchdog       Detect stalled mid-turn sessions, silent errors, overwritten reports, and worktree collisions",
          "  gallery-link   Symlink a capture folder into the :5187 preview worktree and verify HTTP 200",
          "  board-hygiene  Find open AR-n cards whose PRs merged to main and open D-n/R-n items with unsent ★ picks",
        ].join("\n"),
      )
      if (sub && sub !== "--help" && sub !== "-h" && sub !== "help") process.exit(1)
  }
}
