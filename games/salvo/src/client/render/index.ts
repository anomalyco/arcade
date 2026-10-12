import type { Frame, Renderer } from "../contracts"
import { TEAM_COLORS, type SimEvent, type Unit } from "../../sim/protocol"
import { WORLD_H, WORLD_W, type Mask } from "../../sim/terrain"
import { Backdrop, layerRect } from "./background"
import { Camera } from "./camera"
import { Fx } from "./fx"
import { drawAimRing, drawCrate, drawGhost, drawPreview, drawProjectile, POWERUP_COLORS } from "./shots"
import { styleChunk, TerrainLayer, TS } from "./terrain"
import { drawChevron, drawShield, drawUnitBody } from "./units"
import { ctx2d, glowSprite, makeCanvas, mixHex, rgba } from "./util"

const BLOOM_DIV = 4

export function teamColor(team: number): string {
  return TEAM_COLORS[((team % TEAM_COLORS.length) + TEAM_COLORS.length) % TEAM_COLORS.length]!
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const g = ctx2d(canvas)
  const cam = new Camera()
  const terrain = new TerrainLayer()
  const bg = new Backdrop()
  const fx = new Fx()
  const bloom = makeCanvas(1, 1)
  const bg2 = ctx2d(bloom)
  const blurA = makeCanvas(1, 1)
  const ba = ctx2d(blurA)
  const blurB = makeCanvas(1, 1)
  const bb = ctx2d(blurB)
  const hot = makeCanvas(1, 1)
  const hg = ctx2d(hot)
  let vignette: HTMLCanvasElement | null = null
  const back = makeCanvas(1, 1)
  const backG = ctx2d(back)
  let backKey = ""

  let mask: Mask | null = null
  let seed = 1
  let needFull = false
  let pinesPlaced = false
  let hitStop = 0
  let lastFocus = 0
  const chunkStyles = new Map<number, HTMLCanvasElement>()
  const shieldFlash = new Map<number, number>()
  const unitById = new Map<number, Unit>()

  const colorOfUnit = (id: number): string => {
    const u = unitById.get(id)
    return u ? teamColor(u.team) : "#e8f0ff"
  }

  const renderer: Renderer = {
    resize(width, height, dpr) {
      cam.resize(width, height, dpr)
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      const bw = Math.max(1, Math.ceil(width / BLOOM_DIV))
      const bh = Math.max(1, Math.ceil(height / BLOOM_DIV))
      for (const c of [bloom, blurA, blurB]) {
        c.width = bw
        c.height = bh
      }
      hot.width = Math.max(1, Math.ceil(width / 2))
      hot.height = Math.max(1, Math.ceil(height / 2))
      vignette = null
    },

    setTerrain(m) {
      mask = m
      fx.mask = m
      needFull = true
      pinesPlaced = false
      chunkStyles.clear()
    },

    terrainChanged(x0, y0, x1, y1) {
      if (needFull || !mask) return
      terrain.changed(x0, y0, x1, y1)
      for (const p of bg.checkPines(mask, x0, y0, x1, y1)) {
        fx.embers(p.x, p.y - p.h / 2, 6, "#ff8a2a", 30, p.h / 2)
        fx.debris(p.x, p.y - p.h / 2, 2, 90, "#ff8a2a", 0.6)
      }
    },

    event(ev, frame) {
      for (const u of frame.units) unitById.set(u.id, u)
      handleEvent(ev)
    },

    shake(amount) {
      cam.addShake(amount)
    },

    draw(frame) {
      drawFrame(frame)
    },

    screenToWorld(x, y) {
      return cam.toWorld(x, y)
    },

    worldToScreen(x, y) {
      return cam.toScreen(x, y)
    },
  }

  function handleEvent(ev: SimEvent): void {
    switch (ev.type) {
      case "boom": {
        const team = colorOfUnit(ev.owner)
        fx.boom(ev.x, ev.y, ev.r, ev.kind, team)
        const big = ev.r / 30
        cam.addShake(Math.min(0.55, 0.12 + big * 0.22) * (ev.kind === "buster" ? 1.6 : 1))
        if (ev.r >= 26 || ev.kind === "buster") {
          hitStop = Math.max(hitStop, 0.035)
          fx.flash = Math.max(fx.flash, 0.08 + big * 0.06)
        }
        break
      }
      case "carve":
        fx.carve(ev.x, ev.y, ev.r)
        if (ev.r < 12) fx.drillSparks(ev.x, ev.y)
        break
      case "fill":
        fx.dust((ev.x0 + ev.x1) / 2, ev.y1, 4, Math.abs(ev.x1 - ev.x0))
        break
      case "chunk":
        fx.sparks(ev.x + ev.w / 2, ev.y, 12, "#9fe6ff", 90, { life: 0.5, spread: Math.PI })
        fx.dust(ev.x + ev.w / 2, ev.y + ev.h, 6, ev.w * 0.6)
        break
      case "collide":
        fx.collide(ev.x, ev.y)
        cam.addShake(0.18)
        hitStop = Math.max(hitStop, 0.04)
        break
      case "hit": {
        const victim = unitById.get(ev.unit)
        const color = victim ? teamColor(victim.team) : "#ffffff"
        if (ev.kill) {
          fx.text(ev.x, ev.y - 14, "KO", color, 17, `-${ev.amount}`)
          fx.unitDeath(ev.x, ev.y + 4, color)
          cam.addShake(0.35)
          hitStop = Math.max(hitStop, 0.06)
          fx.flash = Math.max(fx.flash, 0.18)
        } else {
          fx.text(ev.x, ev.y - 12, `-${ev.amount}`, color, Math.min(14, 8 + ev.amount / 10))
          fx.sparks(ev.x, ev.y, 10, color, 140, { life: 0.4 })
        }
        break
      }
      case "absorb": {
        const u = unitById.get(ev.unit)
        if (u) {
          fx.absorb(u.x, u.y - 8, "#5ac8ff")
          fx.text(u.x, u.y - 24, `${ev.amount}`, "#5ac8ff", 8, "ABSORBED")
        }
        shieldFlash.set(ev.unit, 1)
        break
      }
      case "move": {
        const u = unitById.get(ev.unit)
        if (u) fx.dust(u.x, u.y, 2, 6)
        break
      }
      case "fall":
        fx.dust(ev.x, ev.y, Math.min(10, 3 + Math.round(ev.dy / 10)), 12)
        if (ev.dmg > 0) cam.addShake(Math.min(0.3, ev.dy / 200))
        break
      case "fire":
        fx.flames(ev.x0, ev.x1, ev.y, Math.min(60, Math.round((ev.x1 - ev.x0) * 0.8)))
        fx.light((ev.x0 + ev.x1) / 2, ev.y, Math.max(40, ev.x1 - ev.x0), "#ff6a1e", 0.6)
        break
      case "well":
        fx.well(ev.x, ev.y, ev.r)
        break
      case "builder":
        fx.builder(ev.x, ev.y, ev.w, ev.h)
        break
      case "teleport":
        fx.teleport(ev.x0, ev.y0, ev.x, ev.y)
        break
      case "shieldUp": {
        const u = unitById.get(ev.unit)
        if (u) fx.absorb(u.x, u.y - 8, "#5ac8ff")
        shieldFlash.set(ev.unit, 1)
        break
      }
      case "crate": {
        const u = unitById.get(ev.unit)
        const col = POWERUP_COLORS[ev.kind] ?? "#ffffff"
        const x = u ? u.x : 600
        const y = u ? u.y - 10 : 300
        fx.crate(x, y, ev.detail || ev.kind.toUpperCase(), col)
        break
      }
      case "hazard":
        fx.hazardPulse = 1
        cam.addShake(0.15)
        break
    }
  }

  function frameCamera(frame: Frame): void {
    if (!frame.resolving) {
      if (frame.now - lastFocus > 600) cam.reset()
      return
    }
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    let n = 0
    const addPt = (x: number, y: number) => {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
      n++
    }
    for (const p of frame.projectiles) addPt(p.x, Math.max(-40, p.y))
    const hs = fx.hotspot()
    if (hs) addPt(hs.x, hs.y)
    if (n === 0) {
      if (frame.now - lastFocus > 900) cam.reset()
      return
    }
    lastFocus = frame.now
    const pad = 110
    const bw = x1 - x0 + pad * 2
    const bh = y1 - y0 + pad * 2
    const vw = cam.w / cam.s
    const vh = cam.h / cam.s
    const z = Math.min(1.4, vw / bw, vh / bh)
    if (z < 1.06) cam.focus(cam.bcx, cam.bcy, 1)
    else cam.focus((x0 + x1) / 2, (y0 + y1) / 2, z)
  }

  function ensureTerrain(frame: Frame): void {
    if (frame.view.seed !== seed) {
      seed = frame.view.seed
      bg.setSeed(seed)
      if (mask && !needFull) terrain.setSeed(seed)
    }
    if (needFull && mask) {
      bg.setSeed(seed)
      terrain.set(mask, seed)
      needFull = false
    }
    if (mask && !pinesPlaced && frame.units.length > 0) {
      bg.placePines(mask, seed, frame.units.map((u) => u.x))
      pinesPlaced = true
    }
    terrain.flush()
  }

  function drawUnits(c: CanvasRenderingContext2D, frame: Frame, glow: boolean): void {
    for (const u of frame.units) {
      if (u.alive) continue
      drawUnitBody(c, u, teamColor(u.team), frame.now, glow)
    }
    for (const u of frame.units) {
      if (!u.alive) continue
      const col = teamColor(u.team)
      drawUnitBody(c, u, col, frame.now, glow)
      const you = u.id === frame.yourUnit
      const bob = Math.sin(frame.now * 0.004 + u.id) * 0.8
      const top = 27
      drawChevron(c, u.x, u.y - top - 3 + bob, col, you ? 1.25 : 1, glow)
      if (u.shield > 0) {
        const f = shieldFlash.get(u.id) ?? 0
        drawShield(c, u.x, u.y - 9, 20, "#5ac8ff", frame.now, glow, f)
      }
    }
  }

  // name labels are pre-rendered sprites; per-frame fillText is surprisingly costly
  const labelCache = new Map<string, HTMLCanvasElement>()
  function labelSprite(text: string, color: string, res: number): HTMLCanvasElement {
    const key = `${text}|${color}|${res}`
    let c = labelCache.get(key)
    if (c) return c
    if (labelCache.size > 64) labelCache.clear()
    const font = `700 ${5.2 * res}px "Rajdhani","Barlow Condensed","Arial Narrow",sans-serif`
    const m = ctx2d(makeCanvas(1, 1))
    m.font = font
    const w = Math.ceil(m.measureText(text).width + 4 * res)
    c = makeCanvas(w, 8 * res)
    const lg = ctx2d(c)
    lg.font = font
    lg.textAlign = "center"
    lg.textBaseline = "middle"
    lg.fillStyle = mixHex(color, "#ffffff", 0.5)
    lg.fillText(text, w / 2, 4 * res)
    labelCache.set(key, c)
    return c
  }

  function drawLabels(c: CanvasRenderingContext2D, frame: Frame): void {
    const res = Math.min(6, Math.max(1, Math.ceil(cam.scale() * cam.dpr)))
    for (const u of frame.units) {
      if (!u.alive) continue
      const col = teamColor(u.team)
      const top = 27
      const y = u.y - top - 9
      const w = 14
      const f = Math.max(0, Math.min(1, u.hp / Math.max(1, u.maxHp)))
      c.fillStyle = "rgba(3,6,10,0.7)"
      c.fillRect(u.x - w / 2 - 0.4, y - 0.4, w + 0.8, 2)
      c.fillStyle = f > 0.3 ? col : "#ff4a5e"
      c.fillRect(u.x - w / 2, y, w * f, 1.2)
      c.globalAlpha = u.id === frame.yourUnit ? 0.95 : 0.6
      const spr = labelSprite(u.name.slice(0, 14), col, res)
      c.drawImage(spr, u.x - spr.width / res / 2, y - 1.4 - 6, spr.width / res, spr.height / res)
      c.globalAlpha = 1
    }
  }

  function drawWorldGlow(c: CanvasRenderingContext2D, frame: Frame, bloomPass: boolean): void {
    for (const ga of frame.ghostArcs) drawGhost(c, ga.pts, colorOfUnit(ga.unit), ga.locked, bloomPass)
    const me = unitById.get(frame.yourUnit)
    if (frame.preview && me) drawPreview(c, frame.preview, teamColor(me.team), frame.now, bloomPass)
    if (frame.aim && me && me.alive && !frame.resolving) drawAimRing(c, me.x, me.y - 12, frame.aim.angle, frame.aim.power, teamColor(me.team), bloomPass)
    for (const p of frame.projectiles) drawProjectile(c, p, colorOfUnit(p.owner), frame.now, bloomPass)
  }

  function drawFires(c: CanvasRenderingContext2D, frame: Frame, bloomPass: boolean): void {
    c.save()
    c.globalCompositeOperation = "lighter"
    for (const f of frame.fires) {
      const w = f.x1 - f.x0
      const grd = c.createLinearGradient(0, f.y - 10, 0, f.y + 2)
      grd.addColorStop(0, "rgba(255,90,30,0)")
      grd.addColorStop(1, `rgba(255,110,40,${bloomPass ? 0.9 : 0.55})`)
      c.fillStyle = grd
      c.fillRect(f.x0, f.y - 10, w, 12)
      for (let x = f.x0; x < f.x1; x += 3) {
        const h = 3 + Math.abs(Math.sin(frame.now * 0.012 + x * 0.7)) * 5
        const s = bloomPass ? 3.4 : 2.2
        c.globalAlpha = 0.8
        c.drawImage(glowSprite(h > 6 ? "#ffd04a" : "#ff6a1e", 1), x - s, f.y - h, s * 2, h + 2)
      }
      c.globalAlpha = 1
    }
    for (const wl of frame.wells) {
      const rot = frame.now * 0.004
      c.globalAlpha = bloomPass ? 0.7 : 0.9
      c.drawImage(glowSprite("#8b4bff"), wl.x - wl.r * 1.4, wl.y - wl.r * 1.4, wl.r * 2.8, wl.r * 2.8)
      c.strokeStyle = "#d9a8ff"
      c.lineWidth = bloomPass ? 2 : 0.7
      for (let i = 0; i < 5; i++) {
        c.globalAlpha = 0.25 + i * 0.12
        c.beginPath()
        const rr = wl.r * (0.25 + i * 0.17)
        c.arc(wl.x, wl.y, rr, rot * (1 + i * 0.3) + i, rot * (1 + i * 0.3) + i + Math.PI * 1.2)
        c.stroke()
      }
      c.globalAlpha = 1
    }
    c.restore()
    if (!bloomPass) {
      for (const wl of frame.wells) {
        const grd = c.createRadialGradient(wl.x, wl.y, 0, wl.x, wl.y, wl.r * 0.45)
        grd.addColorStop(0, "rgba(4,0,10,0.95)")
        grd.addColorStop(1, "rgba(4,0,10,0)")
        c.fillStyle = grd
        c.beginPath()
        c.arc(wl.x, wl.y, wl.r * 0.45, 0, Math.PI * 2)
        c.fill()
      }
    }
  }

  function drawHazard(c: CanvasRenderingContext2D, frame: Frame, bloomPass: boolean): void {
    const hy = frame.view.hazardY
    if (!(hy < WORLD_H)) return
    const pulse = 0.7 + Math.sin(frame.now * 0.006) * 0.15 + fx.hazardPulse * 0.6
    c.save()
    if (!bloomPass) {
      const grd = c.createLinearGradient(0, hy, 0, hy + 90)
      grd.addColorStop(0, `rgba(255,40,90,${0.32 * pulse})`)
      grd.addColorStop(1, "rgba(255,40,90,0.06)")
      c.fillStyle = grd
      c.fillRect(-200, hy, WORLD_W + 400, WORLD_H + 200 - hy)
      c.strokeStyle = `rgba(255,80,120,${0.12 * pulse})`
      c.lineWidth = 0.5
      c.beginPath()
      for (let y = hy + 4; y < WORLD_H + 100; y += 5) {
        c.moveTo(-200, y)
        c.lineTo(WORLD_W + 200, y)
      }
      c.stroke()
    }
    c.globalCompositeOperation = "lighter"
    c.strokeStyle = `rgba(255,70,110,${pulse})`
    c.lineWidth = bloomPass ? 4 : 1.2
    c.setLineDash(bloomPass ? [] : [10, 4])
    c.lineDashOffset = -frame.now * 0.02
    c.beginPath()
    c.moveTo(-200, hy)
    c.lineTo(WORLD_W + 200, hy)
    c.stroke()
    c.restore()
  }

  function drawChunks(c: CanvasRenderingContext2D, frame: Frame): void {
    const live = new Set<number>()
    for (const ch of frame.chunks) {
      live.add(ch.id)
      let st = chunkStyles.get(ch.id)
      if (!st) {
        st = styleChunk(ch.canvas, seed + ch.id)
        chunkStyles.set(ch.id, st)
      }
      c.drawImage(st, ch.x, ch.y, st.width / TS, st.height / TS)
    }
    for (const id of chunkStyles.keys()) if (!live.has(id)) chunkStyles.delete(id)
  }

  function drawFrame(frame: Frame): void {
    const dt = Math.min(0.1, Math.max(0, frame.dt))
    unitById.clear()
    for (const u of frame.units) unitById.set(u.id, u)
    ensureTerrain(frame)

    let fdt = dt * (frame.timeScale > 0 ? frame.timeScale : 1)
    if (hitStop > 0) {
      hitStop -= dt
      fdt *= 0.08
    }
    fx.update(fdt)
    for (const [id, f] of shieldFlash) {
      const nf = f - dt * 2
      if (nf <= 0) shieldFlash.delete(id)
      else shieldFlash.set(id, nf)
    }
    for (const u of frame.units) if (!u.alive && Math.random() < fdt * 5) fx.wreckSmoke(u.x, u.y)
    for (const f of frame.fires) if (Math.random() < fdt * (f.x1 - f.x0) * 0.6) fx.flames(f.x0, f.x1, f.y, 1)
    for (const p of frame.projectiles) if (Math.random() < fdt * 30) fx.trailPuff(p.x, p.y, colorOfUnit(p.owner))
    frameCamera(frame)
    cam.update(dt)

    const W = canvas.width
    const H = canvas.height
    const dpr = cam.dpr
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalCompositeOperation = "source-over"
    g.globalAlpha = 1

    // backdrop (plate, dot grid, procedural ridges) is cached while the camera holds still
    const key = `${cam.cx.toFixed(1)}|${cam.cy.toFixed(1)}|${cam.z.toFixed(4)}|${W}|${H}|${bg.plateReady}|${seed}`
    if (key !== backKey) {
      backKey = key
      if (back.width !== W || back.height !== H) {
        back.width = W
        back.height = H
      }
      const bc = backG
      bc.setTransform(1, 0, 0, 1, 0, 0)
      bc.fillStyle = "#08101e"
      bc.fillRect(0, 0, W, H)
      const pp = 0.06
      cam.apply(bc, pp, false)
      const pv = cam.view(pp)
      bg.drawPlate(bc, pv.x0, pv.x1, pv.y0, pv.y1, (pv.x1 - pv.x0) * 1.08)
      bc.setTransform(dpr, 0, 0, dpr, 0, 0)
      const pat = bg.dotPattern(bc)
      if (pat) {
        bc.fillStyle = pat
        bc.fillRect(0, 0, cam.w, cam.h)
      }
      const lr = layerRect()
      for (const l of bg.layers) {
        cam.apply(bc, l.parallax, false)
        bc.drawImage(l.canvas, lr.x, lr.y, lr.w, lr.h)
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0)
    // backdrop moves with a fraction of the shake so the world reads as nearer
    const bsx = cam.sx * 0.3 * dpr
    const bsy = cam.sy * 0.3 * dpr
    g.drawImage(back, bsx - Math.abs(bsx), bsy - Math.abs(bsy), W + Math.abs(bsx) * 2, H + Math.abs(bsy) * 2)
    cam.apply(g, 0.15)
    bg.drawStreaks(g, frame.now, frame.view.wind, frame.resolving ? 0.4 : 1)

    // world
    cam.apply(g, 1)
    bg.drawPines(g)
    g.imageSmoothingEnabled = true
    g.drawImage(terrain.canvas, 0, 0, WORLD_W, WORLD_H)
    const v = cam.view(1)
    if (v.y1 > WORLD_H) {
      g.fillStyle = "#06080c"
      g.fillRect(-50, WORLD_H, WORLD_W + 100, v.y1 - WORLD_H)
    }
    // low fog swallowing the deep rock
    const fog = g.createLinearGradient(0, WORLD_H - 170, 0, WORLD_H + 20)
    fog.addColorStop(0, "rgba(14,30,48,0)")
    fog.addColorStop(0.6, "rgba(14,30,48,0.35)")
    fog.addColorStop(1, "rgba(16,34,54,0.75)")
    g.fillStyle = fog
    g.fillRect(-50, WORLD_H - 170, WORLD_W + 100, Math.max(200, v.y1 - WORLD_H + 190))

    // explosion heat lighting up nearby terrain edges
    let hotAny = false
    {
      const S = cam.scale() / 2
      hg.setTransform(1, 0, 0, 1, 0, 0)
      hg.globalCompositeOperation = "source-over"
      hg.clearRect(0, 0, hot.width, hot.height)
      hg.setTransform(S, 0, 0, S, (cam.w / 2 + cam.sx - cam.cx * cam.scale()) / 2, (cam.h / 2 + cam.sy - cam.cy * cam.scale()) / 2)
      hg.globalCompositeOperation = "lighter"
      hotAny = fx.drawHot(hg)
      if (hotAny) {
        hg.globalCompositeOperation = "destination-in"
        hg.drawImage(terrain.rimSoft, 0, 0, WORLD_W, WORLD_H)
        g.setTransform(1, 0, 0, 1, 0, 0)
        g.globalCompositeOperation = "lighter"
        g.drawImage(hot, 0, 0, W, H)
        g.globalCompositeOperation = "source-over"
        cam.apply(g, 1)
      }
    }

    drawHazard(g, frame, false)
    drawFires(g, frame, false)
    drawChunks(g, frame)
    for (const c of frame.view.crates) drawCrate(g, c, frame.now, false)
    drawUnits(g, frame, false)
    fx.drawBase(g)
    drawWorldGlow(g, frame, false)
    fx.drawGlow(g, false)
    fx.drawDebris(g)

    // bloom buffer at 1/BLOOM_DIV resolution
    const bw = bloom.width
    const bh = bloom.height
    bg2.setTransform(1, 0, 0, 1, 0, 0)
    bg2.globalCompositeOperation = "source-over"
    bg2.clearRect(0, 0, bw, bh)
    {
      const S = cam.scale() / BLOOM_DIV
      bg2.setTransform(S, 0, 0, S, (cam.w / 2 + cam.sx - cam.cx * cam.scale()) / BLOOM_DIV, (cam.h / 2 + cam.sy - cam.cy * cam.scale()) / BLOOM_DIV)
    }
    bg2.globalAlpha = 0.4
    bg2.drawImage(terrain.rim, 0, 0, WORLD_W, WORLD_H)
    bg2.globalAlpha = 1
    if (hotAny) {
      bg2.setTransform(1, 0, 0, 1, 0, 0)
      bg2.globalCompositeOperation = "lighter"
      bg2.drawImage(hot, 0, 0, bw, bh)
      bg2.globalCompositeOperation = "source-over"
      const S = cam.scale() / BLOOM_DIV
      bg2.setTransform(S, 0, 0, S, (cam.w / 2 + cam.sx - cam.cx * cam.scale()) / BLOOM_DIV, (cam.h / 2 + cam.sy - cam.cy * cam.scale()) / BLOOM_DIV)
    }
    drawHazard(bg2, frame, true)
    drawFires(bg2, frame, true)
    for (const c of frame.view.crates) drawCrate(bg2, c, frame.now, true)
    bg2.globalAlpha = 0.35
    drawUnits(bg2, frame, true)
    bg2.globalAlpha = 1
    drawWorldGlow(bg2, frame, true)
    fx.drawGlow(bg2, true)

    for (const [c, ctx, r] of [
      [blurA, ba, 1.5],
      [blurB, bb, 5],
    ] as const) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.filter = `blur(${r}px)`
      ctx.drawImage(bloom, 0, 0)
      ctx.filter = "none"
    }
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalCompositeOperation = "lighter"
    g.globalAlpha = 0.9
    g.drawImage(blurA, 0, 0, W, H)
    g.globalAlpha = 0.85
    g.drawImage(blurB, 0, 0, W, H)
    g.globalAlpha = 1
    g.globalCompositeOperation = "source-over"

    // labels and floating numbers stay crisp on top
    cam.apply(g, 1)
    drawLabels(g, frame)
    fx.drawTexts(g)

    g.setTransform(1, 0, 0, 1, 0, 0)
    if (!vignette || vignette.width !== W || vignette.height !== H) vignette = makeVignette(W, H)
    g.drawImage(vignette, 0, 0)
    if (fx.flash > 0.001) {
      g.globalCompositeOperation = "lighter"
      g.fillStyle = rgba("#fff2e0", fx.flash * 0.45)
      g.fillRect(0, 0, W, H)
      g.globalCompositeOperation = "source-over"
    }
  }

  return renderer
}

function makeVignette(w: number, h: number): HTMLCanvasElement {
  const c = makeCanvas(w, h)
  const g = ctx2d(c)
  const grd = g.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.35, w / 2, h * 0.5, Math.max(w, h) * 0.75)
  grd.addColorStop(0, "rgba(2,4,10,0)")
  grd.addColorStop(1, "rgba(2,4,10,0.55)")
  g.fillStyle = grd
  g.fillRect(0, 0, w, h)
  return c
}
