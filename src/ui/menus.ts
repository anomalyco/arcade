import { GADGET_IDS, GADGETS, LOOKS, WEAPON_IDS, WEAPONS, type Gadget, type Mode, type Weapon } from "../../shared/config"
import { floorOf } from "../../shared/maps"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import type { Award, Loadout } from "../../shared/sim/world"
import { TEAM, css } from "../game/game"
import { type Profile, gadgetUnlocked, levelOf, lookUnlocked, weaponUnlocked } from "../profile"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export type MenuActions = {
  practice(name: string): void
  create(name: string): void
  join(name: string, room: string): void
  loadout(l: Loadout): void
  start(mode: Mode, rounds: number): void
  leave(): void
}

const WEAPON_NOTE: Record<Weapon, string> = {
  pistol: "Quiet, six rounds. The patient choice.",
  shotgun: "Ends any fight inside 9 m. Everyone hears it.",
  crossbow: "Silent. One bolt; pick it back up.",
}

const pips = (n: number) => `<span class="pips">${[0, 1, 2, 3, 4].map((i) => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</span>`
const noisePips = (w: Weapon) => pips(Math.round((WEAPONS[w].noise / 36) * 5))
const rangePips = (w: Weapon) => pips(Math.round((WEAPONS[w].range / 34) * 5))

const AWARD_TITLE: Record<Award["kind"], string> = { ghost: "GHOST", predator: "PREDATOR", lights: "LIGHTS OUT", loudest: "LOUDEST", patience: "PATIENCE", marksman: "MARKSMAN" }

/** Full-screen and docked panels around the game: landing, room lobby, loadout, scoreboard. */
export class Menus {
  private key = ""
  private mode: Mode = "tdm"
  private rounds = 5
  private scoreOpen = false
  private xpNote = ""

  constructor(
    private root: HTMLElement,
    private profile: Profile,
    private loadout: Loadout,
    private a: MenuActions,
  ) {
    root.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")
      if (t && !t.hasAttribute("disabled")) this.act(t.dataset.act!, t.dataset.v ?? "")
    })
    root.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement
      if (e.key === "Enter" && t.id === "name") this.act(this.root.querySelector("[data-primary]")?.getAttribute("data-act") ?? "practice", "")
      if (e.key === "Enter" && t.id === "code") this.act("join", "")
    })
  }

  private name(): string {
    return (this.root.querySelector<HTMLInputElement>("#name")?.value ?? this.profile.name).trim()
  }

  private act(act: string, v: string): void {
    switch (act) {
      case "practice":
        return this.a.practice(this.name())
      case "create":
        return this.a.create(this.name())
      case "join": {
        const fixed = this.root.querySelector<HTMLElement>("[data-room]")?.dataset.room
        const code = (fixed ?? this.root.querySelector<HTMLInputElement>("#code")?.value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
        if (code) this.a.join(this.name(), code)
        return
      }
      case "copy":
        void navigator.clipboard?.writeText(v)
        this.root.querySelector("[data-act=copy]")!.textContent = "COPIED"
        return
      case "mode":
        this.mode = v as Mode
        this.key = ""
        return
      case "rounds":
        this.rounds = Number(v)
        this.key = ""
        return
      case "start":
        return this.a.start(this.mode, this.rounds)
      case "leave":
        return this.a.leave()
      case "weapon":
        this.loadout = { ...this.loadout, weapon: v as Weapon }
        break
      case "gadget": {
        const g = v as Gadget
        if (this.loadout.gadgets.includes(g)) return
        this.loadout = { ...this.loadout, gadgets: [this.loadout.gadgets[1], g] }
        break
      }
      case "look":
        this.loadout = { ...this.loadout, look: Number(v) }
        break
      default:
        return
    }
    this.key = ""
    this.a.loadout(this.loadout)
  }

  setScoreboard(open: boolean): void {
    if (this.scoreOpen !== open) this.key = ""
    this.scoreOpen = open
  }

  setXp(note: string): void {
    this.xpNote = note
    this.key = ""
  }

  landing(room: string | null, notice = ""): void {
    this.key = "landing"
    const name = esc(this.profile.name)
    const lvl = levelOf(this.profile.xp)
    this.root.className = "full"
    this.root.innerHTML = `<div class="landing">
      <div class="logo">BLACKOUT</div>
      <div class="tag">Stealth deathmatch on an office floor at night. Stay in the dark. Read the rings. One hit.</div>
      ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
      <label>NAME<input id="name" maxlength="14" value="${name}" placeholder="your name" autofocus /></label>
      ${
        room
          ? `<div class="room" data-room="${esc(room)}">ROOM <b>${esc(room.toUpperCase())}</b></div><button class="primary" data-act="join" data-primary>JOIN ROOM</button>`
          : `<button class="primary" data-act="create" data-primary>CREATE ROOM</button>
             <button data-act="practice">PRACTICE VS BOTS</button>
             <div class="row"><input id="code" maxlength="8" placeholder="room code" /><button data-act="join">JOIN</button></div>`
      }
      <div class="lvl">LEVEL ${lvl.level} <span class="xpbar"><i style="width:${Math.round((lvl.into / lvl.span) * 100)}%"></i></span> ${this.profile.matches} matches · ${this.profile.kills} kills</div>
      <div class="keys">WASD move · SHIFT run · C sneak · CLICK fire · R reload · Q / E gadgets · F doors and breakers</div>
    </div>`
  }

  hide(): void {
    this.key = ""
    this.root.className = ""
    this.root.innerHTML = ""
  }

  /** Redraws the panel for the current phase when something visible changed. */
  update(s: Snapshot | null, roster: RosterRow[], myId: string, room: string | null): void {
    if (!s) return
    const showScore = s.phase === "match" || (this.scoreOpen && s.phase !== "lobby")
    const key = JSON.stringify([s.phase, s.phase === "loadout" ? Math.ceil(s.left) : 0, s.mode, s.rounds, s.host, roster.map((r) => [r.id, r.team, r.connected, r.alive, r.stats.kills]), s.wins, this.loadout, this.mode, this.rounds, showScore, this.xpNote])
    if (key === this.key) return
    this.key = key
    if (showScore) return this.scoreboard(s, roster, myId)
    if (s.phase === "lobby") return this.lobby(s, roster, myId, room)
    if (s.phase === "loadout") return this.loadoutPanel(s)
    this.root.className = ""
    this.root.innerHTML = ""
  }

  private loadoutPicker(): string {
    const lvl = levelOf(this.profile.xp).level
    const weapons = WEAPON_IDS.map((w) => {
      const ok = weaponUnlocked(lvl, w)
      return `<button class="opt ${this.loadout.weapon === w ? "on" : ""}" data-act="weapon" data-v="${w}" ${ok ? "" : "disabled"}>
        <b>${WEAPONS[w].label.toUpperCase()}</b>${ok ? "" : `<em>LEVEL ${WEAPONS[w].unlock}</em>`}
        <span class="stat">NOISE ${noisePips(w)}</span><span class="stat">RANGE ${rangePips(w)}</span>
        <span class="note">${WEAPON_NOTE[w]}</span></button>`
    }).join("")
    const gadgets = GADGET_IDS.map((g) => {
      const ok = gadgetUnlocked(lvl, g)
      return `<button class="opt small ${this.loadout.gadgets.includes(g) ? "on" : ""}" data-act="gadget" data-v="${g}" ${ok ? "" : "disabled"}>
        <b>${GADGETS[g].label.toUpperCase()} ×${GADGETS[g].count}</b>${ok ? "" : `<em>LEVEL ${GADGETS[g].unlock}</em>`}<span class="note">${GADGETS[g].blurb}</span></button>`
    }).join("")
    const looks = LOOKS.map((l, i) => {
      const ok = lookUnlocked(lvl, i)
      return `<button class="chip ${this.loadout.look === i ? "on" : ""}" data-act="look" data-v="${i}" ${ok ? "" : "disabled"} title="${ok ? "" : `Level ${l.unlock}`}">${l.label.toUpperCase()}</button>`
    }).join("")
    return `<div class="picker"><div><h3>PRIMARY</h3>${weapons}</div><div><h3>GADGETS · PICK 2</h3>${gadgets}<h3>LOOK</h3><div class="chips">${looks}</div></div></div>`
  }

  private lobby(s: Snapshot, roster: RosterRow[], myId: string, room: string | null): void {
    const host = s.host === myId
    const humans = roster.filter((r) => r.human && r.connected)
    const row = (r: RosterRow) => `<div class="pl"><i style="background:${s.mode === "ffa" ? "#ddd" : css(TEAM[r.team]!)}"></i>${esc(r.name)}${r.id === s.host ? "<em>host</em>" : ""}${r.id === myId ? "<em>you</em>" : ""}</div>`
    const url = room ? `${location.origin}${location.pathname}?room=${room}` : ""
    const teams =
      s.mode === "ffa"
        ? `<div class="team"><h3>PLAYERS</h3>${humans.map(row).join("")}</div>`
        : [0, 1].map((t) => `<div class="team"><h3 style="color:${css(TEAM[t]!)}">${t ? "CYAN" : "ORANGE"}</h3>${humans.filter((r) => r.team === t).map(row).join("") || '<div class="pl empty">bots fill in</div>'}</div>`).join("")
    this.root.className = "full"
    this.root.innerHTML = `<div class="lobby">
      <div class="head"><div class="logo small">BLACKOUT</div>${room ? `<div class="link"><input readonly value="${esc(url)}" /><button data-act="copy" data-v="${esc(url)}">COPY LINK</button></div>` : `<div class="tag">Practice · just you and the bots</div>`}</div>
      <div class="cols">
        <div><div class="teams">${teams}</div>
          <div class="settings">
            <div class="set"><span>MODE</span>${(["tdm", "ffa"] as const).map((m) => `<button class="chip ${this.mode === m ? "on" : ""}" data-act="mode" data-v="${m}" ${host ? "" : "disabled"}>${m === "tdm" ? "TEAMS" : "FREE FOR ALL"}</button>`).join("")}</div>
            <div class="set"><span>ROUNDS</span>${[3, 5].map((n) => `<button class="chip ${this.rounds === n ? "on" : ""}" data-act="rounds" data-v="${n}" ${host ? "" : "disabled"}>BEST OF ${n}</button>`).join("")}</div>
            <div class="set"><span>MAP</span><span class="val">A new office floor every round · one life · 3:00</span></div>
          </div>
          ${host ? `<button class="primary" data-act="start">START MATCH</button>` : `<div class="wait">Waiting for the host to start…</div>`}
        </div>
        <div>${this.loadoutPicker()}</div>
      </div>
      <button class="leave" data-act="leave">LEAVE</button>
    </div>`
  }

  private loadoutPanel(s: Snapshot): void {
    this.root.className = "dock"
    this.root.innerHTML = `<div class="loadout">
      <div class="head"><b>ROUND ${s.roundNo}</b><span>OFFICE TOWER · FL ${floorOf(s.map)}</span><span class="count">LIGHTS OUT IN ${Math.ceil(s.left)}</span></div>
      ${this.loadoutPicker()}
    </div>`
  }

  private scoreboard(s: Snapshot, roster: RosterRow[], myId: string): void {
    const final = s.phase === "match"
    const rows = roster
      .filter((r) => r.connected || r.stats.kills + r.stats.deaths > 0)
      .sort((a, b) => b.stats.kills - a.stats.kills || a.stats.deaths - b.stats.deaths)
      .map((r) => `<tr class="${r.id === myId ? "me" : ""}"><td><i style="background:${s.mode === "ffa" ? "#ccc" : css(TEAM[r.team]!)}"></i>${esc(r.name)}${r.human ? "" : " <em>bot</em>"}</td><td>${r.stats.kills}</td><td>${r.stats.deaths}</td><td>${r.stats.shots}</td><td>${r.stats.lampsOut}</td><td>${r.stats.flares}</td><td>${r.stats.sightings}</td></tr>`)
      .join("")
    const red = s.wins["0"] ?? 0
    const blue = s.wins["1"] ?? 0
    const result =
      s.mode === "ffa"
        ? s.lastWinner
          ? `${esc(roster.find((r) => r.id === s.lastWinner)?.name.toUpperCase() ?? "")} WINS`
          : "DRAW"
        : red === blue
          ? `DRAW <span class="sc">${red} - ${blue}</span>`
          : `<span style="color:${css(TEAM[red > blue ? 0 : 1])}">${red > blue ? "ORANGE" : "CYAN"} WINS</span> <span class="sc">${Math.max(red, blue)} - ${Math.min(red, blue)}</span>`
    const awards = s.phase === "match" ? (this.lastAwards ?? []) : []
    this.root.className = "full"
    this.root.innerHTML = `<div class="score">
      <div class="head"><div class="logo small">BLACKOUT</div><span>${final ? "MATCH COMPLETE" : `ROUND ${s.roundNo}`}</span></div>
      ${final ? `<div class="result">${result}</div>` : ""}
      <div class="cols"><table><thead><tr><th></th><th>KILLS</th><th>DEATHS</th><th>SHOTS</th><th>LIGHTS OUT</th><th>FLARES</th><th>SEEN</th></tr></thead><tbody>${rows}</tbody></table>
      ${final ? `<div class="awards"><h3>AWARDS</h3>${awards.map((a) => `<div class="award"><span>${AWARD_TITLE[a.kind]}</span><b>${esc(a.name)}</b><em>${esc(a.value)}</em></div>`).join("") || '<div class="pl empty">none</div>'}${this.xpNote ? `<div class="xp">${esc(this.xpNote)}</div>` : ""}</div>` : ""}</div>
      ${final ? `<div class="foot">${s.host === myId ? `<button class="primary" data-act="start">REMATCH</button>` : `<span class="wait">Back to the lobby shortly…</span>`}<button data-act="leave">LEAVE</button></div>` : ""}
    </div>`
  }

  lastAwards: Award[] | null = null
}
