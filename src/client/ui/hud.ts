import type { FeedEntry, UIActions, UIState } from "../contracts"
import type { PlayerView } from "../../sim/protocol"
import { WORLD_H } from "../../sim/terrain"
import { WEAPONS, WEAPON_IDS, type WeaponId } from "../../sim/weapons"
import { VEHICLE } from "../../sim/vehicle"
import { attr, cls, fmtClock, fmtNum, h, html, Keyed, s, show, style, text } from "./dom"
import { ARROW_R, CHECK, weaponGlyph, weaponGlyphInner } from "./glyphs"
import { me, myUnit, teamColor, winnerName, wordmark } from "./common"

const RING_R = 74
const RING_C = 2 * Math.PI * RING_R

// Weapon wheel geometry (SVG units). The hub sits below the screen edge so only the
// upper fan is visible; the fan rotates to keep the selected weapon at the top.
const WHEEL_CY = 30
const WHEEL_R0 = 138
const WHEEL_R1 = 288
const STEP = 27
const KEY_HINTS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "", ""]

function polar(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180
  return [r * Math.sin(a), WHEEL_CY - r * Math.cos(a)]
}

function sector(a0: number, a1: number, r0: number, r1: number): string {
  const [x0, y0] = polar(a0, r1)
  const [x1, y1] = polar(a1, r1)
  const [x2, y2] = polar(a1, r0)
  const [x3, y3] = polar(a0, r0)
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r1} ${r1} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}A${r0} ${r0} 0 0 0 ${x3.toFixed(2)} ${y3.toFixed(2)}Z`
}

interface Seg {
  id: WeaponId
  g: SVGGElement
  plate: SVGPathElement
  label: SVGGElement
  count: SVGTextElement
  slot: number
  hint: string
}

interface RosterRow {
  el: HTMLElement
  chip: HTMLElement
  name: HTMLElement
  fill: HTMLElement
  hp: HTMLElement
  check: HTMLElement
}

interface FeedRow {
  el: HTMLElement
}

export function createHud(actions: UIActions) {
  const el = h("div", "screen hud")
  el.innerHTML = `
    <div class="hud-tl">
      <div class="hud-brand">
        ${wordmark("wm-hud", 16)}
        <div class="hud-div"></div>
        <div class="wind cham">
          <span class="wind-l">WIND</span>
          <span class="wind-v">0</span>
          <span class="wind-a">${ARROW_R}</span>
        </div>
      </div>
      <div class="hud-meta"><span class="hud-battle"></span><span class="hud-credits"></span></div>
      <div class="feed"></div>
    </div>
    <div class="ring">
      <svg viewBox="0 0 180 180" class="ring-svg">
        <circle cx="90" cy="90" r="84" class="ring-outer"/>
        <circle cx="90" cy="90" r="${RING_R}" class="ring-track"/>
        <circle cx="90" cy="90" r="${RING_R}" class="ring-prog" transform="rotate(-90 90 90)" stroke-dasharray="${RING_C}" stroke-dashoffset="0"/>
      </svg>
      <div class="ring-text"><div class="ring-time">0:00</div><div class="ring-label">AIM PHASE</div></div>
      <div class="ring-sub">ALL PLAYERS<br>AIM TOGETHER</div>
    </div>
    <div class="spectate">SPECTATING <span>—</span> YOU'LL JOIN NEXT BATTLE</div>
    <div class="roster cham"></div>
    <div class="aimpanel cham">
      <div class="ap-cols">
        <div class="ap-col"><div class="ap-l">ANGLE <span class="ap-dir"></span></div><div class="ap-v ap-angle">0°</div></div>
        <div class="ap-sep"></div>
        <div class="ap-col"><div class="ap-l">POWER</div><div class="ap-v ap-power">0%</div></div>
      </div>
      <div class="ap-bar"><i></i></div>
      <div class="ap-fuel"><span class="ap-l">FUEL</span><div class="ap-fuelbar"><i></i></div><span class="ap-hint">MOVE <kbd>A</kbd><kbd>D</kbd></span></div>
    </div>
    <div class="wheel"></div>
    <div class="lock">
      <button class="lock-btn"><span class="lock-t">LOCK IN</span><span class="lock-k">SPACE</span></button>
      <div class="lock-hint">Choose your weapon, set your angle and power.<br>All players fire simultaneously.</div>
    </div>
    <div class="toast"></div>
    <div class="banner"><div class="banner-line"></div><div class="banner-t"></div><div class="banner-s"></div><div class="banner-line"></div></div>
  `
  const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T
  const windV = q(".wind-v")
  const windA = q(".wind-a")
  const battle = q(".hud-battle")
  const credits = q(".hud-credits")
  const ring = q(".ring")
  const ringProg = q<SVGCircleElement>(".ring-prog")
  const ringTime = q(".ring-time")
  const ringLabel = q(".ring-label")
  const ringSub = q(".ring-sub")
  const spectate = q(".spectate")
  const roster = q(".roster")
  const apAngle = q(".ap-angle")
  const apDir = q(".ap-dir")
  const apPower = q(".ap-power")
  const apBar = q(".ap-bar i")
  const apFuel = q(".ap-fuelbar i")
  const apFuelRow = q(".ap-fuel")
  const aimpanel = q(".aimpanel")
  const lock = q(".lock")
  const lockBtn = q<HTMLButtonElement>(".lock-btn")
  const lockT = q(".lock-t")
  const lockK = q(".lock-k")
  const lockHint = q(".lock-hint")
  const toast = q(".toast")
  const banner = q(".banner")
  const bannerT = q(".banner-t")
  const bannerS = q(".banner-s")
  const feedEl = q(".feed")
  const wheelWrap = q(".wheel")

  lockBtn.addEventListener("click", () => actions.lock())

  // --- weapon wheel
  const svg = s("svg", { viewBox: `-330 -282 660 282`, class: "wheel-svg" })
  svg.innerHTML = `
    <circle cx="0" cy="${WHEEL_CY}" r="${WHEEL_R1 + 22}" class="wh-outer"/>
  `
  const fan = s("g", { class: "wh-fan" })
  svg.append(fan)
  // Each segment is drawn at 0° and rotated into its slot; only owned weapons get a slot.
  const segs: Seg[] = WEAPON_IDS.map((id, i) => {
    const w = WEAPONS[id]
    const g = s("g", { class: "wh-seg" })
    g.style.setProperty("--wc", w.color)
    const plate = s("path", { d: sector(-STEP / 2 + 0.8, STEP / 2 - 0.8, WHEEL_R0 + 6, WHEEL_R1), class: "wh-plate" })
    const label = s("g", { class: "wh-label" })
    const name = w.name === "GRAVITY WELL" ? "GRAVITY" : w.name === "BUNKER BUSTER" ? "BUSTER" : w.name
    label.innerHTML = `
      <g class="wh-glyph" transform="translate(-17 -46) scale(1.42)" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${weaponGlyphInner(id)}</g>
      <text class="wh-name" y="5" text-anchor="middle">${name}</text>
    `
    const count = s("text", { class: "wh-count", y: 31, "text-anchor": "middle" })
    label.append(count)
    if (KEY_HINTS[i]) {
      const [kx, ky] = polar(-STEP / 2 + 4.2, WHEEL_R1 - 15)
      g.append(s("text", { class: "wh-key", x: kx.toFixed(1), y: (ky + 4).toFixed(1), "text-anchor": "middle" }, [KEY_HINTS[i]]))
    }
    g.prepend(plate)
    g.append(label)
    g.addEventListener("click", () => actions.aim({ weapon: id }))
    fan.append(g)
    return { id, g, plate, label, count, slot: 0, hint: KEY_HINTS[i] }
  })
  // hub with angle gauge
  const hub = s("g", { class: "wh-hub" })
  let ticks = ""
  for (let d = 0; d <= 180; d += 5) {
    const a = ((d - 90) * Math.PI) / 180
    const r0 = d % 30 === 0 ? 98 : 106
    ticks += `<line x1="${(Math.sin(a) * r0).toFixed(1)}" y1="${(WHEEL_CY - Math.cos(a) * r0).toFixed(1)}" x2="${(Math.sin(a) * 114).toFixed(1)}" y2="${(WHEEL_CY - Math.cos(a) * 114).toFixed(1)}"/>`
  }
  hub.innerHTML = `
    <circle cx="0" cy="${WHEEL_CY}" r="${WHEEL_R0}" class="wh-hubface"/>
    <circle cx="0" cy="${WHEEL_CY}" r="${WHEEL_R0 - 12}" class="wh-hubring"/>
    <g class="wh-ticks">${ticks}</g>
    <circle cx="0" cy="${WHEEL_CY}" r="58" class="wh-hubring"/>
  `
  const needle = s("g", { class: "wh-needle" })
  needle.innerHTML = `<line x1="0" y1="${WHEEL_CY}" x2="0" y2="${WHEEL_CY - 88}"/><circle cx="0" cy="${WHEEL_CY - 96}" r="4"/>`
  hub.append(needle)
  svg.append(hub)
  wheelWrap.append(svg)

  let lastTick = performance.now()

  // --- roster
  const rows = new Keyed<PlayerView, RosterRow>(
    roster,
    () => {
      const row = h("div", "rs-row")
      row.innerHTML = `<i class="rs-chip"></i><span class="rs-name"></span><div class="rs-bar"><i></i></div><span class="rs-hp"></span><span class="rs-check">${CHECK}</span>`
      return {
        el: row,
        chip: row.querySelector(".rs-chip") as HTMLElement,
        name: row.querySelector(".rs-name") as HTMLElement,
        fill: row.querySelector(".rs-bar i") as HTMLElement,
        hp: row.querySelector(".rs-hp") as HTMLElement,
        check: row.querySelector(".rs-check") as HTMLElement,
      }
    },
    (row, pl) => {
      const view = cur.view!
      const u = view.units.find((x) => x.id === pl.unit)
      const color = teamColor(pl.team)
      const hp = u ? Math.max(0, Math.round(u.hp)) : 0
      const alive = !!u?.alive && hp > 0
      style(row.chip, "--c", color)
      style(row.fill, "--c", color)
      text(row.name, pl.name)
      style(row.fill, "width", `${u ? Math.max(0, Math.min(100, (u.hp / u.maxHp) * 100)) : 0}%`)
      text(row.hp, alive ? hp : "—")
      cls(row.el, "dead", !alive)
      cls(row.el, "you", pl.id === cur.you)
      cls(row.el, "bot", pl.bot)
      cls(row.el, "off", !pl.connected && !pl.bot)
      cls(row.check, "on", pl.locked && alive)
    },
  )

  // --- feed
  const feedRows = new Keyed<FeedEntry, FeedRow>(
    feedEl,
    (f) => {
      const row = h("div", "fd-row")
      if (f.killer && f.victim) {
        row.innerHTML = `<span class="fd-k"></span><span class="fd-w">${f.weapon ? weaponGlyph(f.weapon, 16) : "✕"}</span><span class="fd-v"></span>`
        const k = row.querySelector(".fd-k") as HTMLElement
        const v = row.querySelector(".fd-v") as HTMLElement
        k.textContent = f.killer
        v.textContent = f.victim
        if (f.killerColor) k.style.color = f.killerColor
        if (f.victimColor) v.style.color = f.victimColor
        if (f.weapon) (row.querySelector(".fd-w") as HTMLElement).style.color = WEAPONS[f.weapon].color
      } else {
        row.textContent = f.text
      }
      return { el: row }
    },
    (row, f) => {
      const age = performance.now() - f.at
      style(row.el, "opacity", age > 6000 ? "0" : age > 5000 ? (1 - (age - 5000) / 1000).toFixed(2) : "1")
    },
  )

  let cur: UIState
  let ringTotal = 8000
  let ringKey = ""
  let pickupAt = -1

  function update(state: UIState): void {
    const view = state.view
    if (!view) return
    cur = state
    const now = performance.now()
    const dt = Math.min(0.05, (now - lastTick) / 1000)
    lastTick = now
    const p = me(state)
    const unit = myUnit(state)
    const aim = state.aim
    const resolving = view.phase === "resolve"

    // top-left
    const w = Math.round(view.wind)
    text(windV, Math.abs(w))
    style(windA, "transform", w < 0 ? "scaleX(-1)" : "none")
    style(windA, "opacity", w === 0 ? "0.25" : "1")
    text(battle, `BATTLE ${view.battle} / ${view.battles}  ·  VOLLEY ${view.volley}`)
    text(credits, p ? `₵ ${fmtNum(p.credits)}` : "")

    // ring
    const left = view.phaseEndsAt - state.serverNow
    const key = `${view.phase}:${view.phaseEndsAt}`
    if (key !== ringKey) {
      ringKey = key
      ringTotal = Math.max(view.phase === "aim" ? 8000 : 1000, left)
    }
    const sudden = view.hazardY < WORLD_H
    cls(ring, "resolving", resolving)
    cls(ring, "urgent", !resolving && left < 3000)
    cls(ring, "sudden", sudden)
    if (resolving) {
      text(ringTime, "SALVO")
      text(ringLabel, "IMPACT")
      attr(ringProg, "stroke-dashoffset", 0)
    } else {
      text(ringTime, fmtClock(left))
      text(ringLabel, "AIM PHASE")
      const frac = Math.max(0, Math.min(1, left / ringTotal))
      attr(ringProg, "stroke-dashoffset", (RING_C * (1 - frac)).toFixed(1))
    }
    if (sudden) ringSub.innerHTML !== "SUDDEN DEATH<br>HAZARD RISING" && (ringSub.innerHTML = "SUDDEN DEATH<br>HAZARD RISING")
    else if (resolving) ringSub.innerHTML !== "ALL SHOTS<br>IN THE AIR" && (ringSub.innerHTML = "ALL SHOTS<br>IN THE AIR")
    else ringSub.innerHTML !== "ALL PLAYERS<br>AIM TOGETHER" && (ringSub.innerHTML = "ALL PLAYERS<br>AIM TOGETHER")

    show(spectate, state.spectating)

    // roster
    const players = view.players.filter((pl) => !pl.spectator)
    rows.sync(players, (pl) => pl.id)

    // feed
    const feed = state.feed.slice(-6)
    feedRows.sync(feed, (f) => String(f.id))

    // aim panel
    const canAim = !!aim && !!unit?.alive && !state.spectating
    cls(aimpanel, "idle", !canAim)
    if (aim) {
      const deg = Math.round((aim.angle * 180) / Math.PI)
      const rel = deg > 90 ? 180 - deg : deg
      text(apAngle, `${rel}°`)
      text(apDir, deg > 90 ? "LEFT" : deg < 90 ? "RIGHT" : "UP")
      text(apPower, `${Math.round(aim.power)}%`)
      style(apBar, "width", `${Math.max(0, Math.min(100, aim.power))}%`)
      attr(needle, "transform", `rotate(${(90 - deg).toFixed(1)} 0 ${WHEEL_CY})`)
    } else if (unit) {
      const deg = Math.round((unit.angle * 180) / Math.PI)
      text(apAngle, `${deg > 90 ? 180 - deg : deg}°`)
      text(apDir, "")
      text(apPower, "—")
      style(apBar, "width", "0%")
    }
    if (unit) {
      const maxFuel = VEHICLE.fuel
      const frac = Math.max(0, Math.min(1, unit.fuel / maxFuel))
      style(apFuel, "width", `${(frac * 100).toFixed(1)}%`)
      cls(apFuelRow, "empty", frac <= 0.001)
    }

    // wheel
    const selected = aim?.weapon ?? "shell"
    const ammoOf = (id: WeaponId) => (unit ? (unit.ammo[id] ?? 0) : id === "shell" ? 999 : 0)
    const owned = segs.filter((sg) => ammoOf(sg.id) > 0 || sg.id === selected)
    // selected weapon sits at the top; the rest wrap around it on both sides
    const si = Math.max(0, owned.findIndex((sg) => sg.id === selected))
    const m = owned.length
    owned.forEach((sg, k) => {
      let rel = k - si
      if (rel > Math.floor((m - 1) / 2)) rel -= m
      if (rel < -Math.floor(m / 2)) rel += m
      const target = rel * STEP
      // jump instead of sweeping across the whole dial when a segment wraps sides
      if (Math.abs(target - sg.slot) > STEP * 2.5) sg.slot = target + Math.sign(target - sg.slot) * -STEP
      sg.slot += Math.abs(target - sg.slot) > 0.05 ? (target - sg.slot) * Math.min(1, dt * 14) : target - sg.slot
    })
    for (const sg of segs) {
      const n = ammoOf(sg.id)
      const visible = owned.includes(sg)
      const a = sg.slot
      const [lx, ly] = polar(a, (WHEEL_R0 + WHEEL_R1) / 2 + 14)
      attr(sg.g, "transform", `rotate(${a.toFixed(2)} 0 ${WHEEL_CY})`)
      attr(sg.label, "transform", `rotate(${(-a).toFixed(2)} 0 ${WHEEL_CY}) translate(${lx.toFixed(1)} ${ly.toFixed(1)})`)
      text(sg.count, n >= 99 ? "∞" : n > 0 ? `x${n}` : "—")
      cls(sg.count, "inf", n >= 99)
      cls(sg.g, "sel", sg.id === selected)
      cls(sg.g, "empty", n <= 0)
      // fade segments as they rotate toward the horizon
      const d = Math.abs(a)
      style(sg.g, "opacity", !visible || d > 100 ? "0" : d > 70 ? (1 - (d - 70) / 30).toFixed(2) : "1")
      style(sg.g, "pointer-events", !visible || d > 95 ? "none" : "")
    }
    cls(wheelWrap, "idle", !canAim)
    show(wheelWrap, !state.spectating && !!unit)
    show(aimpanel, !state.spectating && !!unit)

    // lock in
    const locked = !!p?.locked
    const dead = !!p && !!unit && !unit.alive
    show(lock, !state.spectating && !!unit)
    cls(lock, "locked", locked && !resolving)
    cls(lock, "disabled", resolving || dead || !aim)
    if (resolving) {
      text(lockT, "FIRING")
      text(lockK, "—")
    } else if (dead) {
      text(lockT, "DESTROYED")
      text(lockK, "—")
    } else if (locked) {
      text(lockT, "LOCKED")
      text(lockK, "✓")
    } else {
      text(lockT, "LOCK IN")
      text(lockK, "SPACE")
    }
    const waiting = players.filter((pl) => !pl.locked && view.units.find((u) => u.id === pl.unit)?.alive).length
    const hint = locked && !resolving ? `Waiting on ${waiting} ${waiting === 1 ? "player" : "players"}.<br>Volley fires when the clock runs out.` : "Choose your weapon, set your angle and power.<br>All players fire simultaneously."
    if (lockHint.innerHTML !== hint) lockHint.innerHTML = hint

    // pickup toast
    const pk = state.lastPickup
    if (pk && pk.at !== pickupAt) {
      pickupAt = pk.at
      toast.innerHTML = `<span class="toast-k">+ ${pk.kind.toUpperCase()}</span><span class="toast-d"></span>`
      ;(toast.querySelector(".toast-d") as HTMLElement).textContent = pk.detail
    }
    cls(toast, "on", !!pk && now - pk.at < 3200)

    // battle banner
    const bw = resolving ? winnerName(state, view.battleWinner) : null
    cls(banner, "on", !!bw)
    if (bw) {
      text(bannerT, `${bw.name.toUpperCase()} TAKES BATTLE ${view.battle}`)
      style(bannerT, "--c", bw.color)
      text(bannerS, view.battle >= view.battles ? "FINAL BATTLE" : `${view.battles - view.battle} ${view.battles - view.battle === 1 ? "BATTLE" : "BATTLES"} REMAIN`)
    }
  }

  return { el, update }
}
