// Audit copy of scripts/doors-check.ts against the frozen build ($AH_BASE) with `--unlock <ids>`. Headless doors check: drives the real player with physical-key presses (KeyE, KeyW) on the Metal adapter.
//
//   bun scripts/doors-check.ts                 # self-test: injects a throwaway door + wall into a terrain-only page
//   bun scripts/doors-check.ts --all           # every registered door: doorway audit, then E + walk through both ways
//   bun scripts/doors-check.ts --all --q "only=terrain,compound" --view gate
//   bun scripts/doors-check.ts --all --only fire-escape,roof   # only doors whose id starts with one of these
//   bun scripts/doors-check.ts --all --only s3: --at -20,11.6,0 --q "only=terrain,interior" --view corridor
//
// The self-test door exists only inside this script's page; nothing is added to the game. Expects the dev server on
// :5196. Exits 1 on any failure.
import { chromium, type Page } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"
import { BASE } from "./lib"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const all = args.includes("--all")
const only = flag("only")?.split(",").filter(Boolean)
/** `--only` entries are id prefixes; a trailing `$` makes one exact (`s0:0-39$` but not `s0:0-39K2`). */
const wanted = (id: string) => !only || only.some((p) => (p.endsWith("$") ? id === p.slice(0, -1) || id === `${p.slice(0, -1)}:b` : id.startsWith(p)))
const extra = flag("q") ?? (all ? "" : "only=terrain")
const view = flag("view") ?? "lot"
const shot = flag("shot")
/** `--at x,y,z`: teleport the player there first (interior storeys build their doors as the player reaches them). */
const at = flag("at")?.split(",").map(Number)
/** `--unlock a,b`: audit only — clears `locked` on these door ids (exact) before checking them. */
const unlock = flag("unlock")?.split(",").filter(Boolean) ?? []

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"],
})
const page = await browser.newPage({ viewport: { width: 960, height: 640 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
// Swallow Vite's HMR socket: other agents save files constantly, and a hot reload mid-run wipes the injected test
// doors and the player's state. The page still loads the current code at start.
await page.routeWebSocket(/.*/, () => {})
await page.goto(`${BASE}?view=${view}${extra ? `&${extra}` : ""}`)
/** Waits until world streaming has finished (every module shown, `complete`) and a few full frames have run. */
const ready = () =>
  page.waitForFunction(() => {
    const s = (globalThis as { __ashwood?: { ready: boolean; complete: boolean } }).__ashwood
    return !!s?.complete && s.ready
  }, null, { timeout: 240_000 })
await ready()

let failed = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failed++
}

type Info = { id: string; hx: number; hy: number; hz: number; nx: number; nz: number; mx: number; mz: number; partner?: string }

/** Doorway geometry of every door (internal fields; automation only). */
const doorInfo = () =>
  page.evaluate(() => {
    type D = { id: string; hx: number; hy: number; hz: number; yaw0: number; xa: number; xb: number; spec: { double?: string } }
    const doors = (globalThis as unknown as { __ashwoodDoors: { all(): D[] } }).__ashwoodDoors
    const list = doors.all()
    const mid = (d: D) => {
      const m = (d.xa + d.xb) / 2
      return [d.hx + m * Math.cos(d.yaw0), d.hz - m * Math.sin(d.yaw0)]
    }
    return list.map((d) => {
      let [mx, mz] = mid(d)
      const p = d.spec.double ? list.find((o) => o.id === d.spec.double) : undefined
      if (p) {
        const [px, pz] = mid(p)
        mx = (mx! + px!) / 2
        mz = (mz! + pz!) / 2
      }
      return { id: d.id, hx: d.hx, hy: d.hy, hz: d.hz, nx: Math.sin(d.yaw0), nz: Math.cos(d.yaw0), mx: mx!, mz: mz!, partner: d.spec.double }
    })
  })

/** Puts the player `dist` m from the doorway on side `s`, facing it, aimed at the leaf. */
async function stand(d: Info, s: number, dist: number) {
  await page.evaluate(
    ({ d, s, dist }) => {
      const p = (globalThis as unknown as { __ashwoodPlayer: { pos: { x: number; y: number; z: number }; yaw: number; pitch: number; vy: number; fly: boolean } }).__ashwoodPlayer
      p.fly = false
      p.pos.x = d.mx + d.nx * s * dist
      p.pos.z = d.mz + d.nz * s * dist
      p.pos.y = d.hy + 0.05
      p.vy = 0
      p.yaw = Math.atan2(d.nx * s, d.nz * s)
      p.pitch = -Math.atan2(1.65 - 1.0, dist)
      ;(p as unknown as { resetMotion?: () => void }).resetMotion?.()
    },
    { d, s, dist },
  )
  await page.waitForTimeout(150)
}

const state = (id: string) =>
  page.evaluate((id) => {
    const g = globalThis as unknown as {
      __ashwoodDoors: { get(id: string): { amount: number; isOpen: boolean } | undefined; centreOf(id: string): { x: number; z: number } | null; focused: { id: string } | null }
      __ashwoodPlayer: { pos: { x: number; y: number; z: number } }
    }
    const d = g.__ashwoodDoors?.get(id)
    if (!d) return null
    return { amount: d.amount, isOpen: d.isOpen, moving: ((x: { plan: unknown; free: boolean; hold: number }) => !!x.plan || x.free || x.hold > 0)(d as unknown as { plan: unknown; free: boolean; hold: number }), centre: g.__ashwoodDoors.centreOf(id)!, focused: g.__ashwoodDoors.focused?.id ?? null, pos: { ...g.__ashwoodPlayer.pos } }
  }, id).then((st) => {
    if (!st) throw new Reloaded(id)
    return st
  })

/** The door vanished mid-test: the dev server hot-reloaded the page (another agent saved a file). */
class Reloaded extends Error {
  constructor(id: string) {
    super(`door ${id} missing (page reloaded?)`)
  }
}


/** Waits until a door has stopped moving (doors are slow and heavy: up to ~4.5 s for a gate); returns seconds waited. */
async function settle(id: string, timeout = 9000) {
  const t0 = performance.now()
  await page.waitForTimeout(100)
  while (performance.now() - t0 < timeout && (await state(id)).moving) await page.waitForTimeout(100)
  return (performance.now() - t0) / 1000
}

/** Closes a door (and its partner) through the API and waits for it to latch. */
async function ensureClosed(id: string) {
  await page.evaluate((id) => (globalThis as unknown as { __ashwoodDoors: { get(id: string): { close(): void } | undefined } }).__ashwoodDoors.get(id)?.close(), id)
  await settle(id)
}

/** Points the camera at a world point. */
const aim = (x: number, y: number, z: number) =>
  page.evaluate(
    ({ x, y, z }) => {
      const p = (globalThis as unknown as { __ashwoodPlayer: { pos: { x: number; y: number; z: number }; yaw: number; pitch: number } }).__ashwoodPlayer
      const dx = x - p.pos.x
      const dz = z - p.pos.z
      p.yaw = Math.atan2(-dx, -dz)
      p.pitch = -Math.atan2(p.pos.y + 1.65 - y, Math.hypot(dx, dz))
    },
    { x, y, z },
  )

const side = (d: Info, p: { x: number; z: number }) => (p.x - d.mx) * d.nx + (p.z - d.mz) * d.nz

async function walk(ms: number, key = "KeyW") {
  await page.keyboard.down(key)
  await page.waitForTimeout(ms)
  await page.keyboard.up(key)
  await page.waitForTimeout(100)
}

/** E to open from side `s`, walk through, then turn round and E to close from the other side. */
async function throughAndBack(d: Info, s: number) {
  await ensureClosed(d.id)
  await stand(d, s, 1.1)
  let st = await state(d.id)
  // A pair's leaves act together, so either leaf under the crosshair is the door.
  const isMine = (f: string | null) => f === d.id || (!!d.partner && f === d.partner)
  check(isMine(st.focused), `${d.id} side ${s > 0 ? "+" : "-"}: prompt targets the door (focused ${st.focused})`)
  await page.keyboard.press("KeyE")
  const took = await settle(d.id)
  st = await state(d.id)
  check(st.isOpen && st.amount > 0.99, `${d.id}: E opens it (amount ${st.amount.toFixed(2)}, ${took.toFixed(1)} s)`)
  check(took > 1.2, `${d.id}: heavy, unhurried swing (${took.toFixed(1)} s > 1.2 s)`)
  check(side(d, st.centre) * s < 0.05, `${d.id}: leaf swung away from the player (leaf side ${side(d, st.centre).toFixed(2)})`)
  await walk(1700)
  st = await state(d.id)
  const crossed = side(d, st.pos) * s
  check(crossed < -0.5, `${d.id}: walked through the doorway (now ${crossed.toFixed(2)} m past it)`)
  // Turn round 1.4 m past the opening; aim at the open leaf, or (wide doors) at the open doorway, and close it.
  await page.evaluate(
    ({ d, s }) => {
      const p = (globalThis as unknown as { __ashwoodPlayer: { pos: { x: number; y: number; z: number } } }).__ashwoodPlayer
      p.pos.x = d.mx - d.nx * s * 1.4
      p.pos.z = d.mz - d.nz * s * 1.4
    },
    { d, s },
  )
  await aim(st.centre.x, d.hy + 1.0, st.centre.z)
  await page.waitForTimeout(150)
  st = await state(d.id)
  let via = "leaf"
  if (!isMine(st.focused)) {
    via = "doorway"
    await aim(d.mx, d.hy + 1.0, d.mz)
    await page.waitForTimeout(150)
    st = await state(d.id)
  }
  check(isMine(st.focused), `${d.id}: open door targetable from the far side via ${via} (focused ${st.focused})`)
  if (!isMine(st.focused))
    console.log(
      "  why:",
      await page.evaluate(
        ({ id, partner }) => {
          type DD = { t: number; free: boolean; centre(o: object): { x: number; y: number; z: number } }
          const g = globalThis as unknown as { __ashwoodDoors: { get(id: string): DD | undefined }; __ashwoodPlayer: { pos: object; camera: { matrixWorld: { elements: number[] } } } }
          const leaf = (i: string | undefined) => {
            const x = i ? g.__ashwoodDoors.get(i) : undefined
            return x && { id: i, t: +x.t.toFixed(3), free: x.free, centre: x.centre({}) }
          }
          const e = g.__ashwoodPlayer.camera.matrixWorld.elements
          return JSON.stringify({ pos: g.__ashwoodPlayer.pos, eye: [e[12], e[13], e[14]], look: [-e[8]!, -e[9]!, -e[10]!], leaves: [leaf(id), leaf(partner)] })
        },
        { id: d.id, partner: d.partner },
      ),
    )
  await page.keyboard.press("KeyE")
  // Step back from the doorway while it closes: walking into a closing leaf would push it open again (body push), and
  // a leaf closing towards the player stops against them.
  await page.waitForTimeout(100)
  await walk(1000, "KeyS")
  await settle(d.id)
  st = await state(d.id)
  check(!st.isOpen && st.amount < 0.01, `${d.id}: E closes it (amount ${st.amount.toFixed(3)})`)
}

/** Sets a door ajar at open fraction `t` swinging towards `dir`, at rest (automation only). */
const setAjar = (id: string, t: number, dir: number) =>
  page.evaluate(
    ({ id, t, dir }) => {
      type D = { t: number; target: number; v: number; dir: number; plan: unknown; free: boolean; touched: boolean; active: boolean; pose(t: number): void; apply(): void }
      const d = (globalThis as unknown as { __ashwoodDoors: { get(id: string): D } }).__ashwoodDoors.get(id)
      Object.assign(d, { t, target: t, v: 0, dir, plan: null, free: false, touched: false, active: false })
      d.pose(t)
      d.apply()
    },
    { id, t, dir },
  )

/** Holds W (and Shift) into a door from the current stand, sampling the player and the leaf every 50 ms. */
async function pushWalk(d: Info, run: boolean, ms: number) {
  if (run) await page.keyboard.down("ShiftLeft")
  await page.keyboard.down("KeyW")
  const s0 = side(d, (await state(d.id)).pos)
  const samples: { t: number; side: number; amount: number }[] = []
  const t0 = performance.now()
  while (performance.now() - t0 < ms) {
    const st = await state(d.id)
    samples.push({ t: performance.now(), side: side(d, st.pos), amount: st.amount })
    await page.waitForTimeout(50)
  }
  await page.keyboard.up("KeyW")
  if (run) await page.keyboard.up("ShiftLeft")
  await page.waitForTimeout(150)
  const end = await state(d.id)
  // Stalls: 150 ms windows (after the first 300 ms of acceleration, before reaching the far side) with < 3 cm progress.
  let stuck = 0
  let reversals = 0
  let fastest = 0
  let slowest = Infinity
  const sign = Math.sign(s0) || 1
  for (let i = 3; i < samples.length; i++) {
    const a = samples[i - 3]!
    const b = samples[i]!
    const dt = (b.t - a.t) / 1000
    const prog = (a.side - b.side) * sign
    if (b.t - samples[0]!.t > 300 && b.side * sign > -0.5) {
      if (prog < 0.03) stuck++
      const sp = prog / dt
      // Walking speed before contact vs. while the leaf is moving under the push.
      if (b.amount === a.amount && b.side * sign > 0.6) fastest = Math.max(fastest, sp)
      else if (b.amount > a.amount) slowest = Math.min(slowest, sp)
    }
  }
  let lastDir = 0
  for (let i = 1; i < samples.length; i++) {
    const dA = samples[i]!.amount - samples[i - 1]!.amount
    if (Math.abs(dA) < 1e-4) continue
    const dir = Math.sign(dA)
    if (lastDir && dir !== lastDir) reversals++
    lastDir = dir
  }
  return { crossed: side(d, end.pos) * sign, amount: end.amount, peak: Math.max(...samples.map((x) => x.amount), end.amount), stuck, reversals, fastest, slowest: slowest === Infinity ? 0 : slowest }
}

if (!all) {
  // Throwaway door in a wall, built only in this page: hinge at the wall gap's west jamb, 1 m leaf along +x.
  const d = await page.evaluate(() => {
    const g = globalThis as unknown as {
      __ashwoodDebug: { scene: object }
      __ashwoodPlayer: { pos: { x: number; y: number; z: number }; ctx: { colliders: { min: number[]; max: number[] }[]; floors: unknown[] } }
      __ashwoodDoors: { add(spec: unknown): unknown; all(): unknown[] }
    }
    const Object3D = Object.getPrototypeOf(Object.getPrototypeOf(g.__ashwoodDebug.scene)).constructor as new () => object
    const p = g.__ashwoodPlayer.pos
    const hx = Math.round(p.x) - 0.5
    const hz = Math.round(p.z) - 4
    const y = p.y
    const c = g.__ashwoodPlayer.ctx.colliders
    c.push({ min: [hx - 4, y - 1, hz - 0.1], max: [hx, y + 3, hz + 0.1] }, { min: [hx + 1, y - 1, hz - 0.1], max: [hx + 5, y + 3, hz + 0.1] })
    g.__ashwoodDoors.add({ id: "test", leaf: new Object3D(), hinge: [hx, y, hz], width: 1, height: 2.05, thickness: 0.045, openAngle: Math.PI / 2, sound: "steel" })
    g.__ashwoodDoors.add({ id: "test-locked", leaf: new Object3D(), hinge: [hx + 8, y, hz], width: 1, height: 2.05, thickness: 0.045, openAngle: Math.PI / 2, locked: true })
    g.__ashwoodDoors.add({ id: "test-panic", leaf: new Object3D(), hinge: [hx - 8, y, hz], width: 1, height: 2.05, thickness: 0.045, openAngle: Math.PI / 2, panic: true, sound: "steel" })
    return true
  })
  void d
  const info = (await doorInfo()).filter((x) => x.id === "test")[0]!
  // Closed door blocks.
  await stand(info, 1, 1.1)
  if (shot) await page.waitForTimeout(500).then(() => page.screenshot({ path: shot }))
  await walk(1500)
  let st = await state("test")
  check(side(info, st.pos) > 0.25, `test: closed door blocks (player ${side(info, st.pos).toFixed(2)} m in front)`)
  await throughAndBack(info, 1)
  await throughAndBack(info, -1)
  // Closing on a player in the doorway: the leaf stops against them instead of pushing.
  await stand(info, 1, 1.1)
  await page.keyboard.press("KeyE")
  await settle("test")
  await page.evaluate((info) => {
    const p = (globalThis as unknown as { __ashwoodPlayer: { pos: { x: number; z: number } } }).__ashwoodPlayer.pos
    p.x = info.hx + 0.45
    p.z = info.mz - 0.1
  }, info)
  await page.evaluate(() => (globalThis as unknown as { __ashwoodDoors: { get(id: string): { close(): void } } }).__ashwoodDoors.get("test")!.close())
  await page.waitForTimeout(3000)
  st = await state("test")
  check(st.amount > 0.15, `test: closing leaf stops against a player in the doorway (amount ${st.amount.toFixed(2)})`)
  // Step back out of the leaf's arc (towards the side it opened from).
  await walk(1200, "KeyS")
  await settle("test")
  st = await state("test")
  check(st.amount < 0.01, `test: and finishes closing once they've stepped out (amount ${st.amount.toFixed(3)})`)
  // Interrupt: close mid-swing; the leaf brakes and turns round without jumping, then latches.
  await stand(info, 1, 1.1)
  await page.keyboard.press("KeyE")
  await page.waitForTimeout(800)
  await page.evaluate(() => (globalThis as unknown as { __ashwoodDoors: { get(id: string): { close(): void } } }).__ashwoodDoors.get("test")!.close())
  const samples: number[] = []
  for (let i = 0; i < 60 && (samples.length < 3 || (await state("test")).moving); i++) {
    samples.push((await state("test")).amount)
    await page.waitForTimeout(50)
  }
  const peak = Math.max(...samples)
  const jump = Math.max(...samples.slice(1).map((a, i) => Math.abs(a - samples[i]!)))
  st = await state("test")
  check(peak > 0.1 && peak < 0.95 && jump < 0.12 && st.amount === 0, `test: reversed mid-swing smoothly (peak ${peak.toFixed(2)}, max step ${jump.toFixed(3)}, end ${st.amount})`)
  // Locked door: E rattles, stays shut.
  const locked = (await doorInfo()).find((x) => x.id === "test-locked")!
  await stand(locked, 1, 1.1)
  const promptText = await page.evaluate(() => document.querySelector(".door-prompt")?.textContent ?? "")
  check(promptText.includes("Locked"), `test-locked: prompt reads "${promptText}"`)
  await page.keyboard.press("KeyE")
  await page.waitForTimeout(600)
  st = await state("test-locked")
  check(!st.isOpen && st.amount === 0, "test-locked: E rattles, stays shut")

  // Body push. An ajar door yields at a walk (slowly) and at a run (bangs open), the player passes without sticking;
  // pushing from the side it swings towards just blocks; a room door stays where it was left (no closer).
  for (const run of [false, true]) {
    await setAjar("test", 0.15, 1)
    await stand(info, 1, 1.5)
    const r = await pushWalk(info, run, run ? 1500 : 2600)
    const tag = run ? "run" : "walk"
    check(r.crossed < -0.4, `test push (${tag}): body pushed the ajar door and passed (${r.crossed.toFixed(2)} m past, door ${r.amount.toFixed(2)})`)
    check(r.peak > (run ? 0.75 : 0.4), `test push (${tag}): leaf swung open (peak ${r.peak.toFixed(2)})`)
    check(r.stuck === 0, `test push (${tag}): no stuck frames (${r.stuck} stalled 150 ms windows)`)
    check(r.reversals <= 2, `test push (${tag}): leaf moved without jitter (${r.reversals} direction changes)`)
    if (!run) check(r.slowest < r.fastest * 0.95, `test push (walk): pushing slows the walk (${r.slowest.toFixed(2)} vs ${r.fastest.toFixed(2)} m/s)`)
  }
  await page.waitForTimeout(5000)
  st = await state("test")
  check(st.amount > 0.3, `test: room door stays where it was pushed (amount ${st.amount.toFixed(2)} after 5 s)`)
  await setAjar("test", 0.15, 1)
  await stand(info, -1, 1.5)
  const wrong = await pushWalk(info, false, 1500)
  st = await state("test")
  check(wrong.crossed > 0.25 && Math.abs(st.amount - 0.15) < 0.01, `test push from the swing side blocks (player ${wrong.crossed.toFixed(2)} m short, door ${st.amount.toFixed(2)})`)
  await setAjar("test", 0, 1)
  await stand(info, 1, 1.5)
  const shut = await pushWalk(info, false, 1500)
  check(shut.crossed > 0.25, `test: shut latched door ignores pushing (player ${shut.crossed.toFixed(2)} m short)`)
  // Panic-bar door: pushes open from shut, then its closer draws it shut a few seconds later.
  const panic = (await doorInfo()).find((x) => x.id === "test-panic")!
  await stand(panic, 1, 1.5)
  const pr = await pushWalk(panic, false, 2600)
  check(pr.crossed < -0.4 && pr.peak > 0.3, `test-panic: pushed open from shut and passed (${pr.crossed.toFixed(2)} m, peak ${pr.peak.toFixed(2)})`)
  await page.waitForTimeout(4000)
  await settle("test-panic", 9000)
  st = await state("test-panic")
  check(st.amount === 0, `test-panic: closer drew it shut (amount ${st.amount})`)
} else {
  if (at?.length === 3) {
    await page.evaluate((at) => {
      const p = (globalThis as unknown as { __ashwoodPlayer: { pos: { x: number; y: number; z: number }; resetMotion(): void } }).__ashwoodPlayer
      p.pos.x = at[0]!
      p.pos.y = at[1]!
      p.pos.z = at[2]!
      p.resetMotion()
    }, at)
    for (let i = 0; i < 40 && only && !(await doorInfo()).some((d) => wanted(d.id)); i++) await page.waitForTimeout(250)
  }
  if (unlock.length) {
    for (let i = 0; i < 40 && !(await page.evaluate((ids) => ids.every((id) => (globalThis as unknown as { __ashwoodDoors: { get(id: string): unknown } }).__ashwoodDoors.get(id)), unlock)); i++) await page.waitForTimeout(250)
    const done = await page.evaluate((ids) => ids.map((id) => {
      const d = (globalThis as unknown as { __ashwoodDoors: { get(id: string): { locked: boolean } | undefined } }).__ashwoodDoors.get(id)
      if (d) d.locked = false
      return `${id}:${d ? "unlocked" : "missing"}`
    }), unlock)
    console.log(`audit unlock: ${done.join(" ")}`)
  }
  const issues = await page.evaluate(() => (globalThis as unknown as { __ashwoodDoors: { audit(): { id: string; issue: string }[] } }).__ashwoodDoors.audit())
  for (const i of issues) if (wanted(i.id)) check(false, `${i.id}: ${i.issue}`)
  const registered = await doorInfo()
  const infos = registered.filter((d) => wanted(d.id))
  console.log(`${registered.length} doors registered, checking ${infos.length}`)
  check(infos.length > 0, `doors match ${only ? `--only ${only.join(",")}` : "--all"}`)
  const done = new Set<string>()
  for (const d of infos) {
    if (done.has(d.id)) continue
    done.add(d.id)
    if (d.partner) done.add(d.partner)
    const small = await page.evaluate((id) => (globalThis as unknown as { __ashwoodDoors: { get(id: string): { height: number } } }).__ashwoodDoors.get(id)!.height < 1.2, d.id)
    if (small) {
      console.log(`skip ${d.id} (not a doorway: a control using the door system)`)
      continue
    }
    const locked = await page.evaluate((id) => (globalThis as unknown as { __ashwoodDoors: { get(id: string): { locked: boolean } } }).__ashwoodDoors.get(id)!.locked, d.id)
    if (locked) {
      console.log(`skip ${d.id} (locked)`)
      continue
    }
    for (const s of [1, -1]) {
      try {
        await throughAndBack(d, s)
      } catch (e) {
        if (!(e instanceof Reloaded)) throw e
        console.log(`note: ${e.message}; waiting for the page and retrying ${d.id} side ${s}`)
        await ready()
        await throughAndBack(d, s)
      }
    }
  }
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`)
await browser.close()
process.exit(failed ? 1 : 0)
