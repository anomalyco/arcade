import type { WeaponKind } from "../../shared/weapons"
import { HitMarker } from "../ui/hit-marker"
import { Reticle, type ReticleView } from "./reticle"

/** What the weapons HUD shows each frame. */
export type WeaponHudView = {
  /** The aircraft's weapons in slot order, and the selected slot. */
  weapons: readonly WeaponKind[]
  slot: number
  /** Gun heat 0..1 and whether it is locked out. */
  heat: number
  overheated: boolean
  missiles: number
  missileMax: number
  bombs: number
  bombMax: number
  flares: number
  flareMax: number
  /** Health 0..100 (the bar shows only when damaged). */
  hp: number
  /** The seeker's box on screen (CSS px): lock progress 0..1, locked. Null when nothing is tracked. */
  lock: { x: number; y: number; progress: number; locked: boolean } | null
  /** 0 none, 1 an enemy is locking or locked on us, 2 a missile is inbound. */
  warn: 0 | 1 | 2
  /** The boresight on screen (the hit marker and the reticle sit on it). */
  nose: { x: number; y: number } | null
  /** The seeker's lock cone radius on screen (CSS px), projected through the live camera. */
  cone: number
  /** Rearm progress of the next missile, 0..1. */
  rearm: number
  /** The gun's lead cue on screen (src/weapons/reticle.ts gunLead), or null. */
  lead: ReticleView["lead"]
}

const LABEL: Record<WeaponKind, string> = { gun: "GUN", missile: "AIM-9", bomb: "BOMB" }

const CSS = `
#wp { position: fixed; inset: 0; pointer-events: none; color: var(--ink); font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace;
  font-weight: 300; text-transform: uppercase; text-shadow: 0 1px 8px rgba(10, 30, 60, 0.45); }
#wp[hidden], #wp [hidden] { display: none !important; }
#wp .arm { position: absolute; right: 28px; bottom: 112px; display: flex; gap: 18px; align-items: center; font-size: 11px; letter-spacing: 0.28em; margin-right: -0.28em; zoom: var(--hud, 1); }
#wp .w { display: flex; align-items: center; gap: 8px; opacity: 0.42; }
#wp .w.on { opacity: 1; }
#wp .w.on::before { content: ""; width: 0; height: 0; border-left: 5px solid currentColor; border-top: 4px solid transparent; border-bottom: 4px solid transparent; margin-right: -2px; }
#wp .heat { position: relative; width: 46px; height: 4px; border: 1px solid rgba(244, 247, 251, 0.75); }
#wp .heat i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ink); }
#wp .heat.hot i { background: #ff8a3d; box-shadow: 0 0 8px #ff6a1a; }
#wp .pips { display: flex; gap: 4px; }
#wp .pips b { width: 4px; height: 10px; border: 1px solid rgba(244, 247, 251, 0.75); }
#wp .pips b.full { background: var(--ink); }
#wp .hp { position: absolute; right: 28px; bottom: 102px; width: 120px; height: 2px; background: rgba(244, 247, 251, 0.25); zoom: var(--hud, 1); }
#wp .hp i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ink); }
#wp .hp.smoke i { background: #ffc861; }
#wp .hp.fire i { background: #ff5a3a; box-shadow: 0 0 6px #ff3a1a; }
#wp .mark { position: absolute; left: 0; top: 0; will-change: transform; }
#wp .lock { width: 60px; height: 60px; margin: -30px 0 0 -30px; border: 1.5px dashed rgba(255, 200, 97, 0.9); box-shadow: 0 0 6px rgba(60, 30, 0, 0.35); }
#wp .lock.locked { border: 2px solid #ff5a3a; box-shadow: 0 0 10px rgba(255, 70, 40, 0.6); }
#wp .warn { position: absolute; left: 50%; top: 24%; transform: translateX(-50%); font-size: 14px; letter-spacing: 0.6em; margin-right: -0.6em; color: #ffc861; zoom: var(--hud, 1); }
#wp .warn.missile { color: #ff5a3a; animation: wp-pulse 0.25s steps(2, jump-none) infinite; }
@keyframes wp-pulse { from { opacity: 1 } to { opacity: 0.3 } }
#wp .feed { position: absolute; right: 22px; top: 50px; display: grid; justify-items: end; gap: 5px; font-size: 13.5px; letter-spacing: 0.22em; zoom: var(--hud, 1); }
#wp .feed div { padding: 5px 9px 5px calc(9px + 0.22em); background: rgba(6, 16, 30, 0.62); box-shadow: 0 0 0 1px rgba(244, 247, 251, 0.08) inset;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7), 0 0 10px rgba(0, 0, 0, 0.35); transition: opacity 0.6s; white-space: nowrap; }
#wp .feed .x { color: var(--ink); opacity: 0.75; margin: 0 0.6em; }
#wp .conf { position: absolute; left: 50%; top: 33%; transform: translateX(-50%); font-size: 14px; letter-spacing: 0.4em; white-space: nowrap;
  padding: 6px 12px 6px calc(12px + 0.4em); background: rgba(6, 16, 30, 0.5);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7), 0 0 10px rgba(0, 0, 0, 0.4); opacity: 0; transition: opacity 0.25s; zoom: var(--hud, 1); }
#wp .conf.on { opacity: 1; }
#wp .conf b { font-weight: 300; }
body.mn-open #wp { display: none; }
`

const FEED_TIME = 6
const FEED_MAX = 4
const CONFIRM_TIME = 1.5

/**
 * Weapons HUD, Blackout/Carrier typography, no instruction text: the aircraft's weapons in a row above the flight
 * readout (the selected one bright: a heat bar for the gun, pips for missiles and bombs), flare pips, a thin health bar
 * while damaged, the selected weapon's reticle on the boresight (src/weapons/reticle.ts: gunsight or seeker circle),
 * the seeker's box on the target (dashed while locking, closing in; solid red when locked), LOCK / a
 * flashing MISSILE warning, a brief hit marker on the boresight, a kill feed top right (newest on top) and a brief
 * SHOT DOWN · NAME confirmation for our own kills.
 */
export class WeaponHud {
  readonly root: HTMLElement
  private arm: HTMLElement
  private hpBar: HTMLElement
  private hpFill: HTMLElement
  private lockBox: HTMLElement
  private marker: HitMarker
  private reticle: Reticle
  private reticleView: ReticleView = { weapon: "gun", nose: { x: 0, y: 0 }, cone: 0, overheated: false, lead: null, missiles: 0, missileMax: 0, rearm: 0, lock: null }
  private warnEl: HTMLElement
  private feedEl: HTMLElement
  private confEl: HTMLElement
  private confLeft = 0
  private lastArm = ""
  private lastHp = ""
  private feedLines: { el: HTMLElement; left: number }[] = []

  constructor(parent: HTMLElement = document.body) {
    if (!document.getElementById("wp-css")) {
      const style = document.createElement("style")
      style.id = "wp-css"
      style.textContent = CSS
      document.head.append(style)
    }
    const root = document.createElement("div")
    root.id = "wp"
    root.innerHTML = `<div class="arm"></div><div class="hp" hidden><i></i></div><div class="mark lock" hidden></div>
<div class="warn"></div><div class="feed"></div><div class="conf"></div>`
    parent.append(root)
    this.root = root
    const q = (s: string) => root.querySelector<HTMLElement>(s)!
    this.arm = q(".arm")
    this.hpBar = q(".hp")
    this.hpFill = q(".hp i")
    this.lockBox = q(".lock")
    this.reticle = new Reticle(root)
    this.marker = new HitMarker(root)
    this.warnEl = q(".warn")
    this.feedEl = q(".feed")
    this.confEl = q(".conf")
  }

  /** Per frame: the readout, or null to hide it (not flying). `dt` runs the hit marker and the feed. */
  update(dt: number, v: WeaponHudView | null): void {
    if (this.confLeft > 0) {
      this.confLeft -= dt
      if (this.confLeft <= 0) this.confEl.classList.remove("on")
    }
    this.marker.hidden = !v?.nose
    if (v?.nose) this.marker.place(v.nose.x, v.nose.y)
    for (let i = this.feedLines.length - 1; i >= 0; i--) {
      const l = this.feedLines[i]!
      l.left -= dt
      if (l.left < 0.6) l.el.style.opacity = "0"
      if (l.left <= 0) {
        l.el.remove()
        this.feedLines.splice(i, 1)
      }
    }
    const weapon = v?.weapons[v.slot]
    if (v?.nose && weapon) {
      const r = this.reticleView
      r.weapon = weapon
      r.nose = v.nose
      r.cone = v.cone
      r.overheated = v.overheated
      r.lead = v.lead
      r.missiles = v.missiles
      r.missileMax = v.missileMax
      r.rearm = v.rearm
      r.lock = v.lock
      this.reticle.update(dt, r)
    } else this.reticle.update(dt, null)
    this.arm.hidden = !v
    if (!v) {
      this.hpBar.hidden = true
      this.lockBox.hidden = true
      if (this.warnEl.textContent) this.warnEl.textContent = ""
      return
    }
    const key = `${v.weapons.join()}|${v.slot}|${Math.round(v.heat * 46)}|${v.overheated}|${v.missiles}/${v.missileMax}|${v.bombs}/${v.bombMax}|${v.flares}/${v.flareMax}`
    if (key !== this.lastArm) {
      this.lastArm = key
      const pips = (n: number, max: number) => `<span class="pips">${Array.from({ length: max }, (_, i) => `<b class="${i < n ? "full" : ""}"></b>`).join("")}</span>`
      const parts = v.weapons.map((w, i) => {
        const on = i === v.slot ? " on" : ""
        if (w === "gun") return `<span class="w${on}">${LABEL[w]}<span class="heat${v.overheated ? " hot" : ""}"><i style="width:${(v.heat * 100).toFixed(1)}%"></i></span></span>`
        if (w === "missile") return `<span class="w${on}">${LABEL[w]}${pips(v.missiles, v.missileMax)}</span>`
        return `<span class="w${on}">${LABEL[w]}${pips(v.bombs, v.bombMax)}</span>`
      })
      parts.push(`<span class="w on flr">FLR${pips(v.flares, v.flareMax)}</span>`)
      this.arm.innerHTML = parts.join("")
      // The flares group has no selection marker.
      const flr = this.arm.querySelector<HTMLElement>(".flr")
      if (flr) flr.classList.remove("on")
      if (flr) flr.style.opacity = "1"
    }
    const hpKey = `${Math.round(v.hp)}`
    if (hpKey !== this.lastHp) {
      this.lastHp = hpKey
      this.hpBar.hidden = v.hp >= 99.5
      this.hpFill.style.width = `${Math.max(0, v.hp).toFixed(0)}%`
      this.hpBar.classList.toggle("smoke", v.hp < 50 && v.hp >= 25)
      this.hpBar.classList.toggle("fire", v.hp < 25)
    }
    const l = v.lock
    this.lockBox.hidden = !l
    if (l) {
      // Closes from 2.2x to 1x as the lock builds.
      const s = l.locked ? 0.62 : 0.62 + (1 - l.progress) * 0.75
      this.lockBox.style.transform = `translate(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px) scale(${s.toFixed(3)})`
      this.lockBox.classList.toggle("locked", l.locked)
    }
    const warn = v.warn === 2 ? "MISSILE" : v.warn === 1 ? "LOCK" : ""
    if (this.warnEl.textContent !== warn) this.warnEl.textContent = warn
    this.warnEl.classList.toggle("missile", v.warn === 2)
  }

  /** Whether the gun or seeker reticle shows (the flight HUD's boresight cross steps aside for it). */
  get reticleShown(): boolean {
    return this.reticle.shown
  }

  /** Our rounds or missile hit an enemy (a kill shows red). `sound` false: the moment's sting plays elsewhere. */
  hit(kill = false, sound = true): void {
    this.marker.hit(kill, sound)
  }

  /** A kill feed line, newest on top: killer ✕ victim in their team colours (killer null: the victim crashed on their
   *  own). `mine`: we made the kill, so a brief centred SHOT DOWN · NAME confirms it. */
  feed(killer: { name: string; color: string } | null, victim: { name: string; color: string }, mine = false, verb = "✕", confirm = "SHOT DOWN"): void {
    if (mine) {
      this.confEl.textContent = `${confirm} · `
      const b = document.createElement("b")
      b.textContent = victim.name
      b.style.color = victim.color
      this.confEl.append(b)
      this.confEl.classList.add("on")
      this.confLeft = CONFIRM_TIME
    }
    const el = document.createElement("div")
    const span = (p: { name: string; color: string }) => {
      const s = document.createElement("span")
      s.textContent = p.name
      s.style.color = p.color
      return s
    }
    if (killer) el.append(span(killer))
    const x = document.createElement("span")
    x.className = "x"
    x.textContent = verb
    el.append(x, span(victim))
    this.feedEl.prepend(el)
    this.feedLines.push({ el, left: FEED_TIME })
    while (this.feedLines.length > FEED_MAX) this.feedLines.shift()!.el.remove()
  }
}
