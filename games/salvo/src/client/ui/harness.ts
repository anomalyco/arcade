// Dev-only harness: renders each UI screen with mock state. ui-harness.html?screen=title|lobby|game|shop|results
import type { Aim, FeedEntry, Profile, Screen, UIActions, UIState } from "../contracts"
import type { MatchView, Phase, PlayerView, Unit } from "../../sim/protocol"
import { WEAPONS, WEAPON_IDS, type WeaponId } from "../../sim/weapons"
import { createUI } from "./index"

const params = new URLSearchParams(location.search)
const screen = (params.get("screen") ?? "game") as Screen
const variant = params.get("state") ?? ""
const live = params.has("live")

document.body.style.background = `#060d14 url(${params.get("bg") ?? (screen === "game" ? "/concept/dir-c-tactical-2.png" : "/art/bg-far.png")}) center / cover no-repeat`

const names = ["dax", "adam", "jay", "frank", "kit", "liz", "ryan", "mo"]
const teams = [0, 1, 5, 2, 4, 3, 6, 8]
const hps = [100, 92, 100, 78, 100, 86, 100, 93]

function ammo(extra: Partial<Record<WeaponId, number>>): Record<WeaponId, number> {
  const a = Object.fromEntries(WEAPON_IDS.map((id) => [id, WEAPONS[id].ammo])) as Record<WeaponId, number>
  return { ...a, ...extra }
}

const units: Unit[] = names.map((name, i) => ({
  id: i,
  team: teams[i],
  name,
  x: 100 + i * 130,
  y: 300,
  hp: variant === "resolve" && i === 3 ? 0 : hps[i],
  maxHp: 100,
  alive: !(variant === "resolve" && i === 3),
  kills: i % 3,
  ammo: ammo(i === 0 ? { cluster: 3, drill: 2, napalm: 2, gravity: 1, airstrike: 1, mirv: 0, bouncer: 0, buster: 0, shield: 0, teleport: 0, builder: 0 } : {}),
  shield: 0,
  boost: 0,
  fuel: i === 0 ? 70 : 100,
  angle: Math.PI / 4,
}))

const locked = [true, true, true, false, false, true, false, false]
const players: PlayerView[] = names.map((name, i) => ({
  id: `p${i}`,
  name: i === 1 ? "adam" : name,
  team: teams[i],
  unit: i,
  bot: i >= 5,
  connected: true,
  locked: variant === "locked" && i === 0 ? true : locked[i],
  spectator: false,
  credits: [1250, 840, 610, 990, 420, 380, 700, 260][i],
  score: [820, 640, 910, 300, 450, 220, 510, 180][i],
  damage: [412, 330, 505, 150, 240, 120, 290, 95][i],
  kills: [3, 2, 4, 1, 1, 0, 2, 0][i],
  wins: [1, 0, 2, 0, 0, 0, 1, 0][i],
  host: i === 0,
}))
if (screen === "game" && variant !== "locked") players[0].locked = false
if (screen === "shop") for (const p of players) p.locked = false

const phase: Phase = screen === "lobby" ? "lobby" : screen === "shop" ? "shop" : screen === "results" ? "over" : variant === "resolve" || variant === "banner" ? "resolve" : "aim"
const t0 = 1_800_000_000_000
const remain = screen === "shop" ? 15000 : screen === "results" ? 11000 : 5000

const view: MatchView = {
  room: "k7q2xm",
  mode: "ffa",
  phase,
  phaseEndsAt: t0 + remain,
  now: t0,
  battle: 2,
  battles: 5,
  volley: 3,
  seed: 1,
  wind: 12,
  hazardY: variant === "sudden" ? 500 : 9999,
  units,
  players: screen === "lobby" ? players.slice(0, 4) : players,
  crates: [],
  ghosts: [],
  battleWinner: variant === "banner" ? "jay" : null,
  matchWinner: screen === "results" ? "jay" : null,
}
if (screen === "lobby" && variant === "guest") {
  view.players = players.slice(0, 4).map((p, i) => ({ ...p, host: i === 1 }))
}

const profile: Profile = {
  name: params.has("noname") ? "" : "dax",
}

const aim: Aim = { angle: (47 * Math.PI) / 180, power: 72, weapon: (params.get("weapon") as WeaponId) ?? "shell" }
const now0 = performance.now()
const feed: FeedEntry[] =
  screen === "game"
    ? [
        { id: 1, at: now0 - 1200, text: "jay destroyed frank", killer: "jay", victim: "frank", killerColor: "#8b6bff", victimColor: "#ff3df0", weapon: "drill" },
        { id: 2, at: now0 - 400, text: "Crate dropped near the ridge" },
      ]
    : []

const state: UIState = {
  screen,
  view: screen === "title" ? null : view,
  you: "p0",
  aim: screen === "game" ? aim : null,
  profile,
  feed,
  roomLink: params.has("room") ? "http://localhost:5391/arcade/salvo/r/k7q2xm" : screen === "lobby" ? "https://anoma.ly/arcade/salvo/r/k7q2xm" : "",
  online: true,
  spectating: variant === "spectate",
  serverNow: t0,
  lastPickup: variant === "pickup" ? { kind: "shield", detail: "40 HP barrier this volley", at: now0 } : null,
}

const log = (name: string) => (...args: unknown[]) => console.log("[action]", name, ...args)
const actions: UIActions = {
  setName: (n) => {
    state.profile = { ...state.profile, name: n }
  },
  play: log("play"),
  start: log("start"),
  aim: (a) => {
    if (state.aim) state.aim = { ...state.aim, ...a }
  },
  move: log("move"),
  lock: () => {
    players[0].locked = true
  },
  buy: log("buy"),
  ready: log("ready"),
  leave: log("leave"),
}

const ui = createUI(document.getElementById("ui")!, actions)
const start = performance.now()
function frame(): void {
  if (live) state.serverNow = t0 + (performance.now() - start)
  ui.update(state)
  requestAnimationFrame(frame)
}
frame()
