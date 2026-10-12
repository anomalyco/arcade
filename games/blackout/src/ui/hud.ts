import "./vehicles.css"
import { EQUIPS, EQUIP_IDS, type Equip, GUNS, GUN_IDS, type Weapon } from "../../shared/config"
import { floorOf } from "../../shared/maps"
import type { Camera } from "../render/camera"
import { type Game, css } from "../game/game"
import { fixedLoadout } from "./rules-hud"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const weaponLabel = (w: Weapon) => (w === "frag" ? "GRENADE" : w === "claymore" ? "CLAYMORE" : w === "melee" ? "MELEE" : w === "vehicle" ? "EXPLOSION" : w === "roadkill" ? "ROADKILL" : GUNS[w].label.toUpperCase())
const equipLabel = (e: Equip) => EQUIPS[e].label.toUpperCase()
const clock = (s: number) => {
  const t = Math.max(0, Math.ceil(s))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`
}

/** In-match HUD: clock, kill feed, health, ammo, crosshair with hitmarkers, banners and names. */
export class Hud {
  private el: Record<string, HTMLElement> = {}
  private labels = new Map<string, HTMLElement>()

  constructor(private root: HTMLElement) {
    root.innerHTML = `
      <div id="tl"><div class="brand">BLACKOUT</div><div id="floor"></div></div>
      <div id="tc"><span id="clock"></span></div>
      <div id="tr"></div>
      <div id="labels"></div>
      <div id="vprompt"></div>
      <div id="bl"><div id="veh"></div><div class="hp"><span>HEALTH</span><div id="hpbar"><i></i></div></div></div>
      <div id="br"><div id="gname"></div><div id="ammo"><b id="mag"></b><span id="magmax"></span></div><div id="rbar"><i></i></div><div id="equip"></div></div>
      <div id="banner"></div>
      <div id="respawn"></div>
      <div id="xh"><i class="l"></i><i class="r"></i><i class="t"></i><i class="b"></i><div id="hm"><i></i><i></i><i></i><i></i></div></div>
      <div id="status"></div>
      <div id="help">WASD move · MOUSE aim · CLICK shoot · SHIFT sprint · RIGHT CLICK look · R reload · G equipment · V melee · F vehicle, plant/defuse · H horn · 1 2 3 guns · 4 5 frag/claymore · TAB scores · T teams · M mute</div>`
    for (const e of root.querySelectorAll<HTMLElement>("[id]")) this.el[e.id] = e
  }

  show(on: boolean): void {
    this.root.classList.toggle("on", on)
    document.body.classList.toggle("playing", on)
  }

  update(g: Game, cam: Camera, w: number, h: number, mouse: { x: number; y: number }, status: string | null): void {
    const el = this.el
    const s = g.snap
    const t = performance.now() / 1000
    el.status!.textContent = status ?? ""
    if (!s) return
    el.floor!.textContent = `OFFICE TOWER · FL ${floorOf(s.map)}`
    el.clock!.textContent = s.phase === "play" ? clock(s.left) : `NEXT FLOOR IN ${Math.ceil(s.left)}`
    el.tr!.innerHTML = g.feed
      .filter((f) => t - f.t < 6)
      .map((f) => `<div class="${f.mine ? "mine" : ""}"><b style="color:${css(f.kc)}">${esc(f.killer)}</b><em>${weaponLabel(f.how)}</em><b style="color:${css(f.vc)}">${esc(f.victim)}</b></div>`)
      .join("")

    const alive = g.alive
    const hp = Math.max(0, g.health)
    const bar = el.hpbar!.firstElementChild as HTMLElement
    bar.style.width = `${hp}%`
    el.hpbar!.classList.toggle("low", hp < 40)
    const gun = GUNS[g.gun]
    const kit = g.kit
    el.gname!.textContent = kit.label
    const reloading = g.reloadUntil > t
    el.mag!.textContent = reloading || !kit.gun ? "" : String(g.mag)
    el.magmax!.textContent = reloading ? "RELOADING" : !kit.gun ? "CLICK TO SWING" : kit.reload ? ` / ${kit.mag}` : " LEFT"
    el.mag!.classList.toggle("empty", g.mag === 0)
    const rb = el.rbar!.firstElementChild as HTMLElement
    rb.style.width = reloading ? `${(1 - (g.reloadUntil - t) / gun.reload) * 100}%` : "0%"

    el.equip!.innerHTML = kit.equip ? `<span class="${g.equipLeft > 0 ? "" : "out"}">${equipLabel(g.equip)} ×${g.equipLeft}</span><kbd>G</kbd>` : kit.melee && kit.gun ? `<span>MELEE</span><kbd>V</kbd>` : ""

    const b = g.banner && t - g.banner.t < 2.2 ? g.banner : null
    el.banner!.textContent = b?.text ?? ""
    el.banner!.style.opacity = b ? String(Math.min(1, (2.2 - (t - b.t)) * 2)) : "0"
    const pick = s.you?.pick ?? "rifle"
    const epick = s.you?.equipPick ?? "frag"
    const fixed = fixedLoadout(s)
    const next = fixed ? "" : [pick !== g.gun ? GUNS[pick].label.toUpperCase() : "", epick !== g.equip ? equipLabel(epick) : ""].filter(Boolean).join(" · ")
    el.respawn!.innerHTML =
      s.phase === "play" && !alive && s.you && fixed
        ? s.you.respawnIn < 0 ? "" : `<div class="rt">RESPAWN IN ${Math.ceil(s.you.respawnIn)}</div>`
        : s.phase === "play" && !alive && s.you
        ? `${s.you.respawnIn < 0 ? "" : `<div class="rt">RESPAWN IN ${Math.ceil(s.you.respawnIn)}</div>`}<div class="picks">${GUN_IDS.map((id, i) => `<span class="${id === pick ? "on" : ""}"><kbd>${i + 1}</kbd>${GUNS[id].label.toUpperCase()}</span>`).join("")}</div><div class="picks">${EQUIP_IDS.map((id, i) => `<span class="${id === epick ? "on" : ""}"><kbd>${i + 4}</kbd>${equipLabel(id)}</span>`).join("")}</div>`
        : alive && next
          ? `<div class="next">NEXT LIFE: ${next}</div>`
          : ""

    // Vehicles: your seat and the vehicle's health while riding, and the prompt over one you can get in.
    const ride = alive ? g.ride : null
    const vh = ride ? Math.max(0, ride.hp / ride.max) : 0
    const segs = ride ? Array.from({ length: 10 }, (_, i) => `<i class="${i < Math.ceil(vh * 10) ? "on" : ""}"></i>`).join("") : ""
    el.veh!.innerHTML = ride
      ? `<div class="vl">VEHICLE: ${ride.label} · ${ride.driver ? "DRIVER" : "PASSENGER"}<span>${ride.used}/${ride.seats} SEATS</span></div><div class="vbar${vh < 0.35 ? " low" : ""}">${segs}</div><div class="vk"><kbd>F</kbd> EXIT${ride.driver ? " · <kbd>H</kbd> HORN · <kbd>SHIFT</kbd> HANDBRAKE" : ""}</div>`
      : ""
    const vp = g.vehiclePrompt
    const vpp = vp ? cam.project(vp.x, 2.4, vp.y, w, h) : null
    if (vp && vpp?.ok) {
      el.vprompt!.innerHTML = `<kbd>F</kbd> ENTER ${vp.spec.label} <span>${vp.s.seats.filter(Boolean).length}/${vp.s.seats.length}</span>`
      el.vprompt!.style.transform = `translate(${vpp.x.toFixed(1)}px, ${vpp.y.toFixed(1)}px) translate(-50%, -100%)`
      el.vprompt!.style.opacity = "1"
    } else el.vprompt!.style.opacity = "0"

    // Crosshair: spreads with recoil, shows a white hitmarker on hits and a red one on kills.
    const xh = el.xh!
    xh.style.transform = `translate(${mouse.x}px, ${mouse.y}px)`
    const spread = 6 + g.bloom * 26 + (GUNS[g.gun].pellets > 1 ? 10 : 0)
    xh.style.setProperty("--s", `${spread}px`)
    const hitAge = (performance.now() / 1000 - g.hitAt) / 0.22
    const killAge = (performance.now() / 1000 - g.killAt) / 0.5
    const hm = el.hm!
    if (killAge < 1) {
      hm.className = "kill"
      hm.style.opacity = String(1 - killAge * killAge)
      hm.style.setProperty("--m", `${10 + (1 - killAge) * 8}px`)
    } else if (hitAge < 1) {
      hm.className = ""
      hm.style.opacity = String(1 - hitAge)
      hm.style.setProperty("--m", `${8 + (1 - hitAge) * 5}px`)
    } else hm.style.opacity = "0"
    xh.style.display = alive ? "block" : "none"

    const keep = new Set<string>()
    for (const a of g.avatars.values()) {
      if (!a.alive) continue
      const p = cam.project(a.x, 2.15, a.y, w, h)
      if (!p.ok) continue
      keep.add(a.id)
      this.label(a.id, g.nameOf(a.id), p.x, p.y, css(g.colorOf(a.id)))
    }
    for (const [id, e] of this.labels) if (!keep.has(id)) e.style.opacity = "0"
  }

  private label(id: string, name: string, x: number, y: number, color: string): void {
    let e = this.labels.get(id)
    if (!e) {
      e = document.createElement("div")
      e.className = "label"
      this.el.labels!.appendChild(e)
      this.labels.set(id, e)
    }
    e.textContent = name
    e.style.color = color
    e.style.opacity = "1"
    e.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`
  }
}
