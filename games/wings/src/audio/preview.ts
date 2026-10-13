// Dev-only audition page: http://localhost:5173/arcade/wings/src/audio/preview.html
import type { GameEvent, Vec3, VehicleEntity, VehicleKind, WeaponId } from "../sim/types"
import { VEHICLES, WEAPONS } from "../sim/vehicles"
import { createAudio } from "../audio"

const audio = createAudio()
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
let maxPeak = 0
let peakSamples = 0

declare global {
  interface Window {
    wingsAudio: typeof audio
    audioPeak: () => number
    /** Max peak since the last call (resets). */
    audioMaxPeak: () => number
    /** Set true to stop the page's own frame loop from driving the engine (for scripted tests). */
    previewPaused: boolean
  }
}
window.wingsAudio = audio
window.audioPeak = () => audio.peak()
window.audioMaxPeak = () => { const m = maxPeak; maxPeak = 0; return m }

function vehicle(id: string, kind: VehicleKind, position: Vec3, velocity: Vec3, throttle: number): VehicleEntity {
  return {
    id, kind, team: 0,
    flight: { kind, position, velocity, orientation: [0, 0, 0, 1], angularVelocity: [0, 0, 0], throttle, onGround: false, gearDown: false, crashed: null, tick: 0 },
    hp: 100, maxHp: 100, seats: [null, null], aim: [null, null], weapons: [[], []],
    flaresReadyAt: 0, flareCount: 0, abilityReadyAt: 0, spottedUntil: 0, lastDamagedBy: null, alive: true,
  }
}

// ---------------------------------------------------------------- engines
interface EngineRow { on: boolean; own: boolean; throttle: number; speed: number; distance: number; azimuth: number }
const kinds = Object.keys(VEHICLES) as VehicleKind[]
const rows = new Map<VehicleKind, EngineRow>()
const enginesEl = $("engines")
kinds.forEach((kind, i) => {
  const row: EngineRow = { on: false, own: false, throttle: 0.6, speed: VEHICLES[kind].cruise, distance: 80, azimuth: -60 + i * 40 }
  rows.set(kind, row)
  const el = document.createElement("div")
  el.className = "engine"
  el.innerHTML = `
    <button data-k="on">${kind}</button>
    <label><input type="checkbox" data-k="own" /> own</label>
    <label>throttle <input type="range" data-k="throttle" min="0" max="1" step="0.01" value="${row.throttle}" /><span>${row.throttle}</span></label>
    <label>speed <input type="range" data-k="speed" min="0" max="${VEHICLES[kind].boost * 1.2}" value="${row.speed}" /><span>${row.speed}</span></label>
    <label>distance <input type="range" data-k="distance" min="10" max="5000" value="${row.distance}" /><span>${row.distance}</span></label>`
  enginesEl.appendChild(el)
  const btn = el.querySelector("button")!
  btn.onclick = () => { row.on = !row.on; btn.classList.toggle("on", row.on) }
  for (const input of el.querySelectorAll<HTMLInputElement>("input")) {
    input.oninput = () => {
      const k = input.dataset.k as keyof EngineRow
      if (k === "own") {
        row.own = input.checked
        if (row.own) for (const [other, r] of rows) if (other !== kind) r.own = false
        for (const box of enginesEl.querySelectorAll<HTMLInputElement>("input[data-k=own]")) if (box !== input) box.checked = false
      } else {
        ;(row as unknown as Record<string, number>)[k] = Number(input.value)
        input.nextElementSibling!.textContent = input.value
      }
    }
  }
})

let flyby: { kind: VehicleKind; speed: number; miss: number; start: number } | null = null
$("flyby").onclick = () => {
  audio.unlock()
  flyby = { kind: $<HTMLSelectElement>("flyKind").value as VehicleKind, speed: Number($<HTMLInputElement>("flySpeed").value), miss: Number($<HTMLInputElement>("flyMiss").value), start: performance.now() }
}

// ---------------------------------------------------------------- weapons / events
const remotePos = (): Vec3 => {
  const d = Number($<HTMLInputElement>("remoteDist").value)
  return [d * 0.6, 20, -d * 0.8]
}
$("remoteDist").oninput = () => { $("remoteDistV").textContent = $<HTMLInputElement>("remoteDist").value }
const isLocal = () => $<HTMLInputElement>("localFire").checked
const shooter = () => (isLocal() ? "own" : "remote")

const weaponsEl = $("weapons")
for (const id of Object.keys(WEAPONS) as WeaponId[]) {
  const btn = document.createElement("button")
  btn.textContent = id
  let timer: ReturnType<typeof setInterval> | null = null
  const fire = () => audio.event({ type: "fire", vehicle: shooter(), seat: 0, weapon: id }, isLocal() ? null : remotePos(), isLocal())
  btn.onpointerdown = () => {
    audio.unlock()
    fire()
    const rate = WEAPONS[id].rate
    if (rate >= 2) timer = setInterval(fire, 1000 / rate)
  }
  const stop = () => { if (timer) clearInterval(timer); timer = null }
  btn.onpointerup = stop
  btn.onpointerleave = stop
  weaponsEl.appendChild(btn)
}

const events: [string, () => [GameEvent, Vec3 | null, boolean]][] = [
  ["hit (remote)", () => [{ type: "hit", target: "remote", by: "x", weapon: "cannon20", damage: 9, position: remotePos() }, null, false]],
  ["hit heavy (remote)", () => [{ type: "hit", target: "remote", by: "x", weapon: "hellfire", damage: 280, position: remotePos() }, null, false]],
  ["hit (we got hit)", () => [{ type: "hit", target: "own", by: "x", weapon: "gau8", damage: 14, position: [0, 0, 0] }, null, true]],
  ["hit marker (we hit)", () => [{ type: "hit", target: "remote", by: "me", weapon: "cannon20", damage: 9, position: remotePos() }, null, false]],
  ["explosion small", () => [{ type: "explosion", position: remotePos(), size: 0.5 }, null, false]],
  ["explosion", () => [{ type: "explosion", position: remotePos(), size: 1 }, null, false]],
  ["explosion big", () => [{ type: "explosion", position: remotePos(), size: 2.5 }, null, false]],
  ["flares (own)", () => [{ type: "flares", vehicle: "own" }, null, true]],
  ["flares (remote)", () => [{ type: "flares", vehicle: "remote" }, remotePos(), false]],
  ["lock acquiring", () => [{ type: "lock", vehicle: "own", target: "remote", locked: false }, null, true]],
  ["locked", () => [{ type: "lock", vehicle: "own", target: "remote", locked: true }, null, true]],
  ["enemy locked us", () => [{ type: "lock", vehicle: "remote", target: "own", locked: true }, null, false]],
  ["radar pulse (own)", () => [{ type: "pulse", vehicle: "own", team: 0, position: [0, 0, 0], radius: 4000 }, null, true]],
  ["radar pulse (remote)", () => [{ type: "pulse", vehicle: "remote", team: 1, position: remotePos(), radius: 4000 }, remotePos(), false]],
  ["kill (we killed)", () => [{ type: "kill", victim: "remote", victimTeam: 1, killer: "me", weapon: "aim9", position: remotePos() }, null, true]],
  ["death (we died)", () => [{ type: "kill", victim: "own", victimTeam: 0, killer: "x", weapon: "aim9", position: [0, 0, 0] }, null, false]],
  ["chat", () => [{ type: "chat", player: "x", text: "hi" }, null, false]],
  ["match end", () => [{ type: "match-end", winner: 0 }, null, false]],
]
audio.setLocalPlayer("me")
for (const [label, make] of events) {
  const btn = document.createElement("button")
  btn.textContent = label
  btn.onclick = () => { audio.unlock(); const [e, p, l] = make(); audio.event(e, p, l) }
  $("events").appendChild(btn)
}
for (const name of ["click", "hover", "confirm", "error", "lock-tone", "locked", "warning"] as const) {
  const btn = document.createElement("button")
  btn.textContent = name
  btn.onclick = () => { audio.unlock(); audio.ui(name) }
  if (name === "hover") btn.onpointerenter = () => audio.ui("hover")
  $("ui").appendChild(btn)
}

$("stress").onclick = () => {
  audio.unlock()
  const t0 = performance.now()
  for (let i = 0; i < 100; i++) setTimeout(() => audio.event({ type: "explosion", position: [Math.random() * 2000 - 1000, 0, Math.random() * -2000], size: 1 }, null, false), i * 10)
  for (let i = 0; i < 200; i++) setTimeout(() => audio.event({ type: "hit", target: `t${i % 7}`, by: "x", weapon: "cannon20", damage: 9, position: [Math.random() * 400 - 200, 0, -100] }, null, false), i * 5)
  setTimeout(() => console.log("stress done", (performance.now() - t0).toFixed(0), "ms", audio.stats()), 1100)
}
let storm = 0
$("gauStorm").onclick = () => { audio.unlock(); storm = performance.now() + 3000 }

// ---------------------------------------------------------------- storm + AA
const stormSet = () => audio.setStorm({
  enabled: $<HTMLInputElement>("stormOn").checked,
  rain: Number($<HTMLInputElement>("rain").value),
  cockpit: $<HTMLInputElement>("cockpit").checked,
})
for (const id of ["stormOn", "rain", "cockpit"]) $(id).oninput = stormSet
$("alt").oninput = () => { listener[1] = Number($<HTMLInputElement>("alt").value); $("altV").textContent = String(listener[1]) }
$("thNear").onclick = () => { audio.unlock(); audio.thunder(0.6, 1) }
$("thMid").onclick = () => { audio.unlock(); audio.thunder(4, 0.8) }
$("thFar").onclick = () => { audio.unlock(); audio.thunder(12, 0.7) }
const holdButton = (id: string, every: number, fn: () => void) => {
  let timer: ReturnType<typeof setInterval> | null = null
  const btn = $(id)
  btn.onpointerdown = () => { audio.unlock(); fn(); timer = setInterval(fn, every) }
  const stop = () => { if (timer) clearInterval(timer); timer = null }
  btn.onpointerup = stop
  btn.onpointerleave = stop
}
holdButton("ciws", 100, () => audio.event({ type: "aa", ship: "cv0", turret: "ciws_bow_port", kind: "ciws", target: "own", position: remotePos(), aim: [0, 50, 0] }, null, false))
holdButton("legacyCiws", 100, () => audio.event({ type: "fire", vehicle: "aa:cv0:ciws_island", seat: 0, weapon: "gau8" }, remotePos(), false))
$("navalGun").onclick = () => {
  audio.unlock()
  const aim: Vec3 = [40, 120, -60]
  audio.event({ type: "aa", ship: "dd1", turret: "gun_fwd", kind: "gun", target: "own", position: remotePos(), aim }, null, false)
  setTimeout(() => audio.event({ type: "explosion", position: [aim[0] + 10, aim[1] - 5, aim[2] + 8], size: 15 }, null, false), 1500)
}
$("flak").onclick = () => { audio.unlock(); audio.event({ type: "explosion", position: remotePos(), size: 15, kind: "flak" } as GameEvent, null, false) }

$("unlock").onclick = () => audio.unlock()
$<HTMLInputElement>("mute").onchange = (e) => audio.setMuted((e.target as HTMLInputElement).checked)
$<HTMLInputElement>("volume").oninput = (e) => audio.setVolume(Number((e.target as HTMLInputElement).value))

// ---------------------------------------------------------------- frame loop
const listener: Vec3 = [0, 0, 0], forward: Vec3 = [0, 0, -1], up: Vec3 = [0, 1, 0]
const stormVehicles = Array.from({ length: 8 }, (_, i) => vehicle(`a10-${i}`, "warthog", [Math.cos(i) * 300, 50, Math.sin(i) * 300 - 200], [100, 0, 0], 0.8))
function frame(now: number): void {
  if (window.previewPaused) { requestAnimationFrame(frame); return }
  audio.setListener(listener, forward, up)
  const list: VehicleEntity[] = []
  let own: string | null = null
  for (const [kind, r] of rows) {
    if (!r.on) continue
    const az = (r.azimuth * Math.PI) / 180
    const id = r.own ? "own" : `eng-${kind}`
    if (r.own) own = id
    const pos: Vec3 = r.own ? [0, 0, -15] : [Math.sin(az) * r.distance, 20, -Math.cos(az) * r.distance]
    // Tangential velocity → no Doppler for static rows.
    list.push(vehicle(id, kind, pos, [Math.cos(az) * r.speed, 0, Math.sin(az) * r.speed], r.throttle))
  }
  if (flyby) {
    const t = (now - flyby.start) / 1000
    const x = -1500 + flyby.speed * t
    if (x > 1500) flyby = null
    else list.push(vehicle("flyby", flyby.kind, [x, 30, -flyby.miss], [flyby.speed, 0, 0], 1))
  }
  // Silent placeholder (alive=false → no engine) so remote events can look up a position.
  const remote = vehicle("remote", "fighter", remotePos(), [0, 0, 0], 0)
  remote.alive = false
  list.push(remote)
  if (now < storm) {
    for (const v of stormVehicles) {
      list.push(v)
      audio.event({ type: "fire", vehicle: v.id, seat: 0, weapon: "gau8" }, v.flight.position, false)
    }
  }
  // Default own id "own" (no vehicle) so "enemy locked us"/"we got hit" resolve without an engine row.
  audio.updateVehicles(list, own ?? "own")
  const p = audio.peak()
  if (p > maxPeak) maxPeak = p
  peakSamples++
  $("bar").style.width = `${Math.min(100, p * 100)}%`
  if (peakSamples % 6 === 0) {
    $("peak").textContent = `peak ${p.toFixed(3)}`
    $("stats").textContent = JSON.stringify(audio.stats())
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
