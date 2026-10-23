/// <reference types="@webgpu/types" />
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../browser-budget"
import { createServer, type ViteDevServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "../..")
const out = resolve(process.env.CAR_PROOF_OUT ?? resolve(root, "captures/lab-car-playground"))
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium_headless_shell-\d+$/.test(n))
  .reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const servers: ViteDevServer[] = []
const errors: string[] = []
const report: Record<string, unknown> = {}

try {
  const hosts: { game: string; url: string }[] = []
  for (const game of ["getaway", "blackout"] as const) {
    const dir = resolve(root, "games/lab") // One Lab app; both former hosts load the same sections
    const server = await createServer({
      root: dir,
      configFile: resolve(dir, "vite.config.ts"),
      server: { host: "127.0.0.1", port: 0 },
    })
    servers.push(server)
    await server.listen()
    const addr = server.httpServer!.address()
    if (!addr || typeof addr === "string") throw new Error("No fixture port")
    hosts.push({ game, url: `http://127.0.0.1:${addr.port}` })
  }

  // 0. Capture matched BEFORE (skids disabled / no skid adapter) vs AFTER at native game scale (1280x800)
  {
    for (const variant of ["before", "after"] as const) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
      page.on("pageerror", e => errors.push(`pair-${variant}: ${e.message}`))
      await page.goto(`${hosts[0]!.url}/?bench`)
      await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 45000 })
      const step = async (n: number) => {
        for (let i = 0; i < n; i++) {
          await page.evaluate(async () => {
            ;(window as any).lab.advance(1 / 60)
            await (window as any).lab.render()
          })
        }
      }
      await page.locator('[data-catalog-id="fixture:car-cones"]').click()
      if (variant === "before") {
        await page.getByRole("checkbox", { name: "Skid marks", exact: true }).uncheck()
      }
      await step(2)
      await page.locator("canvas").focus()
      await page.keyboard.press("p")
      // Identical driving + drift + handbrake sequence
      await page.keyboard.down("Shift")
      await page.keyboard.down("w")
      await step(38)
      await page.keyboard.up("Shift")
      await page.keyboard.down("a")
      await page.keyboard.down("Space")
      await step(34)
      await page.keyboard.up("Space")
      await page.keyboard.up("a")
      await page.keyboard.down("d")
      await page.keyboard.down("s")
      await step(22)
      await page.keyboard.up("s")
      await page.keyboard.up("d")
      await page.keyboard.up("w")
      await page.keyboard.press("Escape")
      await step(2)
      // Frame at identical native game scale looking at the car & skid trail
      await page.evaluate(async () => {
        const l = (window as any).lab
        const ch = l.spawn.inspect().character
        l.context.stage.frameTarget(ch.x + 1.5, 0.3, ch.z + 4.5, 19)
        await l.render()
      })
      await page.screenshot({ path: resolve(out, `${variant}-car-skids-1280x800.png`) })
      // Also capture full-bleed canvas without sidebars (`Backquote`) for direct pixel comparison
      await page.locator("canvas").focus()
      await page.keyboard.press("Backquote")
      await page.evaluate(async () => await (window as any).lab.render())
      await page.screenshot({ path: resolve(out, `${variant}-canvas-native-1280x800.png`) })
      await page.close()
    }
  }

  // 1–5. Full behavioral verification across BOTH hosts (Getaway & Blackout)
  for (const [hostIdx, { game, url }] of hosts.entries()) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
    page.on("pageerror", e => errors.push(`${game}: ${e.message}`))
    page.on("console", m => {
      if (m.type() === "error" && !m.text().includes("404")) errors.push(`${game}: ${m.text()}`)
    })

    await page.goto(`${url}/?bench`)
    await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 45000 })
    const adapter = await page.evaluate(() => {
      const a = (window as any).lab.adapter
      return { vendor: a.vendor, architecture: a.architecture }
    })
    assert.match(adapter.architecture, /metal/i, "Metal WebGPU required")

    const step = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await page.evaluate(async () => {
          ;(window as any).lab.advance(1 / 60)
          await (window as any).lab.render()
        })
      }
    }
    const inspectSpawn = () => page.evaluate(() => (window as any).lab.spawn.inspect())

    // Load Car into cones in Proving Yard
    await page.locator('[data-catalog-id="fixture:car-cones"]').click()
    await step(2)
    await page.locator("canvas").focus()
    await page.keyboard.press("p")

    // A. Nitro launch produces launch marks and tyre smoke
    await page.keyboard.down("Shift")
    await page.keyboard.down("w")
    await step(28)
    await page.keyboard.up("Shift")
    const afterLaunch = await inspectSpawn()
    assert(afterLaunch.skids > 0, `${game}: nitro launch must produce skid marks`)
    assert(afterLaunch.tyreSmoke > 0, `${game}: nitro launch must produce tyre smoke`)

    // B. Straight grip cruise (after launch spin decays, no steering/handbrake) produces 0 new skid marks
    await step(55) // let 1.25s launch spin expire while cruising straight
    await page.evaluate(() => {
      const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
      const clearBtn = s.controls.find((c: any) => c.key === "clearSkids")
      clearBtn.run()
    })
    const beforeCruise = await inspectSpawn()
    assert.equal(beforeCruise.skids, 0, "Skids cleared before straight cruise check")
    await step(25) // straight throttle cruise with zero steering
    const afterCruise = await inspectSpawn()
    assert.equal(afterCruise.skids, 0, `${game}: straight gripping cruise must not paint skid marks`)

    // C. Drift + Handbrake + Hard Braking produce connected skid marks
    await page.keyboard.down("a")
    await page.keyboard.down("Space")
    await step(35)
    await page.keyboard.up("Space")
    const afterDrift = await inspectSpawn()
    assert(afterDrift.skids > 20, `${game}: drift + handbrake must paint connected skid marks (got ${afterDrift.skids})`)
    await page.keyboard.up("a")
    await page.keyboard.up("w")

    // Hard braking with S at forward speed
    const skidsBeforeBrake = afterDrift.skids
    await page.keyboard.down("s")
    await step(18)
    await page.keyboard.up("s")
    const afterHardBrake = await inspectSpawn()
    assert(afterHardBrake.skids > skidsBeforeBrake, `${game}: hard braking at speed must add skid marks`)

    // Exit Play mode
    await page.keyboard.press("Escape")
    await step(1)
    assert.equal((await inspectSpawn()).character.input.throttle, 0, "Esc released throttle")

    // D. Exact value edit on Skid width in Vehicle & Skids inspector
    const skidWidthSlider = page.getByRole("slider", { name: "Skid width", exact: true })
    await skidWidthSlider.focus()
    await page.keyboard.press("Enter")
    await page.getByRole("textbox", { name: "Exact Skid width" }).fill("0.24")
    await page.keyboard.press("Enter")
    const updatedWidth = await page.evaluate(() => (window as any).lab.sections.find((s: any) => s.id === "spawn").settings.skidWidth)
    assert.equal(updatedWidth, 0.24, "Exact value editor updated Skid width to 0.24m")

    // E. Airborne never paints the road
    await page.evaluate(() => {
      const l = (window as any).lab
      const s = l.sections.find((x: any) => x.id === "spawn")
      // Position car heading up the main jump ramp at (10, -3)
      s.moveObject("character:active", 10, 4, Math.PI)
      s.controls.find((c: any) => c.key === "clearSkids").run()
    })
    await page.locator("canvas").focus()
    await page.keyboard.press("p")
    await page.keyboard.down("Shift")
    await page.keyboard.down("w")
    let sawAirborne = false
    let skidsWhileAirborne = 0
    for (let i = 0; i < 65; i++) {
      await step(1)
      const st = await inspectSpawn()
      if (st.character.airborne) {
        if (!sawAirborne) {
          sawAirborne = true
          await page.evaluate(() => {
            const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
            s.controls.find((c: any) => c.key === "clearSkids").run()
          })
        } else {
          skidsWhileAirborne += st.skids
        }
      }
    }
    await page.keyboard.up("w")
    await page.keyboard.up("Shift")
    await page.keyboard.press("Escape")
    assert(sawAirborne, `${game}: car launched airborne off yard ramp`)
    assert.equal(skidsWhileAirborne, 0, `${game}: airborne car must never paint skid marks`)

    // F. Teleport / relocation while marking never draws kilometer segments
    await page.locator("canvas").focus()
    await page.keyboard.press("p")
    await page.keyboard.down("w")
    await page.keyboard.down("Space")
    await step(20)
    const beforeTeleportSkids = (await inspectSpawn()).skids
    await page.keyboard.press("Escape")
    await page.keyboard.up("w")
    await page.keyboard.up("Space")
    await page.evaluate(() => {
      const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
      s.moveObject("character:active", -18, 10, 0)
    })
    await step(5)
    const afterTeleportSkids = (await inspectSpawn()).skids
    assert.equal(afterTeleportSkids, beforeTeleportSkids, "Teleporting car resets wheel marking state without bridging segments")

    // G. Persistent Authoring World: switching Effects -> Lighting -> Objects keeps car, cones, and skids!
    await page.locator('[data-catalog-id="fixture:car-cones"]').click()
    await step(2)
    await page.locator("canvas").focus()
    await page.keyboard.press("p")
    await page.keyboard.down("w")
    await page.keyboard.down("a")
    await page.keyboard.down("Space")
    await step(40)
    await page.keyboard.up("Space")
    await page.keyboard.up("a")
    await page.keyboard.up("w")
    await page.keyboard.press("Escape")
    await step(2)
    const preSwitchState = await inspectSpawn()
    assert(preSwitchState.skids > 15, "Skids exist before switching categories")
    assert.equal(preSwitchState.items.props.length, 6, "5 cones + 1 propane exist before switching categories")

    // Switch to Effects category and trigger Grenade smoke in the same playground
    await page.getByRole("button", { name: "Category Effects", exact: true }).click()
    await page.locator('[data-catalog-id="effects:smoke"]').click()
    await step(25)
    const duringEffectsState = await page.evaluate(() => ({
      section: (window as any).lab.settings.section,
      volumes: (window as any).lab.context.volume.count,
      spawn: (window as any).lab.spawn.inspect(),
    }))
    assert.equal(duringEffectsState.section, "effects")
    assert(duringEffectsState.volumes > 0, "Smoke volume active in playground")
    assert(duringEffectsState.spawn.character !== null, "Car persisted while editing Effects")
    assert.equal(duringEffectsState.spawn.items.props.length, 6, "Placed cones/propane persisted while editing Effects")
    assert.equal(duringEffectsState.spawn.skids, preSwitchState.skids, "Skid marks persisted while editing Effects")
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-shared-playground-effects.png") })

    // Switch to Lighting category and apply Night Street look
    await page.getByRole("button", { name: "Category Lighting", exact: true }).click()
    await page.locator('[data-catalog-id="lighting-look:night_street"]').click()
    await step(5)
    const duringLightingState = await inspectSpawn()
    assert(duringLightingState.character !== null, "Car persisted while editing Lighting")
    assert.equal(duringLightingState.items.props.length, 6, "Props persisted while editing Lighting")

    // Select the Car from the Outliner (scene objects live there, not in the Library)
    await page.locator('.lab-outliner [data-object-id="character:active"]').click()
    await step(2)
    const backToCarState = await page.evaluate(() => ({
      section: (window as any).lab.settings.section,
      selected: (window as any).lab.sections.find((s: any) => s.id === "spawn").selectedObjectId,
      spawn: (window as any).lab.spawn.inspect(),
    }))
    assert.equal(backToCarState.section, "spawn")
    assert.equal(backToCarState.selected, "character:active")
    assert.equal(backToCarState.spawn.items.props.length, 6)
    assert.equal(backToCarState.spawn.skids, preSwitchState.skids)
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-select-car-inspector.png") })

    // H. Environment Switch (Proving Yard -> Getaway Street -> Proving Yard) & Deterministic Reset Scene
    const envPicker = page.getByRole("combobox", { name: "Scene environment", exact: true })
    await envPicker.selectOption("street")
    await step(5)
    const streetState = await inspectSpawn()
    assert.equal(streetState.environment, "street")
    assert.equal(streetState.skids, 0, "Transient skids cleared on environment change")
    assert.equal(streetState.character.speed, 0, "Car relocated cleanly to validated street spawn")
    // Drive & drift on Getaway Street
    await page.locator("canvas").focus()
    await page.keyboard.press("p")
    await page.keyboard.down("Shift")
    await page.keyboard.down("w")
    await step(25)
    await page.keyboard.down("Space")
    await step(20)
    await page.keyboard.up("Space")
    await page.keyboard.up("w")
    await page.keyboard.up("Shift")
    await page.keyboard.press("Escape")
    await step(2)
    const streetDriven = await inspectSpawn()
    assert(streetDriven.skids > 0, `${game}: car paints skids on switched Getaway Street environment`)
    if (hostIdx === 0) await page.screenshot({ path: resolve(out, "after-street-environment-skids.png") })

    // Switch back to Proving Yard and test Reset scene
    await envPicker.selectOption("yard")
    await step(2)
    await page.getByRole("button", { name: "Reset scene", exact: true }).click()
    await step(2)
    const afterResetScene = await inspectSpawn()
    assert.equal(afterResetScene.character.x, 0)
    assert.equal(afterResetScene.character.z, 8)
    assert.equal(afterResetScene.character.speed, 0)
    assert.equal(afterResetScene.skids, 0)
    assert.equal(afterResetScene.items.props.length, 6)

    // I. Close-up Muscle Car Fender, Lamp Mounts, Throttle Squat, Brake Dive & Kerb Roll Proof
    await page.evaluate(() => {
      const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
      s.moveObject("character:active", -12, 14, Math.PI)
      s.controls.find((c: any) => c.key === "clearSkids").run()
    })
    await step(5)
    const neutralChar = (await inspectSpawn()).character
    if (hostIdx === 0) {
      await page.locator("canvas").focus()
      await page.keyboard.press("Backquote")
      await page.evaluate(async () => {
        const l = (window as any).lab
        const ch = l.spawn.inspect().character
        const st = l.context.stage
        st.frameTarget(ch.x, 0.5, ch.z, 6.2)
        st.orbit(2.25, -0.22)
        await l.render()
      })
      await page.screenshot({ path: resolve(out, "closeup-front-fender.png") })
      await page.evaluate(async () => {
        const l = (window as any).lab
        const ch = l.spawn.inspect().character
        const st = l.context.stage
        st.frameTarget(ch.x, 0.5, ch.z, 6.2)
        st.camYaw = 0.65
        st.camPitch = 0.45
        await l.render()
      })
      await page.screenshot({ path: resolve(out, "closeup-rear-lamps.png") })
      await page.keyboard.press("Backquote")
    }

    // Throttle squat: accelerate hard on open lane and verify nose rises (headlampWorld.y > neutral) and tail squats (taillampWorld.y < neutral)
    await page.locator("canvas").focus()
    await page.keyboard.press("p")
    await page.keyboard.down("Shift")
    await page.keyboard.down("w")
    await step(12)
    const squatChar = (await inspectSpawn()).character
    await page.keyboard.up("Shift")
    await page.keyboard.up("w")
    await page.keyboard.press("Escape")
    assert(squatChar.pitch < -0.01, `${game}: throttle squat pitches nose up (pitch=${squatChar.pitch})`)
    assert(squatChar.headlampWorld[1] > neutralChar.headlampWorld[1] + 0.01, `${game}: headlamp rises with throttle squat`)
    assert(squatChar.taillampWorld[1] < neutralChar.taillampWorld[1] - 0.01, `${game}: taillamp squats with throttle squat`)
    if (hostIdx === 0) {
      await page.locator("canvas").focus()
      await page.keyboard.press("Backquote")
      await page.evaluate(async () => {
        const l = (window as any).lab
        const ch = l.spawn.inspect().character
        l.context.stage.frameTarget(ch.x, 0.5, ch.z, 6.4)
        l.context.stage.camYaw = 1.95
        l.context.stage.camPitch = 0.46
        await l.render()
      })
      await page.screenshot({ path: resolve(out, "closeup-throttle-squat.png") })
      await page.keyboard.press("Backquote")
    }

    // Brake dive: accelerate to speed on open lane then slam brake (S) and verify nose dives (headlampWorld.y < neutral) and tail rises
    await page.locator("canvas").focus()
    await page.keyboard.press("p")
    await page.keyboard.down("w")
    await step(35)
    await page.keyboard.up("w")
    await page.keyboard.down("s")
    await step(12)
    const diveChar = (await inspectSpawn()).character
    await page.keyboard.up("s")
    await page.keyboard.press("Escape")
    assert(diveChar.pitch > 0.01, `${game}: brake dive pitches nose down (pitch=${diveChar.pitch})`)
    assert(diveChar.headlampWorld[1] < neutralChar.headlampWorld[1] - 0.01, `${game}: headlamp dips with brake dive`)
    assert(diveChar.taillampWorld[1] > neutralChar.taillampWorld[1] + 0.01, `${game}: taillamp rises with brake dive`)
    if (hostIdx === 0) {
      await page.locator("canvas").focus()
      await page.keyboard.press("Backquote")
      await page.evaluate(async () => {
        const l = (window as any).lab
        const ch = l.spawn.inspect().character
        l.context.stage.frameTarget(ch.x, 0.5, ch.z, 6.4)
        l.context.stage.camYaw = 2.05
        l.context.stage.camPitch = 0.46
        await l.render()
      })
      await page.screenshot({ path: resolve(out, "closeup-brake-dive.png") })
      await page.keyboard.press("Backquote")
    }

    // Kerb / suspension step roll: straddle the edge of the suspension step at (x=15.75, z=10) so two wheels sit on the kerb
    await page.evaluate(() => {
      const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
      s.moveObject("character:active", 15.75, 10, Math.PI)
    })
    await step(45)
    const kerbChar = (await inspectSpawn()).character
    assert(Math.abs(kerbChar.roll) > 0.03, `${game}: straddling kerb tilts chassis roll (roll=${kerbChar.roll})`)
    if (hostIdx === 0) {
      await page.locator("canvas").focus()
      await page.keyboard.press("Backquote")
      await page.evaluate(async () => {
        const l = (window as any).lab
        const ch = l.spawn.inspect().character
        l.context.stage.frameTarget(ch.x, 0.5, ch.z, 6.4)
        l.context.stage.camYaw = 2.45
        l.context.stage.camPitch = 0.45
        await l.render()
      })
      await page.screenshot({ path: resolve(out, "closeup-kerb-roll.png") })
      await page.keyboard.press("Backquote")
    }

    // Restore default Skid width so shared state is clean
    await page.evaluate(() => {
      ;(window as any).lab.sections.find((s: any) => s.id === "spawn").settings.skidWidth = 0.16
    })

    report[game] = {
      adapter,
      actorCount: 1 + afterResetScene.items.props.length,
      launchSkids: afterLaunch.skids,
      launchTyreSmoke: afterLaunch.tyreSmoke,
      straightCruiseSkids: afterCruise.skids,
      driftAndHandbrakeSkids: afterDrift.skids,
      hardBrakeSkids: afterHardBrake.skids,
      skidBudget: afterHardBrake.skidBudget,
      smokeBudget: 1024,
      particleBudget: 4096,
      airborneSkids: skidsWhileAirborne,
      teleportBridgedSkids: afterTeleportSkids - beforeTeleportSkids,
      persistedAcrossTabs: {
        car: duringEffectsState.spawn.character !== null,
        props: duringEffectsState.spawn.items.props.length,
        skids: duringEffectsState.spawn.skids,
        smokeVolumes: duringEffectsState.volumes,
      },
      streetEnvironmentSkids: streetDriven.skids,
      resetRestoredOrigin: { x: afterResetScene.character.x, z: afterResetScene.character.z, props: afterResetScene.items.props.length },
      lampPoseProof: {
        neutralPitch: +neutralChar.pitch.toFixed(4),
        squatPitch: +squatChar.pitch.toFixed(4),
        divePitch: +diveChar.pitch.toFixed(4),
        kerbRoll: +kerbChar.roll.toFixed(4),
        squatHeadY: +squatChar.headlampWorld[1].toFixed(4),
        diveHeadY: +diveChar.headlampWorld[1].toFixed(4),
      },
    }
    await page.close()
  }

  if (errors.length) throw new Error(errors.join("\n"))
  writeFileSync(resolve(out, "car-playground-proof.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
  for (const s of servers) await s.close()
}
