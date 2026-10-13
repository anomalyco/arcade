/** Real browser mouse events against the running game, with manually clocked input ticks and a mocked room socket.
 * bun scripts/prove-fire-input.ts --base=http://blackout-fire.localhost:1355 --out=/path/to/proof.json
 * --baseline expects the first between-tick tap to be lost, against an unmodified baseline preview.
 */
import { chromium, type WebSocketRoute } from "playwright-core"
import { writeFileSync } from "node:fs"
import assert from "node:assert/strict"
import { decodeClient, encodeServer } from "../shared/protocol"
import { World } from "../shared/sim/world"
import { buildSnapshot, rosterOf } from "../shared/sim/view"
import { findChromeExecutable } from "./compare"

const opt = (key: string, fallback: string) => process.argv.find((s) => s.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const baseline = process.argv.includes("--baseline")
const browser = await chromium.launch({ executablePath: findChromeExecutable(), headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const results: object[] = []
try {
  for (const mode of ["local", "network"] as const) {
    const page = await browser.newPage({ viewport: { width: 960, height: 640 } })
    const errors: string[] = []
    await page.route("**/api/stats", (route) => route.fulfill({ json: { players: 1, games: 1 } }))
    page.on("pageerror", (e) => errors.push(e.message))
    page.on("console", (m) => { if (m.type() === "error" && !m.location().url.endsWith("favicon.ico")) errors.push(m.text()) })
    const server = new World(1)
    server.addHuman("tester", "tester", "sniper", "frag")
    const player = server.players.get("tester")!
    let socket: WebSocketRoute | undefined
    let received = 0, shots = 0
    let delivery: (() => void) | undefined
    await page.routeWebSocket("**/ws/**", (ws) => {
      socket = ws
      ws.onMessage((raw) => {
        const m = decodeClient(raw)
        if (m?.type === "hello") {
          ws.send(encodeServer({ type: "welcome", id: "tester", room: "proof" }))
          ws.send(encodeServer({ type: "roster", players: rosterOf(server) }))
          ws.send(encodeServer(buildSnapshot(server, "tester")))
        } else if (m?.type === "intent") {
          server.push("tester", m.seq, m.i)
          received++
          delivery?.()
          delivery = undefined
        }
      })
    })
    // Patch only the proof page's bootstrap: keep the actual renderer, Input, Game and session code.
    await page.route("**/src/main.ts", async (route) => {
      const response = await route.fetch()
      const hook = `
        import { Game as ProofGame } from '/src/game/game.ts';
        import { Sound as ProofSound } from '/src/audio/sound.ts';
        import { World as ProofWorld } from '/shared/sim/world.ts';
        import { Rng as ProofRng } from '/shared/rng.ts';
        const random = new ProofRng(7); Math.random = () => random.next();
        ProofSound.prototype.start = function() {};
        const proof = window.__fire = { paused: false, now: 10000, predicted: 0, authoritative: 0, events: [], sent: [] };
        const fire = ProofWorld.prototype.fire;
        ProofWorld.prototype.fire = function(p) { if(p.human) proof.authoritative++; return fire.call(this,p); };
        ProofSound.prototype.shot = function(g,x,y,mine) { if(mine) proof.predicted++; };
        const update = ProofGame.prototype.update;
        ProofGame.prototype.update = function(...args) {
          proof.game = this; proof.args = args;
          if (proof.paused) return;
          update.apply(this,args);
          if(this.alive) {
            proof.paused = true;
            proof.input = args[1];
            proof.now = args[5];
            performance.now = () => proof.now;
            const send = this.session.send.bind(this.session);
            this.session.send = m => { if(m.type === 'intent') proof.sent.push(m); send(m); };
            proof.step = () => { proof.now += 1000/30; this.acc = 0; this.session.acc = 0; update.call(this,1/30,proof.input,args[2],960,640,proof.now); };
          }
        };
        for (const type of ['mousedown','mouseup','dblclick']) addEventListener(type, e => {
          if(e.target.id === 'view') proof.events.push({type, trusted:e.isTrusted, detail:e.detail, at:Date.now()});
        },true);
      `
      await route.fulfill({ response, body: hook + await response.text() })
    })
    await page.addInitScript((mode) => {
      localStorage.setItem("blackout.gun", "sniper")
      if (mode === "network") sessionStorage.setItem("blackout.rejoin", "proof")
    }, mode)
    await page.goto(`${opt("base", "http://blackout-fire.localhost:1355")}/${mode === "local" ? "?practice&map=lot" : "?room=proof"}`)
    await page.waitForFunction(() => (window as any).__fire?.paused, null, { timeout: 30000 })
    if (mode === "local") await page.evaluate(() => {
      const w = (window as any).practice
      for (const p of [...w.players.values()] as any[]) if (!p.human) w.remove(p.id)
    })
    const step = async (n = 1) => {
      for (let k = 0; k < n; k++) {
        const done = mode === "network" ? new Promise<void>((resolve) => { delivery = resolve }) : Promise.resolve()
        await page.evaluate(() => (window as any).__fire.step())
        await Promise.race([done, new Promise((_, reject) => { const t = setTimeout(() => reject(Error("intent delivery timeout")), 3000); t.unref() })])
        if (mode === "network") {
          server.step()
          const events = server.takeEvents()
          shots += events.filter((e) => e.k === "shot" && e.by === "tester").length
          socket!.send(encodeServer(buildSnapshot(server, "tester")))
          socket!.send(encodeServer({ type: "ev", events }))
        }
      }
    }
    const counts = async () => {
      const p = await page.evaluate(() => {
        const p = (window as any).__fire
        return { predicted: p.predicted, authoritative: p.authoritative, sampled: p.sent.length }
      })
      return { ...p, authoritative: mode === "network" ? shots : p.authoritative }
    }
    await step(45) // Natural spawn/raise gates have elapsed before the click.
    const before = await counts()
    await page.mouse.move(700, 350)
    await page.mouse.down()
    await page.mouse.up()
    assert.equal((await counts()).sampled, before.sampled, "no input tick between the actual down/up")
    await step(2)
    const tap = await counts()
    assert.equal(tap.predicted, baseline ? 0 : 1, `${mode} predicted tap`)
    assert.equal(tap.authoritative, baseline ? 0 : 1, `${mode} authoritative tap: ${JSON.stringify(await page.evaluate(() => {
      const w = (window as any).practice, p = w?.players.get('you')
      return p && { time: w.time, mag: p.mag, queue: p.queue, cooldown: p.cooldownUntil, ready: p.readyAt, gun: p.gun, held: p.triggerHeld }
    }))}`)
    if (process.argv.includes("--screenshots")) {
      await page.screenshot({ path: opt("out", "fire-input-proof.json").replace(/\.json$/, `-${mode}.png`) })
    }
    if (!baseline) {
      // Consecutive real taps span the cooldown boundary without a released input tick.
      // Use several ticks: client/server floating-point clocks can disagree at the exact 1.2 s boundary.
      await step(32)
      await page.mouse.click(700, 350)
      await step()
      assert.equal((await counts()).predicted, 1, "first consecutive tap is still on cooldown")
      for (let n = 0; n < 5; n++) {
        await page.mouse.click(700, 350)
        await step()
      }
      await step(3)
      assert.deepEqual([ (await counts()).predicted, (await counts()).authoritative ], [2, 2])
      // Hold through multiple sniper cooldowns: exactly one more shot.
      await step(40)
      await page.mouse.down()
      await step(80)
      await page.mouse.up()
      await step(2)
      assert.deepEqual([ (await counts()).predicted, (await counts()).authoritative ], [3, 3])
      // Browser double-clicks contain two genuine down/up pairs; cooldown still admits only one shot.
      await page.mouse.dblclick(700, 350)
      await step(2)
      assert.deepEqual([ (await counts()).predicted, (await counts()).authoritative ], [4, 4])
      // A tap on cooldown is consumed, not queued to fire after recovery.
      await page.mouse.click(700, 350)
      await step(45)
      assert.deepEqual([ (await counts()).predicted, (await counts()).authoritative ], [4, 4])
      // Lab opening clears an unsampled gameplay tap; interactions with panel controls stay isolated.
      await page.mouse.click(700, 350)
      await page.keyboard.press("Backquote")
      await page.locator('[data-lab] section button').first().click()
      await step(2)
      assert.equal((await counts()).predicted, 4)
      await page.keyboard.press("Backquote")
      // No retained press across a stalled frame, even with a ready weapon.
      await page.mouse.click(700, 350)
      await page.evaluate(() => { (window as any).__fire.now += 101 })
      await step(2)
      assert.equal((await counts()).predicted, 4)
      // Switch the fixture's authoritative loadout and let reconciliation arm the real client.
      if (mode === "network") { server.pickGun("tester", "rifle"); server.spawn(player) }
      else await page.evaluate(() => { const w = (window as any).practice; w.pickGun("you", "rifle"); w.spawn(w.players.get("you")) })
      await step(45)
      const rifleBefore = await counts()
      await page.mouse.move(700, 350)
      await page.mouse.down()
      await step(24)
      await page.mouse.up()
      await step(2)
      const rifleAfter = await counts()
      assert.ok(rifleAfter.predicted - rifleBefore.predicted >= 6, "rifle still auto fires")
      assert.equal(rifleAfter.predicted - rifleBefore.predicted, rifleAfter.authoritative - rifleBefore.authoritative)
    }
    const events = await page.evaluate(() => (window as any).__fire.events)
    assert.ok(events.length >= 2 && events.every((e: any) => e.trusted), "real browser-dispatched mouse events")
    assert.deepEqual(errors, [])
    results.push({ mode, baseline, betweenTickTap: tap, final: await counts(), received, events, errors })
    await page.close()
  }
  writeFileSync(opt("out", "fire-input-proof.json"), JSON.stringify(results, null, 2) + "\n")
  console.log(JSON.stringify(results.map(({ mode, baseline, betweenTickTap, final }: any) => ({ mode, baseline, betweenTickTap, final })), null, 2))
} finally { await browser.close() }
