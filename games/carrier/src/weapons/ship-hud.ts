import { type Crew, type CrewPlayer, TEAMS } from "../../shared/crew"
import { ISLAND } from "../../shared/carrier-spec"
import { FLEET, type Hull, deckOpen } from "../../shared/fleet"
import { shipToWorld, type ShipPoseLike, type Vec3 } from "../../shared/plane"

type Projector = { project(x: number, y: number, z: number, w: number, h: number): { x: number; y: number } | null; eye: ArrayLike<number> }
type HudShip = ShipPoseLike & { id: number; team: number }

const CSS = `
#sh { position: fixed; inset: 0; pointer-events: none; color: var(--ink); font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; font-weight: 300;
  text-transform: uppercase; text-shadow: 0 1px 6px rgba(10, 30, 60, 0.5); }
#sh [hidden] { display: none !important; }
#sh .own { position: absolute; left: 22px; bottom: 56px; display: flex; align-items: center; gap: 10px; font-size: 10px; letter-spacing: 0.3em; zoom: var(--hud, 1); }
#sh .own .bar { position: relative; width: 132px; height: 3px; background: rgba(244, 247, 251, 0.22); }
#sh .own .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ink); transition: width 0.25s; }
#sh .own.mid .bar i { background: #ffc861; }
#sh .own.low .bar i { background: #ff5a3a; box-shadow: 0 0 6px rgba(255, 70, 40, 0.7); }
#sh .own .tag { color: #ffc861; }
#sh .own.low .tag, #sh .own .tag.sink { color: #ff5a3a; }
#sh .enemy { position: absolute; left: 0; top: 0; width: 64px; margin-left: -32px; will-change: transform; display: grid; gap: 3px; justify-items: center;
  font-size: 9px; letter-spacing: 0.25em; opacity: 0.85; }
#sh .enemy .bar { position: relative; width: 64px; height: 2px; background: rgba(244, 247, 251, 0.25); }
#sh .enemy .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--tc, #f4f7fb); }
#sh .flash { position: absolute; inset: 0; opacity: 0; box-shadow: inset 0 0 160px 40px rgba(255, 40, 20, 0.55); transition: opacity 0.08s; }
body.mn-open #sh { display: none; }
`

const v: Vec3 = [0, 0, 0]

/**
 * Carrier health on screen, no instruction text: your ship's hull as a thin bar above the role line (amber below half,
 * red below a quarter, DECK FIRE / SINKING beside it), a red flash at the screen edges when your ship is hit (stronger
 * for bigger hits, presentation only), and in the air a small health bar over the enemy carrier nearest your sights.
 */
export class ShipHud {
  readonly root: HTMLElement
  private own: HTMLElement
  private ownFill: HTMLElement
  private tag: HTMLElement
  private enemy: HTMLElement
  private enemyFill: HTMLElement
  private enemyName: HTMLElement
  private flashEl: HTMLElement
  private flash = 0
  private lastHp = new Map<number, number>()
  private key = ""

  constructor(parent: HTMLElement = document.body) {
    if (!document.getElementById("sh-css")) {
      const style = document.createElement("style")
      style.id = "sh-css"
      style.textContent = CSS
      document.head.append(style)
    }
    const root = document.createElement("div")
    root.id = "sh"
    root.innerHTML = `<div class="flash"></div><div class="own" hidden><span>HULL</span><span class="bar"><i></i></span><span class="tag"></span></div>
<div class="enemy" hidden><span class="name"></span><span class="bar"><i></i></span></div>`
    parent.append(root)
    this.root = root
    const q = (s: string) => root.querySelector<HTMLElement>(s)!
    this.own = q(".own")
    this.ownFill = q(".own .bar i")
    this.tag = q(".own .tag")
    this.enemy = q(".enemy")
    this.enemyFill = q(".enemy .bar i")
    this.enemyName = q(".enemy .name")
    this.flashEl = q(".flash")
  }

  /**
   * Per frame. `me`: the player (null: not aboard). `cam`: the flight camera while flying (the enemy bar shows only
   * then). `paused`: a menu is open (the bars stay, the flash doesn't start).
   */
  update(dt: number, t: number, me: CrewPlayer | null, crew: Crew | null, ships: readonly HudShip[], hulls: ReadonlyMap<number, Hull> | null, cam: Projector | null, flying: boolean, paused: boolean): void {
    this.flash = Math.max(0, this.flash - dt * 1.8)
    const mine = me && hulls?.get(me.ship)
    if (hulls)
      for (const [id, h] of hulls) {
        const before = this.lastHp.get(id)
        // Our ship hit: flash the edges (a bomb hard, a gun run barely).
        if (me && id === me.ship && before !== undefined && h.hp < before - 0.01 && !paused) this.flash = Math.min(1, Math.max(this.flash, 0.25 + (before - h.hp) / 120))
        this.lastHp.set(id, h.hp)
      }
    this.flashEl.style.opacity = this.flash.toFixed(3)
    this.own.hidden = !mine
    if (mine) {
      const pct = Math.max(0, mine.hp / FLEET.hp)
      const sinking = mine.sinkAt !== -1
      const tag = sinking ? "SINKING" : !deckOpen(mine, t) ? "DECK FIRE" : ""
      const key = `${Math.round(pct * 200)}|${tag}`
      if (key !== this.key) {
        this.key = key
        this.ownFill.style.width = `${(pct * 100).toFixed(1)}%`
        this.own.classList.toggle("mid", pct < 0.5 && pct >= 0.25)
        this.own.classList.toggle("low", pct < 0.25)
        this.tag.textContent = tag
        this.tag.classList.toggle("sink", sinking)
      }
    }
    // The enemy carrier nearest the sights, within 6 km.
    let best: { s: HudShip; x: number; y: number; d: number } | null = null
    if (flying && cam && me && hulls) {
      const cx = innerWidth / 2
      const cy = innerHeight / 2
      for (const s of ships) {
        if (s.team === me.team || !hulls.get(s.id)) continue
        const p = shipToWorld(s, (ISLAND.x0 + ISLAND.x1) / 2, ISLAND.y1 + 14, (ISLAND.z0 + ISLAND.z1) / 2, v)
        const dist = Math.hypot(p[0] - cam.eye[0]!, p[1] - cam.eye[1]!, p[2] - cam.eye[2]!)
        if (dist > 6000) continue
        const at = cam.project(p[0], p[1], p[2], innerWidth, innerHeight)
        if (!at) continue
        const off = Math.hypot(at.x - cx, at.y - cy) / Math.min(innerWidth, innerHeight)
        if (off > 0.32) continue
        if (!best || off < best.d) best = { s, x: at.x, y: at.y, d: off }
      }
    }
    this.enemy.hidden = !best
    if (best) {
      const h = hulls!.get(best.s.id)!
      this.enemy.style.transform = `translate(${best.x.toFixed(1)}px, ${(best.y - 18).toFixed(1)}px)`
      this.enemy.style.setProperty("--tc", TEAMS[best.s.team]?.color ?? "#f4f7fb")
      this.enemyFill.style.width = `${Math.max(0, (h.hp / FLEET.hp) * 100).toFixed(1)}%`
      const name = crew?.ships.find((x) => x.id === best!.s.id)?.name ?? ""
      if (this.enemyName.textContent !== name) this.enemyName.textContent = name
    }
  }
}
