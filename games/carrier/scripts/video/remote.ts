// Runs a video script on hailmary (Mac Studio, Metal) from a consistent snapshot of this tree, never the live dev server:
//
//   bun scripts/video/remote.ts <script> [script args...] [--fetch=file,file] [--to=local dir]
//   bun scripts/video/remote.ts scripts/video-epic-fast.ts --preview --fetch=epic.mp4 --to=captures/video
//
// 1. rsyncs games/carrier and packages/kit (sources only) to ~/.cache/carrier-video/fast/arcade on hailmary
//    (--frozen: only scripts/, keeping the last build, for A/B runs against a reference rendered from it);
// 2. there, installs dependencies if missing and rebuilds dist/ only when the build inputs changed (hash in dist);
// 3. runs the script with --out=~/.cache/carrier-video/fast/out;
// 4. copies the --fetch files from that out dir back to --to (default video-out/).
// One ssh connection at a time (hailmary's sshd rejects bursts); refused connections are retried after a pause.
import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const HOST = process.env.VIDEO_HOST ?? "hailmary"
const REMOTE = "~/.cache/carrier-video/fast"
const root = resolve(import.meta.dir, "../..")
const arcade = resolve(root, "../..")
const argv = process.argv.slice(2)
const own = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const fetch = (own("fetch") ?? "").split(",").filter(Boolean)
const to = resolve(root, own("to") ?? "video-out")
// --frozen: sync only scripts/ and keep the existing build (A/B runs against a reference rendered from that build).
const frozen = argv.includes("--frozen")
const passthrough = argv.filter((a) => !a.startsWith("--fetch=") && !a.startsWith("--to=") && a !== "--frozen")
const script = passthrough.shift()
if (!script) throw new Error("usage: remote.ts <script> [args]")
const control = process.env.VIDEO_SSH_CONTROL ?? "/tmp/opencode/ssh-hm"
const sshOpts = ["-o", "ControlMaster=no", "-o", `ControlPath=${control}`, "-o", "ConnectTimeout=20"]

function retry(cmd: string, args: string[], label: string): void {
  for (let i = 0; ; i++) {
    const r = spawnSync(cmd, args, { stdio: "inherit" })
    if (r.status === 0) return
    // 255: ssh could not connect; rsync reports 12/255 for a dropped transport.
    if (![255, 12].includes(r.status ?? 0) || i >= 10) throw new Error(`${label} failed (${r.status})`)
    console.log(`${label}: connection refused, retrying in 60 s`)
    spawnSync("sleep", ["60"])
  }
}

const t0 = performance.now()
// The arcade layout is kept (games/carrier imports packages/kit by relative path); only sources are copied.
const skip = ["node_modules", "dist", "captures", "concept", "feedback", ".wrangler", "video-out", "shots", "tests"].flatMap((e) => ["--exclude", `/games/carrier/${e}`])
const filter = ["--exclude", "node_modules", ...skip, "--include", "/games/", "--include", "/games/carrier/***", "--include", "/packages/", "--include", "/packages/kit/***", "--exclude", "*"]
if (frozen) retry("rsync", ["-az", "--delete", "-e", `ssh ${sshOpts.join(" ")}`, `${root}/scripts/`, `${HOST}:${REMOTE}/arcade/games/carrier/scripts/`], "rsync")
else retry("rsync", ["-az", "--delete", ...filter, "-e", `ssh ${sshOpts.join(" ")}`, `${arcade}/`, `${HOST}:${REMOTE}/arcade/`], "rsync")
console.log(`synced in ${((performance.now() - t0) / 1000).toFixed(1)} s`)

const inputs = "src shared public art index.html flight.html weapons.html gunnery.html boat.html ship.html menu.html vite.config.ts package.json"
const remote = `set -e
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
cd ${REMOTE}/arcade/games/carrier
[ -d node_modules/vite ] || bun install
${frozen ? "if false; then" : "if true; then"}
bun scripts/build-id.ts >/dev/null
h=$(find ${inputs} -type f -not -name build.gen.ts 2>/dev/null | sort | xargs shasum | shasum | cut -c1-16)
if [ "$(cat dist/.srchash 2>/dev/null)" != "$h" ]; then
  t=$(date +%s); bun --bun ./node_modules/.bin/vite build --logLevel error; echo "$h" > dist/.srchash; echo "built in $(( $(date +%s) - t )) s"
fi
fi
mkdir -p ${REMOTE}/out
bun ${JSON.stringify(script)} --out=${REMOTE}/out ${passthrough.map((a) => JSON.stringify(a)).join(" ")}`
retry("ssh", [...sshOpts, HOST, remote], "run")

if (fetch.length) {
  mkdirSync(to, { recursive: true })
  retry("rsync", ["-a", "-e", `ssh ${sshOpts.join(" ")}`, ...fetch.map((f) => `${HOST}:${REMOTE}/out/${f}`), `${to}/`], "fetch")
  console.log(`fetched ${fetch.join(", ")} -> ${join(to)}`)
}
console.log(`total ${((performance.now() - t0) / 1000).toFixed(1)} s`)
