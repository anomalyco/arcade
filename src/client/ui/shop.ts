import type { UIActions, UIState } from "../contracts"
import type { PlayerView } from "../../sim/protocol"
import { WEAPONS, WEAPON_IDS, type WeaponId } from "../../sim/weapons"
import { SHOP, type ShopItem } from "../../sim/shop"
import { attr, cls, fmtClock, fmtNum, h, Keyed, segBar, setSegBar, show, style, text } from "./dom"
import { CART, CHECK, weaponGlyph, weaponGlyphInner } from "./glyphs"
import { me, myUnit, teamColor, wordmark } from "./common"
import { drawPreview } from "./preview"
import { cardArt } from "./cardart"

const UPGRADE_COLOR = "#e8f0ff"
const UPGRADE_GLYPH = `<path d="M12 3v18M5 10l7-7 7 7M5 16l7-7 7 7" />`

const TRAITS: Partial<Record<WeaponId, [string, string, string]>> = {
  cluster: ["SPLITS AT APEX", "SIX BOMBLETS", "AREA DENIAL"],
  mirv: ["THREE WARHEADS", "WIDE SPREAD", "SPLITS AT APEX"],
  drill: ["PENETRATES TERRAIN", "TUNNELS 3 SEC", "DETONATES UNDERGROUND"],
  napalm: ["BURNING POOL", "DAMAGE OVER TIME", "NO CRATER"],
  gravity: ["PULLS SHELLS", "PULLS UNITS", "IMPLODES"],
  builder: ["RAISES A WALL", "BLOCKS SHOTS", "NO DAMAGE"],
  airstrike: ["FOUR BOMBS", "FROM ABOVE", "LINE OF CRATERS"],
  bouncer: ["THREE RICOCHETS", "AROUND COVER", "TIMED FUSE"],
  buster: ["DEEP PENETRATION", "DELAYED BLAST", "HEAVY CRATER"],
  shield: ["40 HP BARRIER", "THIS VOLLEY", "NO SHOT FIRED"],
  teleport: ["BEACON ROUND", "RELOCATES YOU", "NO DAMAGE"],
}

const TAGLINES: Partial<Record<WeaponId, string>> = {
  shell: "The baseline.",
  cluster: "Cover the ground.",
  mirv: "Three answers at once.",
  drill: "Go deeper.",
  napalm: "Deny the ground.",
  gravity: "Bend the volley.",
  builder: "Make your own cover.",
  airstrike: "Walk it in.",
  bouncer: "Around the corner.",
  buster: "No bunker is safe.",
  shield: "Hold the line.",
  teleport: "Be somewhere else.",
}

function itemColor(it: ShopItem): string {
  return it.weapon ? WEAPONS[it.weapon].color : UPGRADE_COLOR
}

const UPGRADE_GLYPHS: Record<string, string> = {
  armor: `<path d="M4 6h16v6c0 4.5-3.5 7.5-8 9-4.5-1.5-8-4.5-8-9z"/><path d="M4 11h16M12 6v15"/>`,
  fuel: `<path d="M6 4h9l3 3v13H6z"/><path d="M9 4V2.5h4V4M9 10l6 6M15 10l-6 6"/>`,
  lens: `<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>`,
  boost: `<path d="M13 2 5 13.5h6L10 22l8-11.5h-6z"/>`,
  repair: `<rect x="3" y="7" width="18" height="13" rx="1.5"/><path d="M9 7V4h6v3M12 10.5v6M9 13.5h6"/>`,
}

function itemGlyph(it: ShopItem): string {
  return it.weapon ? weaponGlyphInner(it.weapon) : (UPGRADE_GLYPHS[it.id] ?? UPGRADE_GLYPH)
}

const statMax = (() => {
  const m = { damage: 1, radius: 1, terrain: 1 }
  for (const it of SHOP) {
    if (!it.stats) continue
    m.damage = Math.max(m.damage, it.stats.damage)
    m.radius = Math.max(m.radius, it.stats.radius)
    m.terrain = Math.max(m.terrain, it.stats.terrain)
  }
  return m
})()

function statsOf(it: ShopItem): { damage: number; radius: number; terrain: number } | null {
  if (it.stats) return it.stats
  if (it.weapon) {
    const w = WEAPONS[it.weapon]
    return { damage: w.damage, radius: w.radius, terrain: w.terrain }
  }
  return null
}

interface Card {
  el: HTMLElement
  item: ShopItem
  price: HTMLElement
  owned: HTMLElement
  bars: HTMLElement[]
}

interface ScoreRow {
  el: HTMLElement
  rank: HTMLElement
  chip: HTMLElement
  name: HTMLElement
  w: HTMLElement
  k: HTMLElement
  d: HTMLElement
  c: HTMLElement
  ready: HTMLElement
}

export function createShop(actions: UIActions) {
  const el = h("div", "screen shop")
  el.innerHTML = `
    <div class="sh-head">
      <div class="sh-title">
        ${wordmark("wm-shop")}
        <h1 class="sh-h1"></h1>
        <div class="sh-sub">BUY WEAPONS. SHAPE THE NEXT BATTLE.</div>
      </div>
      <div class="sh-status">
        <div class="sh-credits"><span class="cr-sym">₵</span><span class="cr-v">0</span></div>
        <div class="sh-vdiv"></div>
        <div class="sh-timer"><div class="sh-timer-row"><span>NEXT ROUND IN</span><b class="sh-clock">0:00</b></div><div class="sh-timer-bar"><i></i></div></div>
        <button class="sh-ready"><span class="sh-ready-t">READY</span><span class="sh-ready-n"></span></button>
      </div>
    </div>
    <div class="sh-main">
      <div class="sh-left">
        <div class="sh-grid"></div>
        <div class="sh-ups"><div class="ups-l">FIELD<br>UPGRADES</div></div>
      </div>
      <div class="sh-detail cham-soft">
        <div class="dt-head"><h2 class="dt-name"></h2><div class="dt-price"></div></div>
        <div class="dt-tag"></div>
        <div class="dt-preview"><canvas></canvas></div>
        <p class="dt-desc"></p>
        <div class="dt-stats">
          <div class="dt-stat"><span>DAMAGE</span></div>
          <div class="dt-stat"><span>RADIUS</span></div>
          <div class="dt-stat"><span>TERRAIN EFFECT</span></div>
        </div>
        <div class="dt-traits"><span></span><span></span><span></span></div>
        <button class="dt-buy">${CART}<span class="dt-buy-t">BUY</span><span class="dt-buy-n"></span></button>
      </div>
    </div>
    <div class="sh-foot">
      <div class="sh-inv cham-soft">
        <div class="inv-head"><span>YOUR INVENTORY</span><span class="inv-slots"></span></div>
        <div class="inv-tiles"></div>
      </div>
      <div class="sh-score cham-soft">
        <div class="sc-head"><div class="sc-half"><span>PLAYERS <em class="sc-n"></em></span><span class="sc-cols"><i>W</i><i>K</i><i>DMG</i><i>₵</i></span></div><div class="sc-half"><span></span><span class="sc-cols"><i>W</i><i>K</i><i>DMG</i><i>₵</i></span></div></div>
        <div class="sc-rows"></div>
      </div>
    </div>
  `
  const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T
  const h1 = q(".sh-h1")
  const crV = q(".cr-v")
  const clock = q(".sh-clock")
  const timerBar = q(".sh-timer-bar i")
  const readyBtn = q<HTMLButtonElement>(".sh-ready")
  const readyT = q(".sh-ready-t")
  const readyN = q(".sh-ready-n")
  const grid = q(".sh-grid")
  const detail = q(".sh-detail")
  const dtName = q(".dt-name")
  const dtPrice = q(".dt-price")
  const dtTag = q(".dt-tag")
  const dtDesc = q(".dt-desc")
  const dtStats = q(".dt-stats")
  const dtStatBars = [...el.querySelectorAll(".dt-stat")].map((row) => {
    const b = segBar(10)
    row.append(b)
    return b
  })
  const traits = [...el.querySelectorAll<HTMLElement>(".dt-traits span")]
  const buy = q<HTMLButtonElement>(".dt-buy")
  const buyN = q(".dt-buy-n")
  const canvas = q<HTMLCanvasElement>(".dt-preview canvas")
  const ctx = canvas.getContext("2d")!
  const invSlots = q(".inv-slots")
  const invTiles = q(".inv-tiles")
  const scN = q(".sc-n")
  const scRows = q(".sc-rows")

  const ups = q(".sh-ups")
  const weaponCount = SHOP.filter((it) => it.kind === "weapon").length
  grid.style.setProperty("--cols", weaponCount > 9 ? "4" : "3")
  let selected = SHOP.find((it) => it.weapon && it.weapon !== "shell")?.id ?? SHOP[0]?.id ?? ""
  let cur: UIState

  const cards: Card[] = SHOP.map((it) => {
    const color = itemColor(it)
    const card = h("button", "card")
    card.style.setProperty("--wc", color)
    const st = statsOf(it)
    card.innerHTML = it.kind !== "weapon" ? `
      <svg class="up-glyph" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${itemGlyph(it)}</svg>
      <div class="card-row"><span class="card-name"></span><span class="card-price"></span></div>
      <div class="card-body"></div>
      <span class="card-owned"></span>
    ` : `
      ${cardArt(it.weapon!)}
      <div class="card-row"><span class="card-name"></span><span class="card-price"></span></div>
      <div class="card-body"></div>
      <span class="card-owned"></span>
    `
    ;(card.querySelector(".card-name") as HTMLElement).textContent = it.name.toUpperCase()
    const body = card.querySelector(".card-body") as HTMLElement
    const bars: HTMLElement[] = []
    if (st) {
      for (const [label, v, max] of [
        ["DAMAGE", st.damage, statMax.damage],
        ["RADIUS", st.radius, statMax.radius],
        ["TERRAIN", st.terrain, statMax.terrain],
      ] as const) {
        const row = h("div", "card-stat", [h("span", "", [label])])
        const b = segBar(10)
        setSegBar(b, v / max)
        row.append(b)
        body.append(row)
        bars.push(b)
      }
    } else {
      body.append(h("p", "card-desc", [it.desc]))
    }
    card.addEventListener("click", () => {
      selected = it.id
      paintDetail()
    })
    card.addEventListener("dblclick", () => actions.buy(it.id))
    if (it.kind === "weapon") grid.append(card)
    else {
      card.classList.add("up")
      ups.append(card)
    }
    return { el: card, item: it, price: card.querySelector(".card-price") as HTMLElement, owned: card.querySelector(".card-owned") as HTMLElement, bars }
  })

  buy.addEventListener("click", () => {
    if (selected) actions.buy(selected)
  })
  let readyFor = -1
  readyBtn.addEventListener("click", () => {
    readyFor = cur?.view?.phaseEndsAt ?? -1
    actions.ready()
  })

  function paintDetail(): void {
    const it = SHOP.find((x) => x.id === selected)
    if (!it) return
    const color = itemColor(it)
    style(detail, "--wc", color)
    text(dtName, it.name.toUpperCase())
    text(dtPrice, `₵ ${fmtNum(it.price)}`)
    text(dtTag, (it.weapon ? TAGLINES[it.weapon] : "Field upgrade.")?.toUpperCase() ?? "")
    text(dtDesc, it.desc)
    const st = statsOf(it)
    show(dtStats, !!st)
    if (st) {
      setSegBar(dtStatBars[0], st.damage / statMax.damage)
      setSegBar(dtStatBars[1], st.radius / statMax.radius)
      setSegBar(dtStatBars[2], st.terrain / statMax.terrain)
    }
    const tr = it.weapon ? TRAITS[it.weapon] : null
    traits.forEach((t, i) => text(t, tr?.[i] ?? ""))
    for (const c of cards) cls(c.el, "sel", c.item.id === selected)
  }
  paintDetail()

  const scores = new Keyed<PlayerView, ScoreRow>(
    scRows,
    () => {
      const row = h("div", "sc-row")
      row.innerHTML = `<span class="sc-rank"></span><i class="sc-chip"></i><span class="sc-name"></span><span class="sc-ready">${CHECK}</span><span class="sc-cols"><i class="sc-w"></i><i class="sc-k"></i><i class="sc-d"></i><i class="sc-c"></i></span>`
      const g = (s: string) => row.querySelector(s) as HTMLElement
      return { el: row, rank: g(".sc-rank"), chip: g(".sc-chip"), name: g(".sc-name"), w: g(".sc-w"), k: g(".sc-k"), d: g(".sc-d"), c: g(".sc-c"), ready: g(".sc-ready") }
    },
    (row, p, i) => {
      text(row.rank, i + 1)
      style(row.chip, "--c", teamColor(p.team))
      text(row.name, p.name)
      text(row.w, p.wins)
      text(row.k, p.kills)
      text(row.d, fmtNum(p.damage))
      text(row.c, fmtNum(p.credits))
      cls(row.el, "you", p.id === cur.you)
      cls(row.ready, "on", p.locked)
    },
  )

  let invKey = ""
  let timerTotal = 15000
  let timerKey = ""
  let previewKey = ""

  function update(state: UIState): void {
    const view = state.view
    if (!view) return
    cur = state
    const p = me(state)
    const unit = myUnit(state)
    const credits = p?.credits ?? 0
    text(h1, `BATTLE ${Math.min(view.battle + 1, view.battles)} / ${view.battles} — ARMORY`)
    text(crV, fmtNum(credits))

    const left = view.phaseEndsAt - state.serverNow
    const key = String(view.phaseEndsAt)
    if (key !== timerKey) {
      timerKey = key
      timerTotal = Math.max(1000, left)
    }
    text(clock, fmtClock(left))
    style(timerBar, "width", `${(Math.max(0, Math.min(1, left / timerTotal)) * 100).toFixed(1)}%`)
    cls(clock, "urgent", left < 5000)

    // PlayerView has no ready flag, so remember the click for this shop phase
    const ready = readyFor === view.phaseEndsAt || !!p?.locked
    cls(readyBtn, "on", ready)
    text(readyT, ready ? "READY" : "READY UP")
    text(readyN, ready ? "✓" : "")

    for (const c of cards) {
      const afford = credits >= c.item.price
      cls(c.el, "poor", !afford)
      text(c.price, `₵ ${fmtNum(c.item.price)}`)
      const n = c.item.weapon && unit ? unit.ammo[c.item.weapon] ?? 0 : 0
      text(c.owned, n > 0 && n < 99 ? `OWNED ×${n}` : "")
    }

    const it = SHOP.find((x) => x.id === selected)
    if (it) {
      const afford = credits >= it.price
      cls(buy, "poor", !afford)
      buy.disabled = !afford
      const n = it.weapon && unit ? unit.ammo[it.weapon] ?? 0 : 0
      text(buyN, n >= 99 ? "∞" : `×${n}`)
      show(buyN, !!it.weapon)
    }

    // trajectory preview: resize backing store once, redraw every frame for the animated marker
    const rect = canvas.parentElement!.getBoundingClientRect()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const pk = `${Math.round(rect.width)}x${Math.round(rect.height)}@${dpr}`
    if (pk !== previewKey && rect.width > 0) {
      previewKey = pk
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
    }
    if (it && rect.width > 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawPreview(ctx, rect.width, rect.height, it.weapon ?? null, itemColor(it), performance.now())
    }

    // inventory
    const owned = unit ? WEAPON_IDS.filter((id) => (unit.ammo[id] ?? 0) > 0) : []
    const ik = owned.map((id) => `${id}:${unit!.ammo[id]}`).join(",")
    if (ik !== invKey) {
      invKey = ik
      invTiles.replaceChildren()
      const slots = Math.max(8, owned.length)
      for (let i = 0; i < slots; i++) {
        const id = owned[i]
        if (!id) {
          invTiles.append(h("div", "inv-tile empty", ["+"]))
          continue
        }
        const w = WEAPONS[id]
        const n = unit!.ammo[id]
        const tile = h("div", "inv-tile")
        tile.style.setProperty("--wc", w.color)
        tile.innerHTML = `${weaponGlyph(id, 30)}<span class="inv-name"></span><span class="inv-n">${n >= 99 ? "∞" : `×${n}`}</span>`
        ;(tile.querySelector(".inv-name") as HTMLElement).textContent = w.name
        invTiles.append(tile)
      }
      text(invSlots, `${owned.length} WEAPONS LOADED`)
    }

    const ranked = view.players.filter((x) => !x.spectator).sort((a, b) => b.score - a.score || b.kills - a.kills || b.damage - a.damage)
    text(scN, `(${ranked.length})`)
    scores.sync(ranked, (x) => x.id)
    attr(el, "data-ready", ready ? "1" : "0")
  }

  return { el, update }
}
