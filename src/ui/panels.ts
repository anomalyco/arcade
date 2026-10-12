import { GADGETS, MODES, WEAPONS, WEAPON_UNLOCK, type Gadget, type Mode, type Weapon } from "../../shared/config"
import type { Award } from "../../shared/sim/world"
import type { Snapshot } from "../../shared/sim/view"
import { type Loadout, type Profile, gadgetUnlocked, levelOf, weaponUnlocked } from "../profile/profile"
import { TEAM_COLOR } from "../game/draw"
import { esc } from "./hud"

export type PanelActions = {
  create(): void
  enter(name: string): void
  loadout(l: Loadout): void
  start(mode: Mode, rounds: number): void
  copy(url: string): void
  setName(name: string): void
}

const GADGET_ICON: Record<Gadget, string> = { flare: "◢", decoy: "◉", emp: "⚡", mine: "◎" }
const WEAPON_STATS: Record<Weapon, { noise: number; range: number; note: string }> = {
  pistol: { noise: 3, range: 4, note: "Quiet and reliable. Good for stealth." },
  shotgun: { noise: 5, range: 1, note: "Loud. Devastating up close." },
  crossbow: { noise: 0, range: 4, note: "Silent. Slow reload. Bolts are retrievable." },
}
const bar = (n: number) => `<span class="pips">${[0, 1, 2, 3, 4, 5].map((i) => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</span>`

/** Full-screen overlays: landing, room lobby, loadout, scoreboard. The HUD handles the live round. */
export class Panels {
  private root: HTMLElement
  private key = ""
  private mode: Mode = "tdm"
  private rounds = 5
  private dismissed = false
  private profile: Profile | null = null
  private onlyLoadout: Loadout = { weapon: "pistol", gadgets: ["flare", "decoy"] }

  constructor(
    root: HTMLElement,
    private a: PanelActions,
  ) {
    this.root = root
    root.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")
      if (!t) return
      this.act(t.dataset.act!, t)
    })
    root.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement
      if (t.dataset.act === "name") this.a.setName(t.value)
    })
    root.addEventListener("keydown", (e) => {
      const t = e.target as HTMLInputElement
      if (e.key === "Enter" && t.dataset.act === "name-enter") this.a.enter(t.value)
      if (e.key === "Enter" && t.dataset.act === "code") this.joinCode(t.value)
    })
  }

  private joinCode(v: string) {
    const code = v.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
    if (code) location.search = `?room=${code}`
  }

  private act(name: string, t: HTMLElement) {
    switch (name) {
      case "create":
        return this.a.create()
      case "enter": {
        const input = this.root.querySelector<HTMLInputElement>("[data-act=name-enter]")
        return this.a.enter(input?.value ?? "")
      }
      case "join": {
        const input = this.root.querySelector<HTMLInputElement>("[data-act=code]")
        return this.joinCode(input?.value ?? "")
      }
      case "start":
        return this.a.start(this.mode, this.rounds)
      case "copy":
        return this.a.copy(location.href)
      case "mode":
        this.mode = t.dataset.v as Mode
        return this.redraw()
      case "rounds":
        this.rounds = Number(t.dataset.v) === 3 ? 3 : 5
        return this.redraw()
      case "weapon": {
        const w = t.dataset.v as Weapon
        if (!this.profile || !weaponUnlocked(levelOf(this.profile.xp).level, w)) return
        this.onlyLoadout = { ...this.onlyLoadout, weapon: w }
        this.sendLoadout()
        return
      }
      case "gadget": {
        const g = t.dataset.v as Gadget
        if (!this.profile || !gadgetUnlocked(levelOf(this.profile.xp).level, g)) return
        if (this.onlyLoadout.gadgets.includes(g)) return
        this.onlyLoadout = { ...this.onlyLoadout, gadgets: [this.onlyLoadout.gadgets[1], g] }
        return this.sendLoadout()
      }
      case "dismiss":
        this.dismissed = true
        return this.redraw()
    }
  }

  private sendLoadout() {
    if (this.profile) this.profile.lastLoadout = this.onlyLoadout
    this.a.loadout(this.onlyLoadout)
    this.redraw()
  }

  setProfile(p: Profile, loadout: Loadout): void {
    this.profile = p
    this.onlyLoadout = loadout
    this.redraw()
  }

  /** Shows a centred card with arbitrary HTML. Used for landing, joining and errors. */
  card(html: string): void {
    this.key = ""
    this.root.innerHTML = `<div class="card-wrap">${html}</div>`
    this.root.classList.add("show")
  }

  hide(): void {
    this.root.classList.remove("show")
    this.root.innerHTML = ""
    this.key = ""
  }

  landing(room: string, name: string): void {
    const join = room
      ? `<div class="room-line">ROOM <b>${esc(room.toUpperCase())}</b></div>
         <div class="row"><input data-act="name-enter" maxlength="14" placeholder="your name" value="${esc(name)}" autofocus /><button class="solid" data-act="enter">ENTER</button></div>
         <p class="small">Players join with just a name. No accounts. Hide in the dark, don't get seen.</p>`
      : `<div class="row"><input data-act="name-enter" maxlength="14" placeholder="your name" value="${esc(name)}" /></div>
         <div class="row"><button class="solid" data-act="create">CREATE ROOM</button></div>
         <div class="or">or join a room</div>
         <div class="row"><input data-act="code" maxlength="10" placeholder="room code" /><button data-act="join">JOIN</button></div>`
    this.card(`<div class="card">
      <div class="title">BLACKOUT</div>
      <div class="tag">A stealth deathmatch in the dark.</div>
      ${join}
      <div class="rules">
        <div><b>Light</b> hides you. Stand in a pool and you're seen.</div>
        <div><b>Sound</b> rings out for everyone. Walk soft, run loud.</div>
        <div><b>One hit</b> kills. One life per round.</div>
      </div>
    </div>`)
  }

  connecting(room: string): void {
    this.card(`<div class="card"><div class="title small-t">BLACKOUT</div><div class="status-line">Connecting to ${esc(room.toUpperCase())}…</div></div>`)
  }

  message(title: string, body: string): void {
    this.card(`<div class="card"><div class="title small-t">${esc(title)}</div><p>${esc(body)}</p><div class="row"><button data-act="create">NEW ROOM</button></div></div>`)
  }

  /** Redraws the overlay for the current phase, skipping work when nothing visible has changed. */
  update(snap: Snapshot | null, myId: string, room: string, roster: string): void {
    if (!snap) return
    const key = [snap.phase, snap.roundNo, snap.mode, snap.rounds, snap.host === myId, roster, JSON.stringify(snap.wins), snap.awards.length, this.dismissed, this.onlyLoadout.weapon, this.onlyLoadout.gadgets.join(",")].join("|")
    if (snap.phase !== "match") this.dismissed = false
    if (snap.phase === "live" || snap.phase === "over") {
      if (this.key !== "") this.hide()
      this.key = ""
      return
    }
    if (key === this.key) return
    this.key = key
    this.mode = snap.mode
    this.rounds = snap.rounds
    if (snap.phase === "lobby") this.lobby(snap, myId, room)
    else if (snap.phase === "loadout") this.loadout(snap, myId)
    else if (snap.phase === "match") this.scoreboard(snap, myId)
  }

  private redraw(): void {
    this.key = ""
  }

  private lobby(snap: Snapshot, myId: string, room: string): void {
    const isHost = snap.host === myId
    const humans = snap.roster.filter((r) => r.human && r.connected)
    const teams = (team: number) => humans.filter((r) => r.team === team)
    const cols = snap.mode === "ffa" ? [humans] : [teams(0), teams(1)]
    const list = (rows: typeof humans, team: number | null) =>
      rows
        .map((r) => `<div class="prow"><i style="background:${team === null ? "#eee" : `rgb(${TEAM_COLOR[team]!.map((c) => Math.round(c * 255)).join(",")})`}"></i>${esc(r.name)}${r.id === snap.host ? ' <em class="host">host</em>' : ""}${r.id === myId ? " <em>you</em>" : ""}</div>`)
        .join("") || `<div class="prow empty">open slot</div>`
    const url = `${location.origin}${location.pathname}?room=${room}`
    const modeLabel = (m: Mode) => (m === "tdm" ? "TEAM DEATHMATCH" : "FREE FOR ALL")
    const lvl = this.profile ? levelOf(this.profile.xp).level : 1
    this.card(`<div class="lobby">
      <div class="lobby-head">
        <div><div class="title small-t">ROOM ${esc(room.toUpperCase())}</div><div class="small">${humans.length} player${humans.length === 1 ? "" : "s"} · bots fill to 4 at start</div></div>
        <div class="linkrow"><input readonly value="${esc(url)}" /><button data-act="copy">COPY LINK</button></div>
      </div>
      <div class="lobby-body">
        <div class="teams">
          ${snap.mode === "ffa" ? `<div class="team"><h3>FREE FOR ALL</h3>${list(cols[0]!, null)}</div>` : `<div class="team red"><h3>RED <span>${teams(0).length}</span></h3>${list(cols[0]!, 0)}</div><div class="team blue"><h3>BLUE <span>${teams(1).length}</span></h3>${list(cols[1]!, 1)}</div>`}
        </div>
        <div class="settings">
          <h3>MATCH</h3>
          <div class="set"><span>MODE</span><div class="seg">${MODES.map((m) => `<button class="${this.mode === m ? "on" : ""}" data-act="mode" data-v="${m}" ${isHost ? "" : "disabled"}>${modeLabel(m)}</button>`).join("")}</div></div>
          <div class="set"><span>ROUNDS</span><div class="seg">${[3, 5].map((n) => `<button class="${this.rounds === n ? "on" : ""}" data-act="rounds" data-v="${n}" ${isHost ? "" : "disabled"}>BEST OF ${n}</button>`).join("")}</div></div>
          <div class="set"><span>MAP</span><div class="map-pick">WAREHOUSE</div></div>
          <div class="set"><span>ROUND</span><div>${snap.mode === "ffa" ? "last one standing" : "last team standing"} · 3:00 · one life</div></div>
          ${isHost ? `<button class="solid start" data-act="start">START MATCH</button>` : `<div class="waiting">Waiting for the host to start.</div>`}
        </div>
      </div>
      ${this.loadoutHtml(lvl)}
    </div>`)
  }

  private loadout(snap: Snapshot, myId: string): void {
    const lvl = this.profile ? levelOf(this.profile.xp).level : 1
    const ready = snap.roster.filter((r) => r.alive || r.inRound).length
    this.card(`<div class="loadout-wrap">
      <div class="loadout-head">
        <div class="title">LOADOUT</div>
        <div class="countdown">ROUND ${snap.roundNo} STARTS IN <b>${Math.ceil(snap.left)}</b></div>
        <div class="score-mini">${scoreMini(snap)}</div>
      </div>
      ${this.loadoutHtml(lvl)}
      <div class="readybar"><span>${ready} / ${snap.roster.length} in</span><span class="rl">${snap.roster
        .filter((r) => r.human)
        .map((r) => `<em class="${r.id === myId ? "me" : ""}">${esc(r.name)}</em>`)
        .join("")}</span></div>
    </div>`)
  }

  private loadoutHtml(level: number): string {
    const cur = this.onlyLoadout
    const weapons = (Object.keys(WEAPONS) as Weapon[])
      .map((w) => {
        const spec = WEAPONS[w]
        const ok = weaponUnlocked(level, w)
        const st = WEAPON_STATS[w]
        return `<button class="card-opt ${cur.weapon === w ? "on" : ""} ${ok ? "" : "locked"}" data-act="weapon" data-v="${w}" ${ok ? "" : "disabled"}>
          <div class="opt-title">${esc(spec.label.toUpperCase())}${ok ? "" : ` <em>LEVEL ${WEAPON_UNLOCK[w]}</em>`}</div>
          <div class="opt-stats"><span>Noise</span>${bar(st.noise)}<span>Range</span>${bar(st.range)}<span>${spec.reserve > 0 ? `${spec.mag} / ${spec.reserve}` : "1 bolt"}</span></div>
          <div class="opt-note">${esc(st.note)}</div>
        </button>`
      })
      .join("")
    const gadgets = (Object.keys(GADGETS) as Gadget[])
      .map((g) => {
        const spec = GADGETS[g]
        const ok = gadgetUnlocked(level, g)
        const on = cur.gadgets.includes(g)
        return `<button class="card-opt ${on ? "on" : ""} ${ok ? "" : "locked"}" data-act="gadget" data-v="${g}" ${ok ? "" : "disabled"}>
          <div class="opt-title"><span class="icon">${GADGET_ICON[g]}</span>${esc(spec.label.toUpperCase())}${ok ? "" : ` <em>LEVEL ${spec.unlock}</em>`}</div>
          <div class="opt-note">×${spec.count}</div>
        </button>`
      })
      .join("")
    return `<div class="loadout">
      <div class="col"><h3>PRIMARY</h3>${weapons}</div>
      <div class="col"><h3>GADGETS · PICK 2</h3>${gadgets}</div>
    </div>`
  }

  private scoreboard(snap: Snapshot, myId: string): void {
    if (this.dismissed) {
      this.root.classList.remove("show")
      return
    }
    const rows = snap.roster
      .slice()
      .sort((a, b) => b.stats.kills - a.stats.kills || a.stats.deaths - b.stats.deaths)
      .map((r) => {
        const team = snap.mode === "tdm" ? TEAM_COLOR[r.team] : undefined
        const dot = team ? `rgb(${team.map((c) => Math.round(c * 255)).join(",")})` : "#ddd"
        return `<tr class="${r.id === myId ? "me" : ""}"><td><i style="background:${dot}"></i>${esc(r.name)}${r.id === myId ? " <em>you</em>" : ""}</td><td>${r.stats.kills}</td><td>${r.stats.deaths}</td><td>${r.stats.shots}</td><td>${r.stats.lampsOut}</td><td>${r.stats.flares}</td></tr>`
      })
      .join("")
    const winnerLine = snap.mode === "tdm" ? winnerTeams(snap) : `${esc(snap.lastWinner ? (snap.roster.find((r) => r.id === snap.lastWinner)?.name ?? "") : "")}`
    const awards = snap.awards.map((a) => awardHtml(a, snap)).join("")
    const host = snap.host === myId
    this.card(`<div class="score-wrap">
      <div class="brand">BLACKOUT</div><div class="done">MATCH COMPLETE</div>
      <div class="result">${winnerLine}</div>
      <div class="sub">${esc(snap.map.toUpperCase())} · ${snap.mode === "tdm" ? "TEAM DEATHMATCH" : "FREE FOR ALL"} · BEST OF ${snap.rounds}</div>
      <div class="score-body">
        <table><thead><tr><th></th><th>KILLS</th><th>DEATHS</th><th>SHOTS</th><th>LIGHTS OUT</th><th>FLARES</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="awards"><h3>AWARDS</h3>${awards || '<div class="prow empty">No awards this time.</div>'}</div>
      </div>
      <div class="foot">
        ${host ? `<button class="solid" data-act="start">REMATCH</button>` : `<span class="waiting">Waiting for the host…</span>`}
        <button data-act="dismiss">BACK TO LOBBY</button>
      </div>
    </div>`)
  }
}

function winnerTeams(snap: Snapshot): string {
  const red = snap.wins["0"] ?? 0
  const blue = snap.wins["1"] ?? 0
  if (red === blue) return `DRAW <span class="score">${red} – ${blue}</span>`
  return red > blue ? `<span class="red">RED WINS</span> <span class="score">${red} – ${blue}</span>` : `<span class="blue">BLUE WINS</span> <span class="score">${blue} – ${red}</span>`
}

function scoreMini(snap: Snapshot): string {
  if (snap.mode === "ffa") return ""
  return `<span class="red">RED ${snap.wins["0"] ?? 0}</span> – <span class="blue">BLUE ${snap.wins["1"] ?? 0}</span>`
}

const AWARD_TITLE: Record<Award["kind"], string> = { ghost: "GHOST", lights: "LIGHTS OUT", loudest: "LOUDEST", patience: "PATIENCE" }

function awardHtml(a: Award, snap: Snapshot): string {
  const name = snap.roster.find((r) => r.id === a.id)?.name ?? a.name
  return `<div class="award"><div class="award-t">${AWARD_TITLE[a.kind]}</div><div class="award-n">${esc(name)}</div><div class="award-v">${esc(a.value)}</div></div>`
}
