import { CLUE_KINDS, CLUE_NAMES, evidenceText, leadText, watchMinutes, type Debrief, type NightState } from "../shared/night"
import { SUSPECT_NAMES } from "../shared/verdict"
import type { WoodsState } from "../shared/sim"
import type { WoodsWorld } from "../shared/world"

/**
 * The end of a night (NIGHT.md): the end card (what was found, by whom and when, how long it took), then the debrief,
 * every searcher's path on the survey map with the clues and the ground their tape marked as searched. Shown a few seconds after the night ends, with the pointer
 * free; Search again starts the next night, Keep walking goes back to the woods (Tab opens it again).
 */

const STYLE = `
#night { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; z-index: 20; background: radial-gradient(ellipse at center, rgba(0,0,0,0.35), rgba(0,0,0,0.78)); font-family: system-ui, sans-serif; color: #efe6cc; }
#night.on { display: flex; }
#night .card { background: rgba(10,12,11,0.86); border: 1px solid rgba(239,230,204,0.14); border-radius: 16px; padding: 28px 34px 24px; max-width: min(860px, 92vw); max-height: 92vh; overflow: auto; box-shadow: 0 20px 80px rgba(0,0,0,0.6); }
#night .kicker { font: 600 12px system-ui, sans-serif; letter-spacing: 0.3em; text-transform: uppercase; color: #c9c0a8; }
#night h1 { font: 400 44px/1.05 Georgia, serif; letter-spacing: 0.2em; margin: 10px -0.2em 6px 0; color: #f6eed6; text-shadow: 0 2px 24px rgba(255,214,140,0.25); }
#night .line { font: italic 17px/1.4 Georgia, serif; color: #ddd4bd; margin: 0 0 18px; max-width: 34em; }
#night table { border-collapse: collapse; font-size: 14px; margin: 4px 0 18px; }
#night td { padding: 5px 14px 5px 0; vertical-align: top; }
#night td.n { color: #f2c96b; font-weight: 600; width: 1.4em; }
#night tr.miss td { color: #8d8676; }
#night td.who { color: #c9c0a8; white-space: nowrap; }
#night .lead { font: italic 13px Georgia, serif; color: #b9b19c; max-width: 30em; }
#night .lead b { font-weight: normal; color: #e3c7a0; }
#night .row { display: flex; gap: 10px; flex-wrap: wrap; }
#night button { font: 600 14px system-ui, sans-serif; padding: 10px 18px; border-radius: 10px; border: 1px solid rgba(239,230,204,0.2); background: rgba(255,255,255,0.06); color: #efe6cc; cursor: pointer; }
#night button.go { background: #f2c96b; color: #17130a; border-color: #f2c96b; }
#night button:hover { filter: brightness(1.15); }
#night .debrief { display: flex; gap: 22px; align-items: flex-start; flex-wrap: wrap; }
#night canvas { width: min(520px, 80vw); aspect-ratio: 1; border-radius: 6px; box-shadow: 0 4px 30px rgba(0,0,0,0.5); }
#night .legend { font-size: 13px; line-height: 1.9; min-width: 200px; }
#night .legend i { display: inline-block; width: 18px; height: 3px; border-radius: 2px; margin-right: 8px; vertical-align: middle; }
#night .meta { font-size: 12px; color: #8d8676; margin-top: 10px; }
`

const COLORS = ["#2c5fb8", "#c0392b", "#1e8449", "#8e44ad", "#d35400", "#117a8b", "#7d6608", "#5d6d7e", "#b03a7a", "#2e4053"]
/** "A", "A and B", "A, B and C". */
const list = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`)
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

/** "4:12 AM" from minutes after midnight. */
export function clockText(minutes: number): string {
  const m = Math.floor(minutes) % (24 * 60), h = Math.floor(m / 60), mm = m % 60
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`
}
const span = (s: number) => `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`

export type NightHudHandlers = { again(): void; resume(): void; release(): void }

export class NightHud {
  readonly el = document.createElement("div")
  private showAt = Infinity
  private seed = NaN
  private debrief: Debrief | null = null
  private page: "card" | "debrief" = "card"
  /** Which night this is, for the card (solo counts nights; a room has its own). */
  label = ""

  constructor(private readonly handlers: NightHudHandlers, root: HTMLElement = document.body) {
    const style = document.createElement("style")
    style.textContent = STYLE
    document.head.append(style)
    this.el.id = "night"
    root.append(this.el)
    this.el.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-night]")?.dataset.night
      if (act === "debrief") { this.page = "debrief"; this.render() }
      else if (act === "card") { this.page = "card"; this.render() }
      else if (act === "again") { this.hide(); this.handlers.again() }
      else if (act === "walk") { this.hide(); this.handlers.resume() }
    })
  }

  get visible(): boolean {
    return this.el.classList.contains("on")
  }

  /** The night ended: the card comes up after the last words have been said. */
  ended(debrief: Debrief | undefined, won: boolean): void {
    if (debrief) this.debrief = debrief
    this.showAt = performance.now() + (won ? 5500 : 3500)
  }

  /** Whether a finished night can be shown (Tab after Keep walking). */
  canShow(n: NightState): boolean {
    return n.phase === "won" || n.phase === "lost"
  }

  private state: WoodsState | null = null
  private world: WoodsWorld | null = null

  frame(state: WoodsState, world: WoodsWorld): void {
    this.state = state; this.world = world
    if (state.night.seed !== this.seed) { this.seed = state.night.seed; this.debrief = null; this.showAt = Infinity; if (this.visible) this.hide() }
    if (performance.now() >= this.showAt) { this.showAt = Infinity; this.show() }
  }

  show(): void {
    if (!this.state || !this.canShow(this.state.night)) return
    this.page = "card"
    this.render()
    this.el.classList.add("on")
    this.handlers.release()
  }

  hide(): void {
    this.el.classList.remove("on")
  }

  private render(): void {
    const s = this.state, world = this.world
    if (!s || !world) return
    const n = s.night
    const name = (id: number) => s.players.find((p) => p.id === id)?.name ?? this.debrief?.walkers.find((w) => w.id === id)?.name ?? "Someone"
    const end = watchMinutes(n, s.t)
    const v = n.verdict, culprit = SUSPECT_NAMES[n.layout.verdict.culprit]
    const takenNames = v.gone.map((g) => name(g.id))
    const wrong = v.struck.length ? `You named ${v.struck.map((x) => SUSPECT_NAMES[x]).join(", then ")} first, and it wasn't. ` : ""
    const lost = takenNames.length ? `It took ${list(takenNames)}. ` : ""
    const [title, line] = n.reason === "named"
      ? [`IT WAS ${culprit.toUpperCase()}`, `${wrong}${lost}You named it on the county radio, and the sky came up grey over the ridge. Barbara is still out there.`]
      : n.reason === "taken"
        ? ["TAKEN", `${wrong}It took every one of you before the light came. It was ${culprit}.`]
        : n.reason === "dark"
          ? ["DARK", `Every torch is dead. You sit it out together and wait for the light. ${lost}It was ${culprit}. Barbara is still out there.`]
          : ["DAWN", `The search is called off until it's light. ${wrong}${lost}It was ${culprit}. Barbara is still out there.`]
    const rows = CLUE_KINDS.map((kind, i) => {
      const f = n.finds.find((x) => x.clue === i)
      const clue = n.layout.clues[i]!
      if (!f) return `<tr class="miss"><td class="n">${i + 1}</td><td>${esc(cap(CLUE_NAMES[kind]))}</td><td class="who">not found</td></tr>`
      const ev = evidenceText(n.layout, i)
      return `<tr><td class="n">${i + 1}</td><td>${esc(cap(CLUE_NAMES[kind]))}<div class="lead">${esc(leadText(clue))}${ev ? ` <b>${esc(ev)}</b>` : ""}</div></td><td class="who">${esc(name(f.by))} · ${clockText(watchMinutes(n, f.at))}</td></tr>`
    }).join("")
    const searched = n.end > n.start ? span(n.end - n.start) : ""
    const kicker = [this.label, clockText(end), searched && `searched ${searched}`].filter(Boolean).join(" · ")
    const buttons = (debrief: boolean) => `<div class="row">${debrief ? `<button data-night="card">Back</button>` : `<button data-night="debrief">See the debrief</button>`}<button class="go" data-night="again">Search again</button><button data-night="walk">Keep walking</button></div>`
    if (this.page === "card") {
      this.el.innerHTML = `<div class="card"><div class="kicker">${esc(kicker)}</div><h1>${title}</h1><p class="line">${esc(line)}</p><table>${rows}</table>${buttons(false)}</div>`
      return
    }
    const d = this.debrief
    const walkers = d?.walkers ?? []
    const tapes = d?.tapes ?? []
    const tied = (id: number) => tapes.filter((k) => k[2] === id).length
    const legend = walkers.map((w, i) => `<div><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(w.name)}${w.bot ? "" : " (player)"} · ${Math.round(walked(w.trail))} m · ${tied(w.id)} tapes</div>`).join("")
    const cover = coverage(world, tapes)
    this.el.innerHTML = `<div class="card"><div class="kicker">Debrief · ${esc(kicker)}</div><h1>${title}</h1><div class="debrief"><canvas width="1040" height="1040"></canvas><div class="legend">${legend || "<div>No paths recorded.</div>"}<div class="meta">Pink is ground your tape marked as searched: ${tapes.length} tapes, about ${cover.all} m² (${Math.round((cover.near / (Math.PI * COVER_AROUND * COVER_AROUND)) * 100)}% of the woods within ${COVER_AROUND} m of camp). Numbers are the clues in order; red ones were found, with the bearings they gave.${n.verdict.gone.length ? " Black crosses: where the taken were standing." : ""}</div></div></div><div style="height:16px"></div>${buttons(true)}</div>`
    drawDebrief(this.el.querySelector("canvas")!, world, n, walkers, tapes)
  }
}

const cap = (t: string) => t[0]!.toUpperCase() + t.slice(1)
function walked(trail: readonly number[]): number {
  let d = 0
  for (let i = 2; i + 1 < trail.length; i += 2) d += Math.hypot(trail[i]! - trail[i - 2]!, trail[i + 1]! - trail[i - 1]!)
  return d
}

/** A tape marks the ground within this of it as searched (m): a torch sweep either side. */
const TAPE_COVER = 12

/** The debrief's share is of the woods within this of camp (m). */
const COVER_AROUND = 140

/** Square metres within `TAPE_COVER` of any tape, all told and within `COVER_AROUND` of camp (a 2 m grid). */
function coverage(world: WoodsWorld, tapes: readonly number[][]): { all: number; near: number } {
  if (!tapes.length) return { all: 0, near: 0 }
  const h = world.params.half
  let all = 0, near = 0
  for (let x = -h; x < h; x += 2) for (let z = -h; z < h; z += 2) {
    if (!tapes.some((k) => Math.abs(k[0]! - x) < TAPE_COVER && Math.abs(k[1]! - z) < TAPE_COVER && Math.hypot(k[0]! - x, k[1]! - z) < TAPE_COVER)) continue
    all++
    if (Math.hypot(x - world.camp.x, z - world.camp.z) < COVER_AROUND) near++
  }
  return { all: all * 4, near: near * 4 }
}

/** The survey square as a plain sketch: lake, path, camp, the ridge light, searched ground, paths, clues and bearings. */
function drawDebrief(canvas: HTMLCanvasElement, world: WoodsWorld, n: NightState, walkers: Debrief["walkers"], tapes: readonly number[][]): void {
  const g = canvas.getContext("2d")!
  const S = canvas.width, h = world.params.half, k = S / (h * 2)
  const at = (x: number, z: number): [number, number] => [(x + h) * k, (z + h) * k]
  g.fillStyle = "#ebe4d1"; g.fillRect(0, 0, S, S)
  // A faint 50 m grid.
  g.strokeStyle = "rgba(90,80,60,0.12)"; g.lineWidth = 1
  for (let v = -h; v <= h; v += 50) { const [p] = at(v, 0); g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke(); g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke() }
  const L = world.lake, [lx, lz] = at(L.x, L.z)
  g.fillStyle = "rgba(110,150,175,0.55)"; g.beginPath(); g.ellipse(lx, lz, L.rx * k, L.rz * k, 0, 0, Math.PI * 2); g.fill()
  g.strokeStyle = "rgba(30,30,30,0.55)"; g.setLineDash([10, 7]); g.lineWidth = 2.5
  g.beginPath(); world.trail.points.forEach(([x, z], i) => { const [px, pz] = at(x, z); if (i) g.lineTo(px, pz); else g.moveTo(px, pz) }); g.stroke(); g.setLineDash([])
  const [cx, cz] = at(world.camp.x, world.camp.z)
  g.strokeStyle = "rgba(60,50,40,0.6)"; g.lineWidth = 2; g.beginPath(); g.arc(cx, cz, world.camp.radius * k, 0, Math.PI * 2); g.stroke()
  g.fillStyle = "rgba(50,45,35,0.85)"; g.font = "600 22px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"
  g.fillText("CAMP", cx, cz)
  g.font = "italic 24px Georgia, serif"
  const [rx, rz] = at(n.layout.ridge.x, n.layout.ridge.z)
  g.fillText("Radio tower", rx, rz - 20)
  g.fillStyle = "#c0392b"; g.beginPath(); g.arc(rx, rz, 6, 0, Math.PI * 2); g.fill()
  // The searched ground: every tape's sweep, drawn once as one soft pink area.
  g.fillStyle = "rgba(230,40,135,0.16)"
  g.beginPath()
  for (const tp of tapes) { const [px, pz] = at(tp[0]!, tp[1]!); g.moveTo(px + TAPE_COVER * k, pz); g.arc(px, pz, TAPE_COVER * k, 0, Math.PI * 2) }
  g.fill()
  g.fillStyle = "rgba(230,40,135,0.9)"
  for (const tp of tapes) { const [px, pz] = at(tp[0]!, tp[1]!); g.fillRect(px - 3, pz - 3, 6, 6) }
  // Where each taken searcher was standing: a black cross.
  g.strokeStyle = "#111"; g.lineWidth = 3
  for (const t of n.verdict.gone) { const [px, pz] = at(t.x, t.z); g.beginPath(); g.moveTo(px - 7, pz - 7); g.lineTo(px + 7, pz + 7); g.moveTo(px + 7, pz - 7); g.lineTo(px - 7, pz + 7); g.stroke() }
  // Everyone's path.
  walkers.forEach((w, i) => {
    g.strokeStyle = COLORS[i % COLORS.length]!; g.globalAlpha = w.bot ? 0.65 : 0.95; g.lineWidth = w.bot ? 2.5 : 4; g.lineJoin = g.lineCap = "round"
    g.beginPath()
    for (let j = 0; j + 1 < w.trail.length; j += 2) { const [px, pz] = at(w.trail[j]!, w.trail[j + 1]!); if (j) g.lineTo(px, pz); else g.moveTo(px, pz) }
    g.stroke()
  })
  g.globalAlpha = 1
  // The clues: found ones in red with the bearing they gave, missed ones as grey dashed rings.
  for (const c of n.layout.clues) {
    const found = n.finds.some((f) => f.clue === c.id)
    const [px, pz] = at(c.x, c.z)
    if (found) for (const l of c.leads) {
      const place = l.ridge ? n.layout.ridge : null
      const len = place ? Math.hypot(place.x - l.x, place.z - l.z) : c.kind === "car" ? 125 : 150
      g.strokeStyle = "rgba(176,34,30,0.6)"; g.setLineDash([8, 6]); g.lineWidth = 2
      g.beginPath(); g.moveTo(px, pz); g.lineTo(px + l.dx * len * k, pz + l.dz * len * k); g.stroke(); g.setLineDash([])
    }
    g.fillStyle = found ? "#b0221e" : "rgba(235,228,209,0.9)"; g.strokeStyle = found ? "#5a0d0b" : "rgba(80,70,60,0.7)"; g.lineWidth = 2
    if (!found) g.setLineDash([4, 3])
    g.beginPath(); g.arc(px, pz, 14, 0, Math.PI * 2); g.fill(); g.stroke(); g.setLineDash([])
    g.fillStyle = found ? "#fff" : "rgba(80,70,60,0.9)"; g.font = "700 17px system-ui, sans-serif"
    g.fillText(String(c.id + 1), px, pz + 1)
  }
}
