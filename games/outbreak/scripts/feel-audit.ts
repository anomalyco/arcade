import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

/**
 * Game-feel audit: drives the real game headlessly (Metal Chromium, `--mute-audio`, no window) through a scripted
 * session and measures what a player feels, without eyes or ears.
 *
 * Deterministic part (frozen clock, `harness.step` at 60 Hz): walk, sprint and stop (speed, camera lag, settle,
 * overshoot), an aim flip (how fast the gun comes round), a miss, shots until a kill, a shove, crowbar light and heavy
 * swings, getting hit, a door and a search. Each beat records the camera's trauma, kick offset, punch, hit-stop and
 * damage flash per frame, the zombie's state, flash and knockback, and every sound the `SoundDirector` emits (it runs
 * muted too, so the event log is exact).
 *
 * Real-time part (live pacer, trusted key events): keydown-to-moved-draw latency, frame intervals and draw CPU while
 * sprinting, a 40-zombie horde fight and a 17:30 → 21:00 time-lapse.
 *
 *   bun scripts/feel-audit.ts [--label before]     (from games/outbreak, via `hivemind run --kind browser`)
 */
const root = resolve(import.meta.dir, "..")
const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1]! : "audit"
const out = resolve(root, "../../captures/feel-audit")
mkdirSync(out, { recursive: true })

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "feel-audit-hooks",
      enforce: "pre",
      transform(code, id) {
        if (id !== resolve(root, "src/main.ts")) return
        return code
          .replace(
            "function draw(dt: number) {",
            "function draw(dt: number) { const __t0 = performance.now(); try { return __draw(dt) } finally { const __t1 = performance.now(); (window as any).__audit?.draws.push([__t0, __t1 - __t0, session.view.player.x, session.view.player.y]) } }\n  function __draw(dt: number) {",
          )
          .replace(
            "Object.assign(window, { __arcadeHarness: harness })",
            "Object.assign(window, { __arcadeHarness: harness, __feel: { audio, cam, feelTracker, frameRenderer, pacer, frameUi } })",
          )
      },
    },
  ],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium not found")
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})
const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]! : 0
}
const r3 = (x: number) => Math.round(x * 1000) / 1000

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  await page.addInitScript(() => {
    const w = window as any
    w.__audit = { draws: [], keys: [], loaf: [] }
    addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (!e.repeat) w.__audit.keys.push([performance.now(), e.code])
      },
      true,
    )
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as any[])
          w.__audit.loaf.push({
            start: e.startTime,
            duration: e.duration,
            scripts: (e.scripts ?? [])
              .map((s: any) => ({ d: Math.round(s.duration), src: `${s.sourceFunctionName || s.invoker || ""} ${String(s.sourceURL || "").split("/").slice(-2).join("/")}` }))
              .filter((s: any) => s.d >= 5),
          })
      }).observe({ type: "long-animation-frame", buffered: true })
    } catch {}
  })
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 60_000 })
  await page.locator("#game").click()
  await page.keyboard.press("Shift")
  await page.waitForTimeout(1500)

  // Instrument: every director event with the sim time, and survivor footfalls.
  await page.evaluate(() => {
    const w = window as any
    const { audio } = w.__feel
    w.__sounds = []
    const observe = audio.director.observe.bind(audio.director)
    audio.director.observe = (world: any, listener: any) => {
      const evs = observe(world, listener)
      for (const e of evs) w.__sounds.push({ t: world.time, id: e.id, delay: e.delay ?? 0, gain: e.gain ?? 1, d: Math.hypot(e.x - listener.x, e.y - listener.y) })
      return evs
    }
    const footstep = audio.footstep.bind(audio)
    audio.footstep = (x: number, y: number, speed: number) => {
      w.__sounds.push({ t: w.__arcadeHarness.session().view.time, id: "foot", speed })
      return footstep(x, y, speed)
    }
  })

  // Per-call timing of the per-frame UI and audio work, sampled in the real-time windows.
  await page.evaluate(() => {
    const w = window as any
    const { frameUi, audio } = w.__feel
    w.__timers = {}
    const wrap = (name: string, obj: any, fn: string) => {
      const orig = obj[fn].bind(obj)
      obj[fn] = (...args: unknown[]) => {
        const t0 = performance.now()
        try { return orig(...args) } finally { (w.__timers[name] ??= []).push(performance.now() - t0) }
      }
    }
    wrap("frameUi.updateFrame", frameUi, "updateFrame")
    wrap("inventoryHud.sync", frameUi.inventoryHud, "sync")
    if (frameUi.inventoryHud.dock) wrap("dock.sync", frameUi.inventoryHud.dock, "sync")
    wrap("hud.update", frameUi.hud, "update")
    wrap("audio.update", audio, "update")
  })

  /** Steps `n` deterministic frames, sampling feel, camera, survivor, gun and (optionally) one zombie each frame. */
  const run = (n: number, command: Record<string, unknown> = {}, zid: number | null = null, perFrame: Record<string, Record<string, unknown>> = {}) =>
    page.evaluate(
      async ({ n, command, zid, perFrame }) => {
        const w = window as any
        const h = w.__arcadeHarness
        const { cam, feelTracker } = w.__feel
        const rows: any[] = []
        for (let i = 0; i < n; i++) {
          const before = w.__sounds.length
          await h.step(1 / 60, { ...command, ...(perFrame[i] ?? {}) })
          const s = h.session().view
          const p = s.player
          const f = feelTracker.inspect()
          const gun = h.human().gun
          const z = zid === null ? null : s.zombies.find((a: any) => a.id === zid)
          rows.push({
            t: s.time,
            px: p.x,
            py: p.y,
            aim: p.aim,
            health: p.health,
            camX: cam.x,
            camZ: cam.z,
            trauma: f.trauma,
            kick: Math.hypot(f.offset.x, f.offset.z),
            zoom: f.offset.zoom,
            roll: f.offset.roll,
            hitStop: f.hitStopRemaining,
            flash: f.damageFlash,
            gunYaw: gun ? Math.atan2(gun.x[2], gun.x[0]) : null,
            gunYawZ: gun ? Math.atan2(gun.z[2], gun.z[0]) : null,
            z: z && { state: z.state, hp: z.hp, hitFlash: z.hitFlash, x: z.x, y: z.y, timer: z.timer },
            sounds: w.__sounds.slice(before).map((e: any) => e.id),
          })
        }
        return rows
      },
      { n, command, zid, perFrame },
    )
  const ev = (fn: string, arg?: unknown) => page.evaluate(new Function("arg", `const h = window.__arcadeHarness; const w = window; ${fn}`) as any, arg)
  const peaks = (rows: any[]) => ({
    trauma: r3(Math.max(...rows.map((r) => r.trauma))),
    kickM: r3(Math.max(...rows.map((r) => r.kick))),
    zoomM: r3(Math.max(...rows.map((r) => Math.abs(r.zoom)))),
    rollRad: r3(Math.max(...rows.map((r) => Math.abs(r.roll)))),
    hitStopMs: Math.round(Math.max(...rows.map((r) => r.hitStop)) * 1000 + (rows.some((r) => r.hitStop > 0) ? 1000 / 60 : 0)),
    flash: r3(Math.max(...rows.map((r) => r.flash))),
    sounds: rows.flatMap((r, i) => r.sounds.map((s: string) => `${s}@${i}`)),
  })

  await ev(`h.freeze(); h.setLab("timeScale", 0); h.setLab("hour", 13); h.setLab("zombieCount", 0); h.setLab("audioMuted", 0); h.session().ai.agents.length = 0`)
  const report: Record<string, unknown> = { label }

  // 1. Walk, sprint, stop: speed, camera lag behind the survivor, settle and overshoot.
  await ev(`h.pose(14, 44, 0)`)
  await run(30)
  const walk = await run(120, { mx: 1, my: 0, aim: 0 })
  const sprint = await run(120, { mx: 1, my: 0, aim: 0, sprint: true })
  const stop = await run(120, { aim: 0 })
  const speed = (rows: any[]) => r3((rows.at(-1).px - rows.at(-31).px) / (30 / 60))
  const lag = (rows: any[]) => r3(rows.at(-1).px - rows.at(-1).camX)
  const settleIdx = stop.findIndex((r, i) => i > 0 && stop.slice(i).every((s) => Math.abs(s.px - s.camX) < 0.05))
  const accel = walk.findIndex((r, i) => i > 0 && (r.px - walk[i - 1].px) * 60 >= 0.95 * speed(walk))
  report.movement = {
    walkSpeed: speed(walk),
    sprintSpeed: speed(sprint),
    framesToWalkSpeed: accel + 1,
    framesToStop: stop.findIndex((r, i) => i > 0 && Math.abs(r.px - stop[i - 1].px) < 1e-4),
    camLagWalkM: lag(walk),
    camLagSprintM: lag(sprint),
    camSettleAfterStopMs: Math.round(((settleIdx < 0 ? stop.length : settleIdx) / 60) * 1000),
    camOvershootM: r3(Math.max(0, ...stop.map((r) => r.camX - r.px))),
    footstepsWalk: walk.flatMap((r) => r.sounds).filter((s: string) => s === "foot").length,
    footstepsSprint: sprint.flatMap((r) => r.sounds).filter((s: string) => s === "foot").length,
    sprintCamKickPeak: peaks(sprint).kickM,
  }

  // 2. Aim flip: from east to west, how many frames until the gun points within 10° and 2° of the aim.
  await ev(`h.stock(12, { ammo: 24 }); h.pose(30, 44, 0)`)
  await run(40, { aim: 0, fire: true }, null, { 1: { fire: false } })
  await run(30, { aim: 0 })
  const flip = await run(60, { aim: Math.PI })
  const axis = flip.at(-1).gunYaw !== null && Math.abs(Math.abs(flip.at(-1).gunYaw) - Math.PI) < 0.6 ? "gunYaw" : "gunYawZ"
  const err = (r: any) => (r[axis] === null ? null : Math.abs(Math.atan2(Math.sin(r[axis] - Math.PI), Math.cos(r[axis] - Math.PI))))
  report.aim = {
    axis,
    framesTo10deg: flip.findIndex((r) => (err(r) ?? 9) < (10 * Math.PI) / 180) + 1,
    framesTo2deg: flip.findIndex((r) => (err(r) ?? 9) < (2 * Math.PI) / 180) + 1,
    finalErrDeg: r3(((err(flip.at(-1)) ?? 0) * 180) / Math.PI),
  }

  // 3. A miss into the wood siding of the house north of the lawn.
  await ev(`h.stock(12, { ammo: 24 }); h.pose(31, 40, -Math.PI / 2)`)
  await run(10, { aim: -Math.PI / 2 })
  const miss = await run(30, { aim: -Math.PI / 2 }, null, { 0: { fire: true } })
  report.shotMiss = peaks(miss)

  // 4. Shots into one zombie 6 m east until it dies: per-shot feel, its reaction and the sounds.
  await ev(`h.setLab("infiniteAmmo", 1); h.stock(12, { ammo: 24 }); h.pose(40, 44, 0)`)
  await run(10, { aim: 0 })
  const zid = await ev(`const z = h.spawnZombie(46, 44, "wander", Math.PI); return z.id`)
  const shots: any[] = []
  for (let k = 0; k < 12; k++) {
    const rows = await run(24, { aim: 0 }, zid as number, { 0: { fire: true } })
    const z0 = rows[0].z
    const zs = rows.map((r) => r.z?.state ?? "gone")
    shots.push({
      ...peaks(rows),
      zStates: [...new Set(zs)],
      staggerMs: Math.round((zs.filter((s) => s === "stagger").length / 60) * 1000),
      knockbackM: z0 ? r3(Math.max(...rows.filter((r) => r.z).map((r) => r.z.x)) - (shots.at(-1)?.endX ?? 46)) : 0,
      hpAfter: rows.at(-1).z?.hp ?? null,
      hitFlashFirst: z0 ? r3(z0.hitFlash) : null,
      endX: rows.at(-1).z?.x ?? null,
    })
    if (zs.at(-1) === "dead" || zs.at(-1) === "gone") break
    await run(18, { aim: 0 }, zid as number)
  }
  report.shots = shots
  await ev(`h.setLab("infiniteAmmo", 0)`)

  // 5. Shove (no melee weapon): a zombie 1.1 m east.
  await ev(`h.session().ai.agents.length = 0; h.pose(44, 44, 0)`)
  const sid = await ev(`const z = h.spawnZombie(45.1, 44, "wander", Math.PI); return z.id`)
  await run(2, { aim: 0 }, sid as number)
  const shove = await run(40, { aim: 0 }, sid as number, { 0: { melee: true } })
  report.shove = { ...peaks(shove), zStates: [...new Set(shove.map((r) => r.z?.state))] }
  await ev(`h.session().ai.agents.length = 0; h.pose(44, 44, 0)`)
  await run(40, { aim: 0 })
  const shoveMiss = await run(30, { aim: 0 }, null, { 0: { melee: true } })
  report.shoveMiss = peaks(shoveMiss)

  // 6. Crowbar: a light swing into a zombie, a heavy charge, then a whiff.
  for (const kind of ["light", "heavy", "whiff"] as const) {
    await ev(`h.stageMelee("crowbar", "none"); h.session().ai.agents.length = 0`)
    await run(30, { aim: 0 })
    const mid = kind === "whiff" ? null : await ev(`const z = h.spawnZombie(45.3, 44, "wander", Math.PI); z.hp = 400; return z.id`)
    const frames = kind === "heavy" ? 70 : 40
    const perFrame: Record<number, Record<string, unknown>> = { 0: { fire: true, fireHeld: true } }
    if (kind === "heavy") for (let i = 1; i < 30; i++) perFrame[i] = { fireHeld: true }
    const rows = await run(frames, { aim: 0 }, mid as number | null, perFrame)
    report[`melee_${kind}`] = { ...peaks(rows), zStates: [...new Set(rows.map((r) => r.z?.state))] }
  }

  // 7. Getting hit: a chasing zombie next to the survivor until the first two hits land.
  await ev(`h.stock(12, {}); h.session().ai.agents.length = 0; h.pose(44, 44, 0); h.setLab("hour", 13)`)
  const aid = await ev(`const z = h.spawnZombie(44.8, 44, "chase", Math.PI); z.targetX = 44; z.targetY = 44; return z.id`)
  const hit = await run(240, { aim: 0 }, aid as number)
  const firstHit = hit.findIndex((r, i) => i > 0 && r.health < hit[i - 1].health)
  const hits = hit.filter((r, i) => i > 0 && r.health < hit[i - 1].health).length
  report.hitTaken = {
    ...peaks(firstHit >= 0 ? hit.slice(firstHit, firstHit + 40) : hit),
    hitsIn4s: hits,
    damage: r3(100 - hit.at(-1).health),
    firstHitFrame: firstHit,
  }

  // 8. Door and search: the sounds and any feel on interaction.
  await ev(`h.session().ai.agents.length = 0`)
  const doorY = await ev(`return h.state().town.doors[0].rect[3]`)
  await ev(`h.pose(27.7, ${doorY} + 1, -Math.PI / 2)`)
  await run(2, { aim: -Math.PI / 2 })
  const door = await run(40, { aim: -Math.PI / 2 }, null, { 0: { interact: true } })
  report.door = peaks(door)

  // 9. Horde fight (deterministic): 30 chasing zombies around the survivor; the shot pattern of a real fight.
  await ev(`h.setLab("infiniteAmmo", 1); h.setLab("hour", 22); h.session().ai.agents.length = 0; h.pose(44, 44, 0); for (let i = 0; i < 30; i++) { const a = (i / 30) * Math.PI * 2; const z = h.spawnZombie(44 + Math.cos(a) * (7 + (i % 3)), 44 + Math.sin(a) * (7 + (i % 3)), "chase", a + Math.PI); z.targetX = 44; z.targetY = 44 }`)
  const hordeRows: any[] = []
  for (let k = 0; k < 12; k++) {
    const aim = (k / 12) * Math.PI * 2
    hordeRows.push(...(await run(15, { aim }, null, { 0: { fire: true }, 7: { fire: true } })))
  }
  const hordeSounds = hordeRows.flatMap((r) => r.sounds)
  const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {})
  report.hordeDeterministic = {
    traumaP50: r3(q(hordeRows.map((r) => r.trauma), 0.5)),
    traumaMax: r3(Math.max(...hordeRows.map((r) => r.trauma))),
    kickP95: r3(q(hordeRows.map((r) => r.kick), 0.95)),
    framesWithHitStop: hordeRows.filter((r) => r.hitStop > 0).length,
    framesAtMaxKick: hordeRows.filter((r) => r.kick > 0.59).length,
    sounds: count(hordeSounds),
    health: r3(hordeRows.at(-1).health),
  }
  await ev(`h.setLab("infiniteAmmo", 0)`)

  const soundCounts = await page.evaluate(() => (window as any).__sounds.map((e: any) => e.id))
  report.soundCoverage = count(soundCounts)
  report.audioTelemetry = await ev(`const a = h.audio(); return { loadedSamples: a.loadedSamples, played: a.played, events: a.events, pendingSkips: a.pendingSkips, maxVoicesSeen: a.maxVoicesSeen, stolen: a.stolen, dropped: a.dropped, playedById: a.playedById }`)

  // 10. Real time: keydown → first draw that moved the survivor; frame intervals while sprinting; a horde; nightfall.
  await ev(`h.session().ai.agents.length = 0; h.setLab("hour", 13); h.setLab("timeScale", 0); h.pose(20, 44, 0); h.freeze(false)`)
  await page.waitForTimeout(800)
  const latency: number[] = []
  for (let k = 0; k < 10; k++) {
    const key = k % 2 ? "KeyA" : "KeyD"
    await page.waitForTimeout(220 + ((k * 37) % 50))
    const t = await page.evaluate(() => performance.now())
    await page.keyboard.down(key)
    await page.waitForTimeout(250)
    await page.keyboard.up(key)
    const ms = await page.evaluate((t) => {
      const a = (window as any).__audit
      const draws = a.draws.filter((d: number[]) => d[0] >= t)
      const key = a.keys.find((k: number[]) => k[0] >= t)
      if (!key) return null
      const base = a.draws.filter((d: number[]) => d[0] <= key[0]).at(-1)
      const moved = draws.find((d: number[]) => d[0] >= key[0] && base && Math.abs(d[2] - base[2]) > 1e-4)
      return moved ? moved[0] + moved[1] - key[0] : null
    }, t)
    if (ms !== null) latency.push(ms)
  }
  const window_ = async (name: string, act: () => Promise<void>) => {
    await page.evaluate(() => {
      const a = (window as any).__audit
      ;(window as any).__timers = {}
      a.draws.length = 0
      a.loaf.length = 0
      a.t0 = performance.now()
    })
    await act()
    const raw = await page.evaluate(() => {
      const a = (window as any).__audit
      const timers = Object.fromEntries(Object.entries((window as any).__timers as Record<string, number[]>).map(([k, v]) => {
        const s = [...v].sort((x, y) => x - y)
        return [k, { n: s.length, p50: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)], max: s.at(-1), totalMsPerSec: 0 }]
      }))
      return { draws: a.draws, loaf: a.loaf, t1: performance.now(), t0: a.t0, timers }
    })
    const gaps = raw.draws.slice(1).map((d: number[], i: number) => d[0] - raw.draws[i][0])
    const cpu = raw.draws.map((d: number[]) => d[1])
    return {
      name,
      seconds: r3((raw.t1 - raw.t0) / 1000),
      fps: r3(raw.draws.length / ((raw.t1 - raw.t0) / 1000)),
      intervalMs: { p50: r3(q(gaps, 0.5)), p95: r3(q(gaps, 0.95)), p99: r3(q(gaps, 0.99)), max: r3(q(gaps, 1)) },
      hitchesOver25ms: gaps.filter((g: number) => g > 25).length,
      hitchesOver50ms: gaps.filter((g: number) => g > 50).length,
      drawCpuMs: { p50: r3(q(cpu, 0.5)), p95: r3(q(cpu, 0.95)), p99: r3(q(cpu, 0.99)), max: r3(q(cpu, 1)) },
      timers: Object.fromEntries(Object.entries(raw.timers as Record<string, any>).map(([k, v]) => [k, { n: v.n, p50: r3(v.p50), p95: r3(v.p95), max: r3(v.max) }])),
      slowDraws: raw.draws.filter((d: number[]) => d[1] > 12).map((d: number[]) => [Math.round(d[0] - raw.t0), Math.round(d[1])]),
      longGaps: gaps.map((g: number, i: number) => [Math.round(raw.draws[i][0] - raw.t0), Math.round(g)]).filter((g: number[]) => g[1] > 50),
      quality: await ev(`const s = h.quality(); return { tier: s.activeTier, pixelRatio: s.pixelRatio, adaptations: s.adaptations }`),
      worstLoaf: [...raw.loaf].sort((a: any, b: any) => b.duration - a.duration).slice(0, 4),
    }
  }
  const realtime: unknown[] = []
  const sprintLoop = async () => {
    await page.keyboard.down("ShiftLeft")
    for (const k of ["KeyD", "KeyS", "KeyA", "KeyW"]) {
      await page.keyboard.down(k)
      await page.waitForTimeout(1800)
      await page.keyboard.up(k)
    }
    await page.keyboard.up("ShiftLeft")
  }
  realtime.push(
    await window_("sprint", async () => {
      await page.keyboard.down("ShiftLeft")
      for (const k of ["KeyD", "KeyS", "KeyA", "KeyW"]) {
        await page.keyboard.down(k)
        await page.waitForTimeout(1800)
        await page.keyboard.up(k)
      }
      await page.keyboard.up("ShiftLeft")
    }),
  )
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Profiler.enable")
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 })
  await cdp.send("Profiler.start")
  realtime.push(await window_("sprint-again", sprintLoop))
  const { profile } = (await cdp.send("Profiler.stop")) as any
  {
    // Self and inclusive time per function across the window, and which functions sat under the samples of the
    // slowest stretches (consecutive samples inside one task > 30 ms).
    const byId = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]))
    const parent = new Map<number, number>()
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
    const name = (n: any) => `${n.callFrame.functionName || "(anon)"} ${String(n.callFrame.url).split("/").slice(-2).join("/")}:${n.callFrame.lineNumber + 1}`
    const self = new Map<string, number>()
    const incl = new Map<string, number>()
    profile.samples.forEach((id: number, i: number) => {
      const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000
      const n = byId.get(id)
      self.set(name(n), (self.get(name(n)) ?? 0) + dt)
      const seen = new Set<string>()
      for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
        const nm = name(byId.get(cur))
        if (seen.has(nm)) continue
        seen.add(nm)
        incl.set(nm, (incl.get(nm) ?? 0) + dt)
      }
    })
    const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).filter(([k]) => !k.startsWith("(idle)") && !k.startsWith("(program)") && !k.startsWith("(root)")).slice(0, 40).map(([k, v]) => [k, Math.round(v)])
    await Bun.write(resolve(out, `${label}-sprint-profile.json`), JSON.stringify({ self: top(self), inclusive: top(incl) }, null, 1))
  }
  await ev(`h.setLab("infiniteAmmo", 1); h.setLab("hour", 22); h.pose(44, 44, 0); for (let i = 0; i < 40; i++) { const a = (i / 40) * Math.PI * 2; const z = h.spawnZombie(44 + Math.cos(a) * (8 + (i % 4)), 44 + Math.sin(a) * (8 + (i % 4)), "chase", a + Math.PI); z.targetX = 44; z.targetY = 44 }`)
  realtime.push(
    await window_("horde", async () => {
      const box = (await page.locator("#game").boundingBox())!
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2
        await page.mouse.move(box.x + box.width / 2 + Math.cos(a) * 200, box.y + box.height / 2 + Math.sin(a) * 200)
        await page.mouse.down()
        await page.waitForTimeout(60)
        await page.mouse.up()
        await page.waitForTimeout(400)
      }
    }),
  )
  await ev(`h.setLab("infiniteAmmo", 0); h.session().ai.agents.length = 0; h.setLab("hour", 17.5); h.pose(30, 44, 0)`)
  realtime.push(
    await window_("dusk-to-night", async () => {
      for (let k = 0; k <= 70; k++) {
        await ev(`h.setLab("hour", ${17.5 + k * 0.05})`)
        await page.waitForTimeout(140)
      }
    }),
  )
  const hourEnd = await ev(`return h.state().dayCycle.hour`)
  await ev(`h.setLab("timeScale", 0)`)
  report.realtime = { keydownToMovedDrawMs: latency.map(r3), latencyP50: r3(q(latency, 0.5)), latencyMax: r3(q(latency, 1)), windows: realtime, hourEnd }
  report.errors = errors

  await Bun.write(resolve(out, `${label}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, (k, v) => (k === "worstLoaf" || k === "playedById" ? undefined : v), 1))
} finally {
  await browser.close()
  await server.close()
}
