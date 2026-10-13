// Single-origin developer router: every workspace game at its production path on one local URL.
//   bun run dev              games, Sandbox and Catalogue from this checkout
//   bun run dev --workers    also start each game's Worker on first /api or /ws request
// Launch through Nexus from the repository root: nexus run <name> -- bun run dev
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { createServer as createHttpServer, request, type IncomingMessage, type ServerResponse } from "node:http"
import { connect, createServer as createNetServer } from "node:net"
import { join, resolve } from "node:path"
import { createServer as createViteServer, type Plugin, type ViteDevServer } from "vite"
import { devRoute, hubPath } from "../packages/kit/dev-hub-model"

const root = resolve(import.meta.dirname, "..")
const workspaces: string[] = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces
const games = workspaces.filter(path => path.startsWith("games/")).map(path => path.slice("games/".length))
const workers = process.argv.includes("--workers")
const port = Number(process.env.PORT) || 5180, host = process.env.HOST || "127.0.0.1"

const server = createHttpServer((req, res) => { void handle(req, res) })
const vites = new Map<string, Promise<ViteDevServer>>(), ready = new Set<string>()
const workerPorts = new Map<string, Promise<number>>(), children: ChildProcess[] = []

function routerMeta(): Plugin {
  const content = JSON.stringify({ games, workers })
  return { name: "arcade-dev-router", transformIndexHtml: () => [{ tag: "meta", attrs: { name: "arcade-dev-router", content }, injectTo: "head-prepend" }] }
}

function mount(game: string) {
  let vite = vites.get(game)
  if (!vite) {
    const dir = join(root, "games", game)
    // Same preparation as each game's own dev script: the generated protocol hash.
    if (existsSync(join(dir, "scripts/build-id.ts"))) execFileSync("bun", ["scripts/build-id.ts"], { cwd: dir, stdio: "inherit" })
    vite = createViteServer({
      root: dir,
      configFile: join(dir, "vite.config.ts"),
      base: `/arcade/${game}/`,
      cacheDir: join(dir, "node_modules/.vite-hub"),
      clearScreen: false,
      plugins: [routerMeta()],
      server: { middlewareMode: true, ws: { server } },
    }).then(instance => { ready.add(game); return instance })
    vites.set(game, vite)
    vite.catch(() => vites.delete(game))
  }
  return vite
}

function freePort() {
  return new Promise<number>((done, fail) => {
    const probe = createNetServer().once("error", fail)
    probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => typeof address === "object" && address ? done(address.port) : fail(new Error("No port"))) })
  })
}

async function waitForPort(target: number, child: ChildProcess) {
  for (const started = Date.now(); Date.now() - started < 60_000;) {
    if (child.exitCode !== null) throw new Error(`Worker exited with ${child.exitCode}`)
    if (await new Promise<boolean>(done => { const socket = connect(target, "127.0.0.1", () => { socket.end(); done(true) }).once("error", () => done(false)) })) return
    await new Promise(done => setTimeout(done, 250))
  }
  throw new Error("Worker did not start within 60 s")
}

function worker(game: string) {
  let started = workerPorts.get(game)
  if (!started) {
    started = (async () => {
      const [listen, inspector] = [await freePort(), await freePort()]
      mkdirSync(join(root, "games", game, "dist"), { recursive: true }) // Wrangler's assets directory; Vite serves the client.
      const child = spawn("bunx", ["--no-install", "wrangler", "dev", "--ip", "127.0.0.1", "--port", String(listen), "--inspector-port", String(inspector), "--show-interactive-dev-session=false"], { cwd: join(root, "games", game), stdio: ["ignore", "pipe", "pipe"] })
      children.push(child)
      for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => { for (const line of chunk.toString().split("\n")) if (line.trim()) console.log(`[${game} worker] ${line}`) })
      child.once("exit", () => workerPorts.delete(game))
      await waitForPort(listen, child)
      return listen
    })()
    workerPorts.set(game, started)
    started.catch(() => workerPorts.delete(game))
  }
  return started
}

function text(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(body)
}

const workerOff = (game: string) => JSON.stringify({ error: `The ${game} Worker is off. Restart with: bun run dev --workers` })

async function handle(req: IncomingMessage, res: ServerResponse) {
  const target = devRoute(req.url ?? "/", games)
  try {
    if (target.kind === "redirect") return void res.writeHead(302, { location: target.location }).end()
    if (target.kind === "missing") return text(res, 404, `Not found. Local games: ${games.map(game => `/arcade/${game}/`).join(" ")}`)
    if (target.kind === "worker") {
      if (!workers) return text(res, 503, workerOff(target.game), "application/json")
      const listen = await worker(target.game)
      const upstream = request({ host: "127.0.0.1", port: listen, method: req.method, path: req.url, headers: req.headers }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res)
      })
      upstream.once("error", error => { if (!res.headersSent) text(res, 502, String(error)); else res.destroy() })
      return void req.pipe(upstream)
    }
    const vite = await mount(target.game)
    req.url = target.path // Plugin middlewares (audio assets, Carrier feedback) expect root-relative paths.
    vite.middlewares(req, res, () => text(res, 404, "Not found"))
  } catch (error) {
    if (!res.headersSent) text(res, 500, error instanceof Error ? error.stack ?? error.message : String(error))
  }
}

server.on("upgrade", (req, socket, head) => {
  const protocol = String(req.headers["sec-websocket-protocol"] ?? "")
  const target = devRoute(req.url ?? "/", games)
  if (protocol === "vite-hmr" || protocol === "vite-ping") {
    // Each mounted Vite accepts its own base. A client reconnecting before its game is mounted retries its ping.
    if (target.kind === "vite" && !ready.has(target.game)) { void mount(target.game).catch(() => {}); socket.destroy() }
    return
  }
  if (target.kind !== "worker") return void socket.destroy()
  if (!workers) return void socket.end(`HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${workerOff(target.game)}`)
  worker(target.game).then(listen => {
    const upstream = connect(listen, "127.0.0.1", () => {
      const headers = req.rawHeaders.flatMap((value, index) => index % 2 ? [] : [`${value}: ${req.rawHeaders[index + 1]}`])
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`)
      if (head.length) upstream.write(head)
      upstream.pipe(socket).pipe(upstream)
    })
    upstream.once("error", () => socket.destroy()); socket.once("error", () => upstream.destroy())
  }, () => socket.destroy())
})

async function stop() {
  for (const child of children) child.kill()
  await Promise.allSettled([...vites.values()].map(async vite => (await vite).close()))
  server.close(); process.exit(0)
}

process.once("SIGINT", stop); process.once("SIGTERM", stop)
server.listen(port, host, () => {
  console.log(`Arcade dev: http://${host}:${port}${hubPath}`)
  console.log(`Games: ${games.map(game => `/arcade/${game}/`).join(" ")}${workers ? " · Workers on demand" : " · Workers off (--workers)"}`)
})
