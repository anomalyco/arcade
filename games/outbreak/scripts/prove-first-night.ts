import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { DEFAULT_PACING_TUNING, type AIConfig } from "../shared/ai"
import { TICK_DT } from "../shared/clock"
import { CoopSim, SPAWN_POINTS, type SurvivorSlot } from "../shared/coop-sim"
import type { Command } from "../shared/session"

const game = resolve(import.meta.dir, "..")
const out = resolve(game, "../../captures/outbreak-first-night")
mkdirSync(out, { recursive: true })

type WaypointStep = {
  until: number
  x: number
  y: number
  aim?: number
  sprint?: boolean
  interactAtArrival?: boolean
  smashAtArrival?: boolean
  benchResearch?: boolean
  loudShotAt?: number
}

const SOLO_ROUTE: readonly WaypointStep[] = [
  // 0..6 s: walk from spawn (27.7, 41) to Ash House front door (27.7, 36.1) and open it
  { until: 5.5, x: 27.7, y: 36.1, aim: -Math.PI / 2, interactAtArrival: true },
  // 6..13 s: enter Ash living room, walk to shelf (23.35, 30.8) and search quietly
  { until: 13.0, x: 23.35, y: 30.8, aim: -Math.PI / 2, interactAtArrival: true },
  // 13..20 s: walk to kitchen counter (35.3, 33.5) and search quietly
  { until: 20.0, x: 35.3, y: 33.5, aim: 0, interactAtArrival: true },
  // 20..24 s: open Ash bedroom door (27.7, 30.2)
  { until: 24.0, x: 27.7, y: 30.2, aim: -Math.PI / 2, interactAtArrival: true },
  // 24..31 s: search bedroom dresser (29.55, 25.7)
  { until: 31.0, x: 29.55, y: 25.7, aim: -Math.PI / 2, interactAtArrival: true },
  // 31..39 s: reach Ash workbench (30.05, 26.3), install parts by the last daylight and the flashlight
  { until: 39.0, x: 30.05, y: 26.3, aim: 0, interactAtArrival: true, benchResearch: true },
  // 39..46 s: walk back out of Ash House to front porch/street
  { until: 46.0, x: 27.7, y: 37.5, aim: Math.PI / 2 },
  // 46..85 s: step onto street (32.5, 42.5) at dusk -> First Encounter of 1–3 zombies!
  { until: 85.0, x: 33.5, y: 42.8, aim: 0 },
  // 85..150 s: explore South across the street to Elm House (26.7, 66.2 -> 26.7, 61.5)
  { until: 115.0, x: 26.7, y: 66.2, aim: -Math.PI / 2, interactAtArrival: true },
  { until: 155.0, x: 26.7, y: 61.5, aim: -Math.PI / 2, interactAtArrival: true },
  // 155..220 s: explore Central Crossroads (44, 44) & North Avenue (44, 28)
  { until: 190.0, x: 44.0, y: 44.0, aim: 0 },
  { until: 225.0, x: 44.0, y: 28.0, aim: -Math.PI / 2 },
  // 225..310 s: explore East Commercial Strip (Hardware Store frontage & interior, smash container at 265 s)
  { until: 255.0, x: 58.7, y: 38.7, aim: -Math.PI / 2, interactAtArrival: true },
  { until: 310.0, x: 58.7, y: 34.2, aim: -Math.PI / 2, smashAtArrival: true },
  // 310..390 s: explore South-East Pharmacy (58.7, 68.7 -> 58.7, 63.5)
  { until: 350.0, x: 58.7, y: 68.7, aim: -Math.PI / 2, interactAtArrival: true },
  { until: 395.0, x: 58.7, y: 63.5, aim: -Math.PI / 2, interactAtArrival: true },
  // 395..600 s: Late-night high-tension street patrol & loud gunshots (420 s, 480 s, 540 s)
  { until: 455.0, x: 44.0, y: 44.0, aim: 0, sprint: true, loudShotAt: 425 },
  { until: 525.0, x: 32.0, y: 44.0, aim: Math.PI, sprint: true, loudShotAt: 485 },
  { until: 600.0, x: 46.0, y: 44.0, aim: 0, sprint: true, loudShotAt: 545 },
]

export type TimeSample = {
  t: number
  hour: number
  threat: number
  ramp: number
  within15m: number
  within30m: number
  within60m: number
  activeChasers: number
  livingZombies: number
  effectiveMaxActive: number
}

export type WindowSummary = {
  label: string
  meanWithin15m: number
  maxWithin15m: number
  meanWithin30m: number
  meanWithin60m: number
  meanChasers: number
  maxChasers: number
}

export type RunReport = {
  mode: "solo" | "coop-4p"
  variant: "before" | "after"
  zombiesWithin15mAtStart: number
  zombiesWithin30mAtStart: number
  zombiesWithin60mAtStart: number
  meanWithin15mFirst60s: number
  firstContactTimeSeconds: number | null
  nightfallTimeSeconds: number | null
  firstEncounterChaserCount: number
  meanSimultaneousChasers: number
  p95SimultaneousChasers: number
  peakSimultaneousChasers: number
  containersSearchedBeforeFirstContact: number
  workbenchReachedBeforeFirstContact: boolean
  workbenchLightAtArrival: number
  inViewSpawns: number
  behindPlayerSpawns: number
  windows: WindowSummary[]
  samplesEvery30s: TimeSample[]
}

const avg = (xs: readonly number[]) =>
  xs.length === 0 ? 0 : Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2))
const quantile = (xs: readonly number[], q: number) => {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!
}

function runTenMinuteSimulation(mode: "solo" | "coop-4p", variant: "before" | "after"): RunReport {
  const playerCount = mode === "solo" ? 1 : 4
  const aiConfig: Partial<AIConfig> =
    variant === "before"
      ? {
          directorPacing: 0,
          safeRadius: 3.5,
          initialDensity: 1.0,
          startHour: 18.0,
          rampTime: 360,
          noiseSensitivity: 1.0,
          maxActiveNearPlayer: 100,
        }
      : {
          directorPacing: 1,
          safeRadius: 20,
          initialDensity: 0.25,
          startHour: DEFAULT_PACING_TUNING.startHour,
          openingClock: DEFAULT_PACING_TUNING.openingClock,
          rampTime: 360,
          noiseSensitivity: 1.0,
          maxActiveNearPlayer: 4,
        }

  const sim = new CoopSim(7, 7, 0.22, aiConfig)
  const slots: SurvivorSlot[] = []
  for (let i = 0; i < playerCount; i++) {
    slots.push(sim.addSurvivor(i === 0 ? "player" : `p${i}`, i))
  }

  // Ensure initial telemetry is evaluated for t = 0
  sim.ai.pacing.stepAfterCrowd(
    sim.ai.nav,
    sim.ai.agents,
    slots.map((s) => s.survivor),
    sim.ai.config,
    0,
    false,
  )

  const t0Tel = { ...sim.ai.pacing.telemetry }
  const samples: TimeSample[] = [
    {
      t: 0,
      hour: Number(sim.hour.toFixed(2)),
      threat: Number(t0Tel.threat.toFixed(3)),
      ramp: Number(t0Tel.ramp.toFixed(3)),
      within15m: t0Tel.within15m,
      within30m: t0Tel.within30m,
      within60m: t0Tel.within60m,
      activeChasers: t0Tel.activeChasers,
      livingZombies: t0Tel.livingPopulation,
      effectiveMaxActive: t0Tel.effectiveMaxActive,
    },
  ]

  let firstContactTime: number | null = null
  let nightfallTime: number | null = sim.hour >= 18 ? 0 : null
  let firstEncounterPeakChasers = 0
  let containersSearchedBeforeContact = 0
  let workbenchReachedBeforeContact = false
  let workbenchLightAtArrival = 0
  let measureBenchLight = false
  const arrivedSteps = new Set<string>()
  const firedStepShots = new Set<string>()

  const totalTicks = 600 * 60 // 10 minutes at 60 Hz = 36,000 ticks
  for (let tick = 1; tick <= totalTicks; tick++) {
    const t = tick * TICK_DT

    for (let sIdx = 0; sIdx < slots.length; sIdx++) {
      const slot = slots[sIdx]!
      const p = slot.survivor
      // Keep survivor ammo & health topped up for the deterministic 10-minute telemetry probe
      if (p.health < 50) p.health = 100
      if (p.reserveAmmo < 12) {
        sim.progression.ledger.apply({ kind: "grant", actor: slot.id, item: "ammo", count: 12 })
      }

      const wpIndex = SOLO_ROUTE.findIndex((w) => t <= w.until)
      const wp = SOLO_ROUTE[wpIndex >= 0 ? wpIndex : SOLO_ROUTE.length - 1]!
      const offsetAngle = (sIdx * Math.PI) / 2
      const offsetR = sIdx === 0 ? 0 : 1.15
      const goalX = wp.x + Math.cos(offsetAngle) * offsetR
      const goalY = wp.y + Math.sin(offsetAngle) * offsetR

      const dx = goalX - p.x
      const dy = goalY - p.y
      const dist = Math.hypot(dx, dy)
      let mx = 0
      let my = 0
      let aim = wp.aim ?? p.aim
      let interact = false
      let sprint = Boolean(wp.sprint && dist > 2.0)
      let fire = false
      let melee = false
      let reload = false
      let flashlight = false

      if (dist > 0.35 && !p.channel) {
        mx = dx / dist
        my = dy / dist
        aim = Math.atan2(dy, dx)
        // Open any closed door blocking the survivor's step
        if (slot.prompt?.kind === "door" && slot.prompt.primary.label === "Open" && tick % 15 === 0) {
          interact = true
        }
      } else {
        const stepKey = `${sIdx}:${wpIndex}`
        if (!arrivedSteps.has(stepKey)) {
          arrivedSteps.add(stepKey)
          if (wp.interactAtArrival || wp.smashAtArrival) {
            interact = true
            if (wp.smashAtArrival) sprint = true
            if (firstContactTime === null && slot.prompt?.kind === "container") {
              containersSearchedBeforeContact++
            }
          }
          if (wp.benchResearch && sIdx === 0) {
            // At dusk the daylight is nearly gone: switch the flashlight on to work, as the bench prompt asks
            if (!p.flashlightOn && variant === "after") flashlight = true
            measureBenchLight = true
            if (firstContactTime === null) {
              workbenchReachedBeforeContact = true
            }
          }
        }
      }

      if (wp.loudShotAt && Math.abs(t - wp.loudShotAt) < 0.1 && !firedStepShots.has(`${sIdx}:${wp.loudShotAt}`)) {
        firedStepShots.add(`${sIdx}:${wp.loudShotAt}`)
        sim.progression.pistol(slot.id).fill()
        sim.progression.project(slot)
        fire = true
        // Also alert nearby roamers within 28 m to the loud gunshot in the street
        for (const z of sim.ai.agents) {
          if (z.state === "dead") continue
          if (Math.hypot(z.x - p.x, z.y - p.y) <= 28) {
            z.state = "chase"
            z.awareness = 1
            z.targetX = p.x
            z.targetY = p.y
          }
        }
      }

      // Engage close chasing zombies after leaving the safehouse (or in legacy mode when attacked)
      if ((t >= 44 || variant === "before") && !p.channel && tick % 18 === (sIdx * 4) % 18) {
        let closestZ: { id: number; x: number; y: number; d: number; state: string } | null = null
        for (let zIdx = 0; zIdx < sim.ai.agents.length; zIdx++) {
          const z = sim.ai.agents[zIdx]!
          if (z.state === "dead") continue
          const zd = Math.hypot(z.x - p.x, z.y - p.y)
          if (
            zd < 6.5 &&
            (z.state === "chase" || z.state === "alert" || zd < 2.2) &&
            (!closestZ || zd < closestZ.d)
          ) {
            closestZ = { id: z.id, x: z.x, y: z.y, d: zd, state: z.state }
          }
        }
        if (closestZ) {
          aim = Math.atan2(closestZ.y - p.y, closestZ.x - p.x)
          if (closestZ.d < 1.65 && p.shoveCooldown <= 0) {
            melee = true
          } else if (closestZ.d < 5.5 && p.magAmmo > 0 && p.fireCooldown <= 0 && t >= 48) {
            fire = true
          } else if (p.magAmmo === 0 && p.reloadRemaining <= 0) {
            reload = true
          }
        }
      }

      const cmd: Command = { mx, my, aim, interact, sprint, fire, melee, reload, flashlight }
      sim.stepSurvivor(slot, cmd, TICK_DT)
    }

    sim.stepWorld(TICK_DT, 120)

    if (nightfallTime === null && sim.hour >= 18) nightfallTime = Number(t.toFixed(2))
    if (measureBenchLight) {
      measureBenchLight = false
      workbenchLightAtArrival = Number(
        sim.progression.benchLight("bench:ash", sim.hour, slots.map((s) => s.survivor)).toFixed(3),
      )
    }
    const tel = sim.ai.pacing.telemetry
    if (tel.activeChasers > 0 && firstContactTime === null) {
      firstContactTime = Number(t.toFixed(2))
    }
    if (firstContactTime !== null && t <= firstContactTime + 15) {
      firstEncounterPeakChasers = Math.max(firstEncounterPeakChasers, tel.activeChasers)
    }

    if (tick % 60 === 0) {
      samples.push({
        t: Math.round(t),
        hour: Number(sim.hour.toFixed(2)),
        threat: Number(tel.threat.toFixed(3)),
        ramp: Number(tel.ramp.toFixed(3)),
        within15m: tel.within15m,
        within30m: tel.within30m,
        within60m: tel.within60m,
        activeChasers: tel.activeChasers,
        livingZombies: tel.livingPopulation,
        effectiveMaxActive: tel.effectiveMaxActive,
      })
    }
  }

  const windowDefs: readonly [string, number, number][] = [
    ["0–30s (Safehouse & Workbench)", 0, 30],
    ["30–90s (Dusk & First Encounter)", 30, 90],
    ["90–180s (Early Night Block Exploration)", 90, 180],
    ["180–360s (Mid-Night Ramp)", 180, 360],
    ["360–600s (Late Night & Loud Noise)", 360, 600],
  ]

  const windows: WindowSummary[] = windowDefs.map(([label, t0, t1]) => {
    const sub = samples.filter((s) => s.t >= t0 && s.t <= t1)
    return {
      label,
      meanWithin15m: avg(sub.map((s) => s.within15m)),
      maxWithin15m: Math.max(...sub.map((s) => s.within15m)),
      meanWithin30m: avg(sub.map((s) => s.within30m)),
      meanWithin60m: avg(sub.map((s) => s.within60m)),
      meanChasers: avg(sub.map((s) => s.activeChasers)),
      maxChasers: Math.max(...sub.map((s) => s.activeChasers)),
    }
  })

  const chaserSeries = samples.map((s) => s.activeChasers)
  const first60 = samples.filter((s) => s.t <= 60)

  return {
    mode,
    variant,
    zombiesWithin15mAtStart: samples[0]!.within15m,
    zombiesWithin30mAtStart: samples[0]!.within30m,
    zombiesWithin60mAtStart: samples[0]!.within60m,
    meanWithin15mFirst60s: avg(first60.map((s) => s.within15m)),
    firstContactTimeSeconds: firstContactTime,
    nightfallTimeSeconds: nightfallTime,
    firstEncounterChaserCount: firstEncounterPeakChasers,
    meanSimultaneousChasers: avg(chaserSeries),
    p95SimultaneousChasers: quantile(chaserSeries, 0.95),
    peakSimultaneousChasers: Math.max(...chaserSeries),
    containersSearchedBeforeFirstContact: containersSearchedBeforeContact,
    workbenchReachedBeforeFirstContact: workbenchReachedBeforeContact,
    workbenchLightAtArrival,
    inViewSpawns: sim.ai.pacing.inViewSpawns,
    behindPlayerSpawns: sim.ai.pacing.behindSpawns,
    windows,
    samplesEvery30s: samples.filter((s) => s.t % 30 === 0),
  }
}

const soloBefore = runTenMinuteSimulation("solo", "before")
const soloAfter = runTenMinuteSimulation("solo", "after")
const coopBefore = runTenMinuteSimulation("coop-4p", "before")
const coopAfter = runTenMinuteSimulation("coop-4p", "after")

// Verify all pacing & spawn invariants
assert.equal(soloAfter.zombiesWithin15mAtStart, 0, "Solo After must have 0 zombies within 15 m at start")
assert(
  soloAfter.zombiesWithin30mAtStart < soloBefore.zombiesWithin30mAtStart,
  "Solo After must have fewer zombies within 30 m at start than Before",
)
assert(
  (soloAfter.firstContactTimeSeconds ?? 0) >= 40,
  `Expected first contact >= 40 s in Solo After, got ${soloAfter.firstContactTimeSeconds}`,
)
assert(
  (coopAfter.firstContactTimeSeconds ?? 0) >= 40,
  `Expected first contact >= 40 s in 4p co-op After, got ${coopAfter.firstContactTimeSeconds}`,
)
assert.equal(coopAfter.workbenchReachedBeforeFirstContact, true, "4p co-op must reach the workbench before first contact")
assert(
  (soloBefore.firstContactTimeSeconds ?? 999) < 5,
  `Expected immediate contact < 5 s in Solo Before, got ${soloBefore.firstContactTimeSeconds}`,
)
assert.equal(soloAfter.workbenchReachedBeforeFirstContact, true, "Player must reach workbench before first contact")
assert(soloAfter.workbenchLightAtArrival >= 0.35, "Dusk start must light the workbench (daylight + flashlight) >= 0.35 at arrival")
for (const run of [soloAfter, coopAfter]) {
  assert(
    run.nightfallTimeSeconds !== null && run.nightfallTimeSeconds >= 50 && run.nightfallTimeSeconds <= 70,
    `Expected nightfall (18:00) about a minute in (${run.mode}), got ${run.nightfallTimeSeconds}`,
  )
}
assert(
  soloAfter.firstEncounterChaserCount >= 1 && soloAfter.firstEncounterChaserCount <= 3,
  `Expected 1–3 chasers in first encounter, got ${soloAfter.firstEncounterChaserCount}`,
)
assert(
  soloAfter.peakSimultaneousChasers <= 5 && soloAfter.peakSimultaneousChasers < soloBefore.peakSimultaneousChasers,
  `Expected Solo After peak chasers (${soloAfter.peakSimultaneousChasers}) < Solo Before (${soloBefore.peakSimultaneousChasers})`,
)
assert(
  coopAfter.peakSimultaneousChasers > soloAfter.peakSimultaneousChasers &&
    coopAfter.peakSimultaneousChasers < coopBefore.peakSimultaneousChasers,
  `Expected 4p co-op peak chasers (${coopAfter.peakSimultaneousChasers}) to scale above solo (${soloAfter.peakSimultaneousChasers}) and stay below unpaced (${coopBefore.peakSimultaneousChasers})`,
)
assert.equal(soloAfter.inViewSpawns, 0, "Zero in-view spawns allowed")
assert.equal(soloAfter.behindPlayerSpawns, 0, "Zero behind-player spawns allowed")
assert.equal(coopAfter.inViewSpawns, 0, "Zero in-view spawns allowed in 4p co-op")
assert.equal(coopAfter.behindPlayerSpawns, 0, "Zero behind-player spawns allowed in 4p co-op")

// The four deterministic ten-minute sweeps run in Bun. Pixels are an explicit follow-up.
const simPayload = {
  solo: { before: soloBefore, after: soloAfter },
  coop4p: { before: coopBefore, after: coopAfter },
}
writeFileSync(resolve(out, "pacing-10m-proof.json"), JSON.stringify(simPayload, null, 2) + "\n")
console.log(JSON.stringify(simPayload, null, 2))

if (process.argv.includes("--capture")) {
const { browserBudget } = await import("../../../scripts/browser-budget")
// Optional headless Metal WebGPU captures.
const build = Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" })
assert.equal(build.exitCode, 0)
await using budget = browserBudget()
const { chromium } = budget

const root = resolve(game, "dist/arcade/outbreak")
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 })
  },
})

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(chrome, "Install Chromium before the Metal proof")

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const captures: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })

  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench`, { waitUntil: "networkidle" })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/)

  const snap = async (name: string) => {
    const file = `${name}.png`
    await page.screenshot({ path: resolve(out, file) })
    captures.push(file)
  }

  // 1. Before (t = 0, 18:00, unpaced): lawn & Ash interior zombies immediately around spawn
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLab("timeScale", 0)
    h.setLab("zoom", 38)
    h.setLab("aiDebugOverlay", true)
    await h.stagePacing("legacy-rush")
    for (let i = 0; i < 6; i++) await h.step(1 / 60)
  })
  await snap("01-before-t0-street-rush")

  // 2. After (t = 0, 17:30 dusk, 20 m safe radius, 0.25 initial density): clear safehouse & lawn
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLab("timeScale", 0)
    h.setLab("zoom", 38)
    h.setLab("aiDebugOverlay", true)
    await h.stagePacing("opening-calm")
    for (let i = 0; i < 6; i++) await h.step(1 / 60)
  })
  await snap("02-after-t0-dusk-safe")

  // 3. After (t = 35 s, 17:48): inside Ash House at the workbench, lit by the last daylight and the flashlight
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLab("timeScale", 0)
    h.setLab("zoom", 34)
    h.setLab("aiDebugOverlay", false)
    await h.stagePacing("safehouse-workbench")
    for (let i = 0; i < 6; i++) await h.step(1 / 60)
  })
  await snap("03-after-t35-safehouse-workbench")

  // 4. After (t = 55 s, 17:50 dusk): first scripted encounter of 2 shamblers approaching street outside Ash House
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLab("timeScale", 0)
    h.setLab("zoom", 40)
    h.setLab("aiDebugOverlay", true)
    await h.stagePacing("first-contact")
    for (let i = 0; i < 8; i++) await h.step(1 / 60)
  })
  await snap("04-after-t55-first-encounter")

  // 5. After (t = 420 s, 22:30 late night): full nocturnal threat & gunshot wave capped by maxActiveNearPlayer
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLab("timeScale", 0)
    h.setLab("zoom", 42)
    h.setLab("aiDebugOverlay", true)
    await h.stagePacing("late-night-horde")
    for (let i = 0; i < 8; i++) await h.step(1 / 60)
  })
  await snap("05-after-t420-late-night-capped")

  // 6. Lab panel showing the Pacing group controls
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLab("aiDebugOverlay", false)
    h.stagePacing("opening-calm")
    await h.step(1 / 60)
  })
  await page.keyboard.press("Backquote")
  await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-field="safeRadius"]')
    row?.scrollIntoView({ block: "center" })
  })
  await snap("06-lab-pacing-group")

  assert.deepEqual(errors, [])

  const proofPayload = {
    adapter,
    captures,
    solo: { before: soloBefore, after: soloAfter },
    coop4p: { before: coopBefore, after: coopAfter },
  }
  writeFileSync(resolve(out, "pacing-10m-proof.json"), JSON.stringify(proofPayload, null, 2) + "\n")
  console.log(
    JSON.stringify(
      {
        adapter,
        captures,
        soloSummary: {
          within15mAtStart: `${soloBefore.zombiesWithin15mAtStart} → ${soloAfter.zombiesWithin15mAtStart}`,
          within30mAtStart: `${soloBefore.zombiesWithin30mAtStart} → ${soloAfter.zombiesWithin30mAtStart}`,
          within60mAtStart: `${soloBefore.zombiesWithin60mAtStart} → ${soloAfter.zombiesWithin60mAtStart}`,
          meanWithin15mFirst60s: `${soloBefore.meanWithin15mFirst60s} → ${soloAfter.meanWithin15mFirst60s}`,
          firstContactTimeSeconds: `${soloBefore.firstContactTimeSeconds}s → ${soloAfter.firstContactTimeSeconds}s`,
          nightfallTimeSeconds: `${soloBefore.nightfallTimeSeconds}s → ${soloAfter.nightfallTimeSeconds}s`,
          firstEncounterChasers: `${soloBefore.firstEncounterChaserCount} → ${soloAfter.firstEncounterChaserCount}`,
          meanSimultaneousChasers: `${soloBefore.meanSimultaneousChasers} → ${soloAfter.meanSimultaneousChasers}`,
          p95SimultaneousChasers: `${soloBefore.p95SimultaneousChasers} → ${soloAfter.p95SimultaneousChasers}`,
          peakSimultaneousChasers: `${soloBefore.peakSimultaneousChasers} → ${soloAfter.peakSimultaneousChasers}`,
          workbenchLightAtArrival: `${soloBefore.workbenchLightAtArrival} → ${soloAfter.workbenchLightAtArrival}`,
          inViewSpawns: soloAfter.inViewSpawns,
          behindPlayerSpawns: soloAfter.behindPlayerSpawns,
        },
        coop4pSummary: {
          within15mAtStart: `${coopBefore.zombiesWithin15mAtStart} → ${coopAfter.zombiesWithin15mAtStart}`,
          within30mAtStart: `${coopBefore.zombiesWithin30mAtStart} → ${coopAfter.zombiesWithin30mAtStart}`,
          within60mAtStart: `${coopBefore.zombiesWithin60mAtStart} → ${coopAfter.zombiesWithin60mAtStart}`,
          meanWithin15mFirst60s: `${coopBefore.meanWithin15mFirst60s} → ${coopAfter.meanWithin15mFirst60s}`,
          firstContactTimeSeconds: `${coopBefore.firstContactTimeSeconds}s → ${coopAfter.firstContactTimeSeconds}s`,
          nightfallTimeSeconds: `${coopBefore.nightfallTimeSeconds}s → ${coopAfter.nightfallTimeSeconds}s`,
          firstEncounterChasers: `${coopBefore.firstEncounterChaserCount} → ${coopAfter.firstEncounterChaserCount}`,
          meanSimultaneousChasers: `${coopBefore.meanSimultaneousChasers} → ${coopAfter.meanSimultaneousChasers}`,
          p95SimultaneousChasers: `${coopBefore.p95SimultaneousChasers} → ${coopAfter.p95SimultaneousChasers}`,
          peakSimultaneousChasers: `${coopBefore.peakSimultaneousChasers} → ${coopAfter.peakSimultaneousChasers}`,
          inViewSpawns: coopAfter.inViewSpawns,
          behindPlayerSpawns: coopAfter.behindPlayerSpawns,
        },
        soloWindowsBefore: soloBefore.windows,
        soloWindowsAfter: soloAfter.windows,
        coopWindowsBefore: coopBefore.windows,
        coopWindowsAfter: coopAfter.windows,
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
  fixture.stop(true)
}
}
