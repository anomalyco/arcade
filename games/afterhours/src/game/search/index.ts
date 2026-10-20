import * as THREE from "three/webgpu"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import type { Flow } from "../flow"
import { BUILDING } from "../../world/layout"
import { hooks } from "../../audio/hooks"
import { emitNoise } from "../hunter/noise"
import { keyCabinet, searchSpots, securityKeyBox, type SearchSpot } from "../../world/interior/search-spots"
import { SIGNOUT } from "../../world/interior/storeys/s3/listening"
import { LISTENING_ROOM_BODIES } from "../../world/interior/storeys/s3/listening"
import { transmitter } from "../../world/interior/storeys/s3/transmitter-state"
import { showSubtitle } from "../shell/subtitles"
import { ITEMS, NOTES, addItem, addNote, hasItem, hasNote, markSearched, wasSearched, type ItemId, type NoteId } from "../inventory"
import { showNote } from "./note-view"

// Searching (play mode): aim at a desk, filing cabinet, locker or body and HOLD E for about a second (the prompt's
// key cap fills); the drawer or door is gone through and whatever is there is taken (an item, or a note, which opens
// to read). Every search makes a noise the hunter can hear (louder for metal lockers and cabinets). Targeting is the
// forgiving one of the 3-08 controls: within 2.2 m of the eye, inside ~17° of the crosshair or the spot's own hit
// radius, no minimum distance, the spot nearest the crosshair wins.
//
// Spots: every desk, filing cabinet and locker the interior registers (world/interior/search-spots.ts; most empty or
// holding something ordinary), plus the key trail: the 3-08 receiver log, Hargrove's body, locker 14 in 3-20 and the
// 0-30 key cabinet.

const REACH = 2.2
const CONE = 0.3
const HOLD = 1.0

type Kind = SearchSpot["kind"] | "body" | "read" | "key-cabinet"
type Spot = {
  id: string
  kind: Kind
  storey: number
  at: THREE.Vector3
  r: number
  label: () => string | null
  /** Hold time (s). */
  hold?: number
  /** Can it be searched now (false: the label shows, no key cap). */
  ready?: () => boolean
  /** What searching gives (or does). */
  take: () => { items?: ItemId[]; notes?: NoteId[]; say?: string }
}

const NOISE: Record<Kind, number> = { desk: 5, cabinet: 9, locker: 10, body: 3, read: 0, "key-cabinet": 8 }
const LABEL: Record<SearchSpot["kind"], string> = { desk: "Search the desk drawers", cabinet: "Search the filing cabinet", locker: "Search locker" }

const FLAVOUR_ITEMS: ItemId[] = ["lighter", "batteries", "photo", "cigarettes", "gum", "pen", "coins", "aspirin", "matches", "tape", "keyring-misc"]
const FLAVOUR_NOTES: NoteId[] = ["note-shift", "note-coffee", "note-overtime", "note-woods", "note-phone", "note-parking"]
/** Hargrove's locker: number 14 in the operators' rest room 3-20 (storey 3, x < −47.8). */
const HARGROVE_LOCKER = 14

const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

/** Flavour contents of an ordinary spot: about two in three are empty. */
function loot(id: string, kind: SearchSpot["kind"]): { items?: ItemId[]; notes?: NoteId[] } {
  const r = hash(id)
  if (r < (kind === "locker" ? 0.55 : 0.68)) return {}
  const k = hash(id + "#")
  if (kind !== "locker" && k < 0.35) {
    const n = FLAVOUR_NOTES[Math.floor(hash(id + "n") * FLAVOUR_NOTES.length)]!
    return hasNote(n) ? {} : { notes: [n] }
  }
  const it = FLAVOUR_ITEMS[Math.floor(hash(id + "i") * FLAVOUR_ITEMS.length)]!
  return hasItem(it) ? {} : { items: [it] }
}

const storeyOf = (y: number) => Math.max(0, Math.min(4, Math.floor((y - 1.0 - BUILDING.floorY) / BUILDING.main.storeyHeight + 0.15)))

function buildSpots(): Spot[] {
  const out: Spot[] = []
  const Y3 = BUILDING.floorY + 0.01 + 3 * BUILDING.main.storeyHeight
  const Y0 = BUILDING.floorY + 0.01
  // The key trail: the vehicle sign-out sheet by 3-08 → the 0-30 key cabinet (locked, its tag) → the Security key box
  // (0-38, the cabinet key) → the cabinet again (Truck 2's keys). Hargrove, his note and locker 14 are flavour only.
  out.push({
    id: "story:signout",
    kind: "read",
    storey: 3,
    at: new THREE.Vector3(SIGNOUT.x, Y3 + SIGNOUT.y, SIGNOUT.z),
    r: 0.22,
    hold: 0.4,
    label: () => (hasNote("signout") ? "Read the vehicle sign-out again" : "Read the vehicle sign-out"),
    take: () => ({ notes: ["signout"] }),
  })
  if (securityKeyBox.at)
    out.push({
      id: "story:security-key",
      kind: "key-cabinet",
      storey: 0,
      at: new THREE.Vector3(...securityKeyBox.at),
      r: 0.2,
      label: () => "Take the key (FAC. CAB.)",
      take: () => {
        if (securityKeyBox.keys) securityKeyBox.keys.visible = false
        return { items: ["cabinet-key"] }
      },
    })
  out.push({
    id: "story:log-3-08",
    kind: "read",
    storey: 3,
    at: new THREE.Vector3(7.56, Y3 + 0.8, -13.86),
    r: 0.18,
    hold: 0.5,
    label: () => (hasNote("log-0312") ? "Read the receiver log again" : "Read the receiver log"),
    take: () => ({ notes: ["log-0312"] }),
  })
  const hb = LISTENING_ROOM_BODIES.find((b) => b.id === "3-08-door")
  if (hb)
    out.push({
      id: "story:body-hargrove",
      kind: "body",
      storey: 3,
      at: new THREE.Vector3(hb.position[0], Y3 + 0.25, hb.position[2]),
      r: 0.5,
      // Not during the radio beat (his body lies at the foot of the transmitter).
      ready: () => transmitter.reached("revealed"),
      label: () => (transmitter.reached("revealed") ? "Search the body (Hargrove)" : null),
      take: () => ({ items: ["badge-hargrove"], notes: ["note-hargrove"] }),
    })
  if (keyCabinet.at)
    out.push({
      id: "story:key-cabinet",
      kind: "key-cabinet",
      storey: 0,
      at: new THREE.Vector3(...keyCabinet.at),
      r: 0.35,
      hold: 0.5,
      // Locked: E reads the tag on it (and keeps offering it); with the key it opens and the keys are taken.
      label: () => (hasItem("cabinet-key") ? "Unlock the key cabinet" : "Key cabinet (locked). Read the tag"),
      take: () => {
        if (!hasItem("cabinet-key")) return { notes: ["cabinet-tag"], say: "Locked. A tag on it: Cabinet key held at Security, 0-38." }
        keyCabinet.open()
        if (keyCabinet.keys) keyCabinet.keys.visible = false
        return { items: ["truck-keys"] }
      },
    })
  for (const s of searchSpots) {
    const at = new THREE.Vector3(...s.at)
    const hargrove = s.kind === "locker" && s.storey === 3 && s.number === HARGROVE_LOCKER && at.x < -47.5
    out.push({
      id: s.id,
      kind: s.kind,
      storey: s.storey,
      at,
      r: s.kind === "desk" ? 0.4 : 0.22,
      label: () => (s.kind === "locker" && s.number !== undefined ? `${LABEL.locker} ${s.number}` : LABEL[s.kind]),
      take: () => (hargrove ? { items: ["photo"], say: "Hargrove's locker. A jacket, a thermos, a photo of two kids on a dock." } : loot(s.id, s.kind)),
    })
  }
  return out
}

export type SearchHost = { flow: Flow; camera: THREE.Camera; player: { pos: { x: number; y: number; z: number } } }

export function startSearch(host: SearchHost, signal?: AbortSignal) {
  const { flow, camera } = host
  let spots: Spot[] | null = null
  const prompt = document.createElement("div")
  prompt.className = "door-prompt akc-minimal"
  prompt.style.cssText = "position:fixed;left:50%;top:68%;transform:translate(-50%,0);pointer-events:none;opacity:0"
  document.body.appendChild(prompt)
  let shownKey = ""
  let aimed: Spot | null = null
  let holding: Spot | null = null
  let held = 0
  const dir = new THREE.Vector3()
  const to = new THREE.Vector3()

  const show = (html: string) => {
    if (html === shownKey) return
    shownKey = html
    if (html) {
      const shared = [...document.querySelectorAll<HTMLElement>(".door-prompt")].find((el) => el !== prompt && el.style.font)
      if (shared) {
        prompt.style.cssText = shared.style.cssText
        prompt.style.transform = "translate(-50%, 0)"
      }
      // Below the crosshair area, clear of what is being searched (the other prompts sit at 58%).
      prompt.style.top = "68%"
      prompt.innerHTML = html
    }
    prompt.style.opacity = html ? "1" : "0"
  }

  const complete = (s: Spot) => {
    const r = s.take()
    // The locked cabinet stays searchable (its tag can be read again) until the keys come out of it.
    if (s.id !== "story:key-cabinet" || r.items?.includes("truck-keys")) markSearched(s.id)
    const p = s.at
    if (NOISE[s.kind] > 0) emitNoise({ x: p.x, y: p.y, z: p.z }, NOISE[s.kind], s.kind === "locker" || s.kind === "cabinet" || s.kind === "key-cabinet" ? "knock" : "other")
    const sfx = hooks.sfx
    const metal = s.kind === "locker" || s.kind === "cabinet" || s.kind === "key-cabinet"
    sfx?.play(metal ? "int-keys" : "int-paper", { bus: "doors", pos: { x: p.x, y: p.y, z: p.z }, ref: 2, gain: metal ? 0.9 : 0.7, rate: metal ? 0.6 : 1 })
    const got: string[] = []
    for (const i of r.items ?? []) if (addItem(i)) got.push(ITEMS[i].name)
    const fresh = (r.notes ?? []).filter((n) => !hasNote(n))
    for (const n of r.notes ?? []) addNote(n)
    if (r.say) showSubtitle("", r.say, 3.2)
    else if (got.length) showSubtitle("", `Taken: ${got.join(", ")}`, 2.6)
    else if (!(r.notes ?? []).length) showSubtitle("", "Nothing useful.", 1.6)
    if (r.say && got.length) setTimeout(() => showSubtitle("", `Taken: ${got.join(", ")}`, 2.4), 3300)
    // A note opens to read (the first one; reading again from the clipboard).
    const n = (r.notes ?? [])[0]
    if (n && !r.say) showNote(NOTES[n], fresh.includes(n))
  }

  const onDown = (e: KeyboardEvent) => {
    if (e.code !== "KeyE" || e.repeat || !flow.playerActive || !aimed) return
    if (aimed.ready && !aimed.ready()) return
    holding = aimed
    held = 0
    const body = (globalThis as { __afterhoursBody?: { body?: { interact?: (k: string, t?: unknown) => void } } }).__afterhoursBody?.body
    body?.interact?.("button", { x: aimed.at.x, y: aimed.at.y, z: aimed.at.z })
  }
  const onUp = (e: KeyboardEvent) => {
    if (e.code === "KeyE") holding = null
  }
  addEventListener("keydown", onDown)
  addEventListener("keyup", onUp)

  const off = flow.onUpdate((dt) => {
    if (!flow.playerActive) {
      holding = null
      show("")
      return
    }
    spots ??= searchSpots.length ? buildSpots() : null
    if (!spots) return
    const eye = camera.position
    const s = storeyOf(eye.y)
    camera.getWorldDirection(dir)
    aimed = null
    let best = Infinity
    for (const sp of spots) {
      if (sp.storey !== s) continue
      if (Math.abs(sp.at.x - eye.x) > REACH || Math.abs(sp.at.z - eye.z) > REACH) continue
      if (sp.kind !== "read" && wasSearched(sp.id)) continue
      if (!sp.label()) continue
      to.copy(sp.at).sub(eye)
      const d = to.length()
      if (d > REACH) continue
      const along = to.dot(dir)
      const perp = to.addScaledVector(dir, -along).length()
      const ang = Math.atan2(perp, along)
      const ok = d < sp.r ? along > -0.05 : ang < CONE || (along > 0 && perp < sp.r)
      if (ok && ang < best) {
        best = ang
        aimed = sp
      }
    }
    // Keep a hold going while the spot stays in reach and roughly in view (the hand reach sways the view).
    if (holding && holding !== aimed) {
      to.copy(holding.at).sub(eye)
      const along = to.dot(dir)
      if (to.length() > REACH + 0.3 || along < 0 || Math.atan2(to.addScaledVector(dir, -along).length(), along) > CONE * 2) holding = null
      else aimed = holding
    }
    if (holding) {
      held += dt
      if (held >= (holding.hold ?? HOLD)) {
        const h = holding
        holding = null
        complete(h)
      }
    }
    if (!aimed) return show("")
    const label = aimed.label()!
    if (aimed.ready && !aimed.ready()) return show(`<span class="akp-label">${label}</span>`)
    show(keyPromptHtml("KeyE", label, { hold: true, progress: holding ? Math.min(1, held / (holding.hold ?? HOLD)) : 0 }))
  })

  const stop = () => {
    off()
    removeEventListener("keydown", onDown)
    removeEventListener("keyup", onUp)
    prompt.remove()
  }
  signal?.addEventListener("abort", stop)
  ;(globalThis as { __ashwoodSearch?: unknown }).__ashwoodSearch = {
    get aimed() {
      return aimed?.id ?? null
    },
    /** Automation: complete the search of a spot by id (as if held). */
    search: (id: string) => {
      const sp = (spots ??= buildSpots()).find((x) => x.id === id || x.id.startsWith(id))
      if (sp && (!sp.ready || sp.ready())) complete(sp)
      return !!sp
    },
    spots: () => (spots ??= buildSpots()).map((x) => ({ id: x.id, kind: x.kind, storey: x.storey, at: x.at.toArray() })),
  }
  return stop
}
