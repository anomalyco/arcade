import type { DebugTab } from "../dev/debug-menu"
import { type LoopHandle, type Shot, sfx } from "./sfx-bank"
import { CATEGORIES, SLOTS, type SlotCategory } from "./sfx-slots"

const CSS = /* css */ `
.panel:has(.sounds-lab) { width: 720px; }
.sounds-lab .bar { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px; }
.sounds-lab .bar button { flex: 0 0 auto; }
.sounds-lab .help { margin: 8px 0 2px; opacity: 0.6; text-transform: none; letter-spacing: 0.04em; line-height: 1.45; }
.sounds-lab .slot { border-top: 1px solid rgba(255,255,255,0.1); padding: 7px 0 6px; }
.sounds-lab .head { display: grid; grid-template-columns: 1fr 150px 54px; gap: 8px; align-items: center; }
.sounds-lab .head b { font-weight: 400; letter-spacing: 0.14em; }
.sounds-lab .head .id { opacity: 0.45; letter-spacing: 0.06em; margin-left: 6px; text-transform: none; }
.sounds-lab .head .v { text-align: right; font-variant-numeric: tabular-nums; }
.sounds-lab .takes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 5px; }
.sounds-lab .take { display: flex; align-items: center; gap: 3px; padding: 3px; border: 1px solid rgba(255,255,255,0.1); }
.sounds-lab .take.picked { border-color: rgba(255, 214, 120, 0.8); background: rgba(255, 214, 120, 0.08); }
.sounds-lab .take button { flex: 0 0 auto; padding: 2px 6px; }
.sounds-lab .take button.playing { background: rgba(196,226,255,0.3); }
.sounds-lab .take .star.on { color: #ffd678; border-color: rgba(255,214,120,0.8); }
.sounds-lab .stars { display: flex; gap: 1px; margin-left: auto; }
.sounds-lab .stars i { width: 9px; height: 9px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.35); cursor: pointer; font-style: normal; }
.sounds-lab .stars i.on { background: #ffd678; border-color: #ffd678; }
.sounds-lab .meta { opacity: 0.45; font-size: 9px; letter-spacing: 0.04em; text-transform: none; }
.sounds-lab .prompt { opacity: 0.4; font-size: 9px; letter-spacing: 0.02em; text-transform: none; margin-top: 4px; line-height: 1.35; }
.sounds-lab .note { margin-top: 6px; opacity: 0.7; text-transform: none; letter-spacing: 0.04em; }
`

type Where = "dry" | "near" | "mid" | "far"
const DIST: Record<Exclude<Where, "dry">, number> = { near: 40, mid: 300, far: 1500 }

/**
 * SOUNDS, the debug menu's audition board (also `?sounds=1`): every sound slot in the game with its candidate takes.
 * ▶ plays a take (loops toggle) dry or in context (through the game's spatial chain and reverb at 40 m, 300 m or
 * 1.5 km, from the chase view or behind the cockpit canopy); ★ picks the take the game plays (live); the slider trims the
 * slot's level; the dots rate each take 1-5 (pooled one-shots such as explosions then vary between the 4-5 star
 * takes). Picks persist in localStorage; COPY PICKS exports them as JSON, and in the dev server SAVE writes
 * public/sfx/picks.json, the defaults the shipped game starts from.
 */
export class SoundsLab {
  readonly tab: DebugTab
  private el = document.createElement("div")
  private where: Where = "near"
  private cockpit = false
  private cat: SlotCategory | "all" = "all"
  private playing: { key: string; shot: Shot | null; loop: LoopHandle | null; btn: HTMLButtonElement } | null = null
  private status!: HTMLElement
  private list!: HTMLElement
  private note!: HTMLElement
  private lastUi = 0

  constructor() {
    const bank = sfx()
    this.el.className = "sounds-lab"
    const dev = import.meta.env.DEV
    this.el.innerHTML = `
      <div class="status"><span class="k">Sounds</span><span class="v" data-s></span></div>
      <div class="help">Listen and choose. ▶ plays a take (loops: ▶ again stops). ★ makes it the one the game plays, at once.
        The slider trims the slot's level. Dots rate takes 1-5; explosions and other varied sounds play a random 4-5★ take.
        Play "in context" to hear it placed in the world with the reverb, or dry. Picks are saved in this browser;
        COPY PICKS (or SAVE in the dev server) to bake them into the game.</div>
      <div class="bar">
        <button data-where="dry">Dry</button><button data-where="near">Near 40 m</button><button data-where="mid">Mid 300 m</button><button data-where="far">Far 1.5 km</button>
        <button data-act="cockpit">Cockpit</button><button data-act="stop">■ Stop</button>
      </div>
      <div class="bar">
        <button data-act="copy">Copy picks</button>${dev ? `<button data-act="save">Save picks.json</button>` : ""}<button data-act="reset">Reset to shipped</button>
      </div>
      <div class="bar"><button data-cat="all">All</button>${CATEGORIES.map((c) => `<button data-cat="${c}">${c}</button>`).join("")}</div>
      <div class="note"></div>
      <div class="list"></div>`
    this.status = this.el.querySelector("[data-s]")!
    this.list = this.el.querySelector(".list")!
    this.note = this.el.querySelector(".note")!
    this.el.addEventListener("click", (e) => this.click(e))
    this.el.addEventListener("input", (e) => {
      const i = e.target as HTMLInputElement
      const slot = i.dataset.trim
      if (!slot) return
      bank.setTrim(slot, Number(i.value))
      this.el.querySelector(`[data-trimv="${slot}"]`)!.textContent = `${Number(i.value) > 0 ? "+" : ""}${Number(i.value).toFixed(1)} dB`
      this.refreshStatus()
    })
    this.tab = {
      id: "sounds",
      label: "Sounds",
      css: CSS,
      mount: (el) => {
        el.append(this.el)
        this.render()
      },
      unmount: () => {
        this.stop()
        bank.mixer.forceCockpit = null
      },
      frame: () => {
        const now = performance.now()
        if (now - this.lastUi > 500) {
          this.lastUi = now
          this.refreshStatus()
        }
        // A finished one-shot releases its button.
        const p = this.playing
        if (p?.shot && bank.mixer.ctx && bank.mixer.ctx.currentTime > p.shot.end) this.stop()
      },
    }
  }

  private refreshStatus(): void {
    const b = sfx()
    const total = SLOTS.reduce((n, s) => n + s.count, 0)
    this.status.textContent = `${SLOTS.length} slots · ${total} takes · ${b.loaded} loaded · ${b.changed} changed here`
  }

  private render(): void {
    const b = sfx()
    for (const btn of this.el.querySelectorAll<HTMLButtonElement>("[data-where]")) btn.classList.toggle("on", btn.dataset.where === this.where)
    for (const btn of this.el.querySelectorAll<HTMLButtonElement>("[data-cat]")) btn.classList.toggle("on", btn.dataset.cat === this.cat)
    this.el.querySelector('[data-act="cockpit"]')!.classList.toggle("on", this.cockpit)
    const rows: string[] = []
    for (const s of SLOTS) {
      if (this.cat !== "all" && s.category !== this.cat) continue
      const pick = b.take(s.id)
      const r = b.ratings(s.id)
      const trim = b.trim(s.id)
      const takes: string[] = []
      for (let t = 1; t <= s.count; t++) {
        const info = b.info(s.id, t)
        const stars = Array.from({ length: 5 }, (_, k) => `<i data-rate="${s.id}:${t}:${k + 1}" class="${(r[t - 1] ?? 0) > k ? "on" : ""}"></i>`).join("")
        takes.push(`<div class="take ${t === pick ? "picked" : ""}">
          <button data-play="${s.id}:${t}">▶ ${t}</button><button class="star ${t === pick ? "on" : ""}" data-pick="${s.id}:${t}" title="Use this take">★</button>
          <span class="meta">${info ? `${(info.loop ?? info.dur).toFixed(1)}s` : "—"}</span><span class="stars">${stars}</span></div>`)
      }
      rows.push(`<div class="slot" data-slot="${s.id}">
        <div class="head"><span><b>${s.label}</b><span class="id">${s.id}${s.loop ? " · loop" : ""}</span></span>
          <input type="range" min="-18" max="12" step="0.5" value="${trim}" data-trim="${s.id}"><span class="v" data-trimv="${s.id}">${trim > 0 ? "+" : ""}${trim.toFixed(1)} dB</span></div>
        <div class="takes">${takes.join("")}</div>
        <div class="prompt">${s.prompt.replace(/</g, "&lt;")}</div></div>`)
    }
    this.list.innerHTML = rows.join("")
    this.refreshStatus()
  }

  private stop(): void {
    const p = this.playing
    if (!p) return
    p.shot?.stop(0.08)
    p.loop?.stop(0.15)
    p.btn.classList.remove("playing")
    this.playing = null
  }

  private async click(e: Event): Promise<void> {
    const t = (e.target as HTMLElement).closest("button, i") as HTMLElement | null
    if (!t) return
    const bank = sfx()
    bank.mixer.start()
    const d = t.dataset
    if (d.where) {
      this.where = d.where as Where
      this.render()
    } else if (d.cat) {
      this.cat = d.cat as SlotCategory | "all"
      this.render()
    } else if (d.act === "cockpit") {
      this.cockpit = !this.cockpit
      bank.mixer.forceCockpit = this.cockpit ? 1 : null
      bank.mixer.setCockpit(this.cockpit ? 1 : 0)
      this.render()
    } else if (d.act === "stop") this.stop()
    else if (d.act === "copy") {
      const json = JSON.stringify(bank.export(), null, 1)
      await navigator.clipboard?.writeText(json).catch(() => undefined)
      this.note.textContent = `Copied picks for ${SLOTS.length} slots (${json.length} bytes). Paste them to the team, or into public/sfx/picks.json.`
    } else if (d.act === "save") {
      const r = await fetch("/__sfx/picks", { method: "POST", body: JSON.stringify(bank.export()) }).catch(() => null)
      this.note.textContent = r?.ok ? `Saved public/sfx/picks.json: the next build ships these picks.` : `Save failed (only works in the dev server).`
    } else if (d.act === "reset") {
      bank.reset()
      this.note.textContent = "Back to the shipped picks."
      this.render()
    } else if (d.pick) {
      const [slot, take] = d.pick.split(":")
      bank.setPick(slot!, Number(take))
      this.render()
    } else if (d.rate) {
      const [slot, take, stars] = d.rate.split(":")
      const cur = bank.ratings(slot!)[Number(take) - 1] ?? 0
      bank.setRating(slot!, Number(take), cur === Number(stars) ? 0 : Number(stars))
      this.render()
    } else if (d.play) {
      const key = d.play
      const was = this.playing?.key === key
      this.stop()
      if (was) return
      const [slot, takeS] = key.split(":")
      const take = Number(takeS)
      const btn = t as HTMLButtonElement
      btn.textContent = `… ${take}`
      const buf = await bank.fetch(slot!, take)
      btn.textContent = `▶ ${take}`
      if (!buf) {
        this.note.textContent = `${slot}-${take} could not load.`
        return
      }
      const place = this.where === "dry" ? { reverb: 0 } : { local: { x: 12, y: 3, z: -DIST[this.where] }, travel: false }
      const s = SLOTS.find((x) => x.id === slot)!
      if (s.loop) {
        const loop = bank.loop(slot!, { take, ...place })
        loop?.set({ gain: 1 })
        this.playing = { key, shot: null, loop, btn }
      } else {
        const shot = bank.play(slot!, { take, ...place })
        this.playing = { key, shot, loop: null, btn }
      }
      btn.classList.add("playing")
    }
  }
}
