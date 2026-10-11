import { VEHICLES, type Role, type Vehicle } from "../../shared/config"
import { isUnlocked, levelForTier, levelOf, loadProfile } from "../game/profile"
import { esc, h } from "./dom"

export type LobbyResult = { mode: "solo" | "room"; room: string | null; name: string; picks: Record<Role, string> }

const NAME_KEY = "getaway.name"
const PICKS_KEY = "getaway.picks"
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"

const range = (f: (v: Vehicle) => number) => {
  const xs = VEHICLES.map(f)
  const lo = Math.min(...xs)
  const hi = Math.max(...xs)
  return (v: Vehicle) => 0.18 + (0.82 * (f(v) - lo)) / (hi - lo || 1)
}
const STATS: [string, (v: Vehicle) => number][] = [
  ["SPEED", range((v) => v.maxSpeed)],
  ["ACCEL", range((v) => v.accel)],
  ["HANDLING", range((v) => v.turn * 0.6 + v.grip * 0.25)],
  ["ARMOR", range((v) => v.hp * v.mass)],
]

const rgb = (c: [number, number, number]) => `rgb(${c.map((x) => Math.round(Math.min(1, x) * 255)).join(",")})`

/** A top-down silhouette in the car's paint, scaled by its footprint. */
function carSvg(v: Vehicle) {
  const L = v.length * 18
  const W = v.width * 18
  const x = (110 - L) / 2
  const y = (54 - W) / 2
  const paint = rgb(v.paint)
  const accent = rgb(v.accent)
  if (v.id === "bike")
    return `<svg viewBox="0 0 110 54"><rect x="${x}" y="23" width="${L}" height="8" rx="4" fill="#15171c"/><rect x="${x + L * 0.25}" y="21" width="${L * 0.45}" height="12" rx="5" fill="${paint}"/><rect x="${x + L * 0.62}" y="17" width="3" height="20" rx="1.5" fill="#888"/><rect x="${x + L * 0.3}" y="24.5" width="${L * 0.3}" height="5" rx="2.5" fill="${accent}"/></svg>`
  const cop = v.role === "cop"
  return `<svg viewBox="0 0 110 54">
    <rect x="${x - 1}" y="${y - 1}" width="${L + 2}" height="${W + 2}" rx="7" fill="#000" opacity=".5"/>
    <rect x="${x}" y="${y}" width="${L}" height="${W}" rx="6" fill="${paint}"/>
    ${v.id === "muscle" ? `<rect x="${x}" y="${27 - W * 0.12}" width="${L}" height="${W * 0.08}" fill="${accent}"/><rect x="${x}" y="${27 + W * 0.04}" width="${L}" height="${W * 0.08}" fill="${accent}"/>` : ""}
    <rect x="${x + L * 0.52}" y="${y + W * 0.12}" width="${L * 0.16}" height="${W * 0.76}" rx="2" fill="#0d1118"/>
    <rect x="${x + L * (v.length > 5 ? 0.12 : 0.22)}" y="${y + W * 0.14}" width="${L * 0.12}" height="${W * 0.72}" rx="2" fill="#0d1118" opacity=".85"/>
    ${cop ? `<rect x="${x + L * 0.4}" y="${y + W * 0.2}" width="${L * 0.07}" height="${W * 0.3}" fill="#ff3b3b"/><rect x="${x + L * 0.4}" y="${y + W * 0.5}" width="${L * 0.07}" height="${W * 0.3}" fill="#3d7bff"/>` : ""}
    ${v.id === "van" || v.id === "swat" ? `<rect x="${x + L * 0.08}" y="${y + W * 0.2}" width="${L * 0.38}" height="${W * 0.6}" rx="2" fill="${accent}" opacity=".35"/>` : ""}
    <rect x="${x + L - 3}" y="${y + 2}" width="3" height="${W * 0.22}" rx="1" fill="#fff6d0"/><rect x="${x + L - 3}" y="${y + W * 0.78 - 2}" width="3" height="${W * 0.22}" rx="1" fill="#fff6d0"/>
    <rect x="${x}" y="${y + 2}" width="2.5" height="${W * 0.2}" fill="#ff2a2a"/><rect x="${x}" y="${y + W * 0.8 - 2}" width="2.5" height="${W * 0.2}" fill="#ff2a2a"/>
  </svg>`
}

function randomCode() {
  let s = ""
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  return s
}

function loadPicks(level: number): Record<Role, string> {
  let saved: Partial<Record<Role, string>> = {}
  try {
    saved = JSON.parse(localStorage.getItem(PICKS_KEY) ?? "{}") as Partial<Record<Role, string>>
  } catch {}
  const pick = (role: Role) => {
    const v = VEHICLES.find((x) => x.id === saved[role] && x.role === role)
    return v && isUnlocked(v, level) ? v.id : VEHICLES.find((x) => x.role === role)!.id
  }
  return { robber: pick("robber"), cop: pick("cop") }
}

/** Title screen: name entry, solo practice or create/join a room from the shared link. */
export async function lobby(root: HTMLElement): Promise<LobbyResult> {
  const urlRoom = new URLSearchParams(location.search).get("r")?.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || null
  const profile = loadProfile()
  const lv = levelOf(profile.xp)
  const picks = loadPicks(lv.level)
  const storedName = localStorage.getItem(NAME_KEY) ?? ""

  const el = h("div", "lobby", root)
  el.innerHTML = `
    <div class="lb-bg"><div class="lb-grid"></div><i class="streak s1"></i><i class="streak s2"></i><i class="streak s3"></i><i class="streak s4"></i><div class="lb-siren"></div><div class="lb-vignette"></div></div>
    <div class="lb-inner">
      <section class="lb-left">
        <div class="lb-kicker">A NIGHT IN THE CITY · ONE DRIVER · EVERY COP</div>
        <h1 class="wordmark">GETAWAY</h1>
        <p class="lb-tag">The job is done. The alarm is ringing. One of you drives, the rest of you wear the badge.</p>
        <div class="lb-profile">
          <div class="lp-level"><span>LEVEL</span><b>${lv.level}</b></div>
          <div class="lp-xp"><div class="lp-bar"><i style="width:${((lv.into / lv.need) * 100).toFixed(1)}%"></i></div><span>${lv.into.toLocaleString("en-US")} / ${lv.need.toLocaleString("en-US")} XP</span></div>
          <div class="lp-stats"><span><b>${profile.stats.escapes}</b>ESCAPES</span><span><b>${profile.stats.busts}</b>BUSTS</span><span><b>${profile.stats.bestDrift.toLocaleString("en-US")}</b>BEST DRIFT</span></div>
        </div>
        <label class="lb-field"><span>DRIVER NAME</span><input class="lb-name" maxlength="16" autocomplete="off" spellcheck="false" placeholder="Your name" value="${esc(storedName)}"/></label>
        <div class="lb-actions">
          ${
            urlRoom
              ? `<button class="btn primary" data-act="join">JOIN ROOM <b>${esc(urlRoom)}</b></button><button class="btn link" data-act="solo">Practice solo instead</button>`
              : `<button class="btn primary" data-act="solo">PRACTICE SOLO</button><div class="btn-row"><button class="btn" data-act="create">CREATE ROOM</button><button class="btn" data-act="showjoin">JOIN</button></div><div class="lb-join off"><input class="lb-code" maxlength="4" placeholder="CODE" autocomplete="off" spellcheck="false"/><button class="btn" data-act="joincode">GO</button></div>`
          }
        </div>
        <div class="lb-keys"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> drive</span><span><kbd>SPACE</kbd> handbrake</span><span><kbd>SHIFT</kbd> nitro</span><span><kbd>Q</kbd><kbd>E</kbd> gadgets</span></div>
      </section>
      <section class="lb-garage">
        <div class="lg-row" data-role="robber"><div class="lg-head"><h2><span class="t-robber">GETAWAY</span> CHOOSE YOUR RIDE</h2><p class="lg-blurb"></p></div><div class="lg-cards"></div></div>
        <div class="lg-row" data-role="cop"><div class="lg-head"><h2><span class="t-cop">PATROL</span> CHOOSE YOUR UNIT</h2><p class="lg-blurb"></p></div><div class="lg-cards"></div></div>
      </section>
    </div>`

  const renderRow = (role: Role) => {
    const row = el.querySelector<HTMLElement>(`.lg-row[data-role="${role}"]`)!
    const cards = row.querySelector<HTMLElement>(".lg-cards")!
    cards.innerHTML = VEHICLES.filter((v) => v.role === role)
      .map((v) => {
        const locked = !isUnlocked(v, lv.level)
        const sel = picks[role] === v.id
        return `<button type="button" class="car${sel ? " sel" : ""}${locked ? " locked" : ""}" data-id="${v.id}" ${locked ? "aria-disabled=true" : ""}>
          <div class="car-name">${esc(v.name.toUpperCase())}</div>
          <div class="car-art">${carSvg(v)}</div>
          <div class="car-stats">${STATS.map(([k, f]) => `<div class="st"><span>${k}</span><div class="seg"><i style="width:${(f(v) * 100).toFixed(0)}%"></i></div></div>`).join("")}</div>
          ${locked ? `<div class="car-lock"><svg viewBox="0 0 24 24"><path d="M7 10V7a5 5 0 0 1 10 0v3h1.5v11h-13V10zm2 0h6V7a3 3 0 0 0-6 0z" fill="currentColor"/></svg>LEVEL ${levelForTier(v.tier)}</div>` : ""}
        </button>`
      })
      .join("")
    const v = VEHICLES.find((x) => x.id === picks[role])!
    row.querySelector(".lg-blurb")!.textContent = `${v.name}: ${v.blurb}`
  }
  renderRow("robber")
  renderRow("cop")

  const nameInput = el.querySelector<HTMLInputElement>(".lb-name")!
  if (!storedName) setTimeout(() => nameInput.focus(), 50)

  return new Promise<LobbyResult>((resolve) => {
    const finish = (mode: "solo" | "room", room: string | null) => {
      const name = nameInput.value.trim().slice(0, 16) || "Driver"
      localStorage.setItem(NAME_KEY, name)
      localStorage.setItem(PICKS_KEY, JSON.stringify(picks))
      if (room) {
        const url = new URL(location.href)
        url.searchParams.set("r", room)
        history.pushState(null, "", url)
      }
      el.classList.add("out")
      setTimeout(() => el.remove(), 450)
      resolve({ mode, room, name, picks: { ...picks } })
    }
    el.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement
      const car = t.closest<HTMLElement>(".car")
      if (car) {
        if (car.classList.contains("locked")) return
        const role = car.closest<HTMLElement>(".lg-row")!.dataset.role as Role
        picks[role] = car.dataset.id!
        localStorage.setItem(PICKS_KEY, JSON.stringify(picks))
        renderRow(role)
        return
      }
      const act = t.closest<HTMLElement>("[data-act]")?.dataset.act
      if (act === "solo") finish("solo", null)
      else if (act === "join" && urlRoom) finish("room", urlRoom)
      else if (act === "create") finish("room", randomCode())
      else if (act === "showjoin") {
        el.querySelector(".lb-join")!.classList.toggle("off")
        el.querySelector<HTMLInputElement>(".lb-code")!.focus()
      } else if (act === "joincode") {
        const code = el.querySelector<HTMLInputElement>(".lb-code")!.value.toUpperCase().replace(/[^A-Z0-9]/g, "")
        if (code.length >= 4) finish("room", code)
      }
    })
    el.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return
      const t = ev.target as HTMLElement
      if (t.classList.contains("lb-code")) el.querySelector<HTMLElement>('[data-act="joincode"]')?.click()
      else if (t === nameInput) el.querySelector<HTMLElement>(".btn.primary")?.click()
    })
  })
}
