// What the player carries and the notes they have read (play mode). No three.js here: any module can ask
// `hasItem("truck-keys")` cheaply. The clipboard (M) has a page listing both (src/game/map), and the notes put
// handwritten marks on the floor plans (`MAP_MARKS`). Checkpoints save and restore the whole state.
//
//   hasItem("truck-keys")            the escape can start
//   onInventory(() => …)             any change (an item taken, a note read)
//   addItem("lighter")               ids from ITEMS (unknown ids are ignored)

import type { InteractiveState } from "../../world/interactive/world"

export type ItemId =
  | "truck-keys"
  | "cabinet-key"
  | "badge-hargrove"
  | "lighter"
  | "batteries"
  | "photo"
  | "cigarettes"
  | "gum"
  | "pen"
  | "coins"
  | "aspirin"
  | "matches"
  | "tape"
  | "keyring-misc"

export type Item = { id: ItemId; name: string; desc: string; /** Story item: listed first, never random loot. */ key?: boolean }

export const ITEMS: Record<ItemId, Item> = {
  "truck-keys": { id: "truck-keys", name: "Truck 2 keys", desc: "Ignition and padlock keys on a TRUCK 2 fob.", key: true },
  "cabinet-key": { id: "cabinet-key", name: "Cabinet key", desc: "From the Security key box, hook FAC. CAB. Opens the Facilities key cabinet.", key: true },
  "badge-hargrove": { id: "badge-hargrove", name: "Hargrove's badge", desc: "R. Hargrove, systems analyst. Night duty." },
  lighter: { id: "lighter", name: "Lighter", desc: "A brass lighter, half full." },
  batteries: { id: "batteries", name: "D batteries (2)", desc: "For the flashlight. Probably." },
  photo: { id: "photo", name: "Photograph", desc: "Two kids on a dock. On the back: Lake Wapo, July 83." },
  cigarettes: { id: "cigarettes", name: "Cigarettes", desc: "A crushed pack, four left." },
  gum: { id: "gum", name: "Chewing gum", desc: "Spearmint." },
  pen: { id: "pen", name: "Ballpoint pen", desc: "IOPS property." },
  coins: { id: "coins", name: "Change", desc: "Quarters for the vending machine." },
  aspirin: { id: "aspirin", name: "Aspirin", desc: "A small tin, half empty." },
  matches: { id: "matches", name: "Matchbook", desc: "Ashwood Lanes." },
  tape: { id: "tape", name: "Electrical tape", desc: "Black, most of a roll." },
  "keyring-misc": { id: "keyring-misc", name: "Odd keys", desc: "Three small keys on a ring. They don't fit anything you've tried." },
}

export type NoteId = "signout" | "cabinet-tag" | "log-0312" | "note-hargrove" | "note-shift" | "note-coffee" | "note-overtime" | "note-woods" | "note-phone" | "note-parking" | "terminal-lockers" | "terminal-safe" | "terminal-specimens" | `map-floor-${0 | 1 | 2 | 3 | 4}`
export type Note = { id: NoteId; title: string; text: string[]; /** Story note (shapes the objectives and map marks). */ key?: boolean }

export const NOTES: Record<NoteId, Note> = {
  "terminal-lockers": { id: "terminal-lockers", title: "Locker directory", text: ["R. Hargrove: locker 14, Operators' room 3-20.", "Paired locker doors share a compartment. Open both to step inside."] },
  "terminal-safe": { id: "terminal-safe", title: "Directorate access log", text: ["4-16 DIRECTOR'S FILES", "Combination reset: 2 / 4 / 7. Return the dial to zero after use."] },
  "terminal-specimens": { id: "terminal-specimens", title: "Specimen inventory", text: ["Cold room 2-06: refrigerated samples.", "Archive 2-07: retained specimens.", "Containment 2-10: restricted samples; enter through airlock 2-10a."] },
  "map-floor-0": { id: "map-floor-0", title: "Ground-floor plan", text: ["Security 0-38 holds the Facilities cabinet key. Facilities 0-30 holds the vehicle keys."] },
  "map-floor-1": { id: "map-floor-1", title: "Records floor plan", text: ["Records 1-01 and vault 1-01v. Turn the shelving handwheels to move the open aisle."] },
  "map-floor-2": { id: "map-floor-2", title: "Laboratory floor plan", text: ["Cold room 2-06, darkroom 2-09a, containment airlock 2-10a."] },
  "map-floor-3": { id: "map-floor-3", title: "Computing floor plan", text: ["Mainframe 3-04, Signal Room 3-08, operator lockers 3-20, terminal pool 3-24."] },
  "map-floor-4": { id: "map-floor-4", title: "Directorate floor plan", text: ["Director's files and safe: 4-16. Directorate reception 4-10. Director's office 4-14."] },
  signout: {
    id: "signout",
    title: "Vehicle sign-out, by 3-08",
    key: true,
    text: ["10/17  TRUCK 1  out 07:05  in 07:40  SV", "10/17  TRUCK 2  out 21:40  in 23:55", "keys returned to Facilities 0-30 key cabinet.  RH"],
  },
  "cabinet-tag": { id: "cabinet-tag", title: "Tag on the key cabinet, 0-30", key: true, text: ["Cabinet key held at Security, 0-38."] },
  "log-0312": {
    id: "log-0312",
    title: "Receiver log, 3-08 (last entries)",
    text: ["02:16  It's coming from the woods.", "03:00  TX-1 off.", "03:03  DON'T TAKE THE HEADPHONES OFF", "03:12  Hargrove wants to take Truck 2 into town. Told him wait for light."],
  },
  "note-hargrove": {
    id: "note-hargrove",
    title: "Crumpled note, Hargrove's pocket",
    text: ["Rob,", "You signed Truck 2 back in at 23:55 but the mileage says you went 30 miles. Where did you go Wednesday night?", "Don't take the truck out at night again. Not after what you told me.", "Walt, Facilities"],
  },
  "note-shift": { id: "note-shift", title: "Shift swap request", text: ["Can anyone cover Thurs 2300?", "Will trade for any weekend. Gary x168"] },
  "note-coffee": { id: "note-coffee", title: "Note on a coffee can", text: ["COFFEE FUND", "25 cents a cup. This means YOU, 3rd floor."] },
  "note-overtime": { id: "note-overtime", title: "Overtime sheet", text: ["Week of 10/15: 14 hrs.", "Not approved. See Mgr."] },
  "note-woods": { id: "note-woods", title: "Scrap of paper", text: ["lights in the trees again", "north side, 2am, nobody out there"] },
  "note-phone": { id: "note-phone", title: "Phone message slip", text: ["WHILE YOU WERE OUT", "Your wife called. Call home.", "Tues 9:40pm"] },
  "note-parking": { id: "note-parking", title: "Parking notice", text: ["North lot CLOSED until further notice.", "Use the south lot."] },
}

/** Handwritten marks the read notes put on the floor plans (storey, room id, text). */
/** A handwritten mark: on a room of a storey plan, or at a world point (`at`: [x, z], outside the building), and also
 *  on the site plan when `site`. */
export type MapMark = { storey: number; room?: string; at?: readonly [number, number]; site?: boolean; text: string[] }
export const MAP_MARKS: Partial<Record<NoteId | ItemId, MapMark[]>> = {
  "terminal-lockers": [{ storey: 3, room: "3-20", text: ["Hargrove", "locker 14"] }],
  "terminal-safe": [{ storey: 4, room: "4-16", text: ["SAFE", "2 / 4 / 7"] }],
  "terminal-specimens": [{ storey: 2, room: "2-06", text: ["cold samples"] }, { storey: 2, room: "2-10a", text: ["containment entry"] }],
  signout: [{ storey: 0, room: "0-30", text: ["TRUCK 2 keys", "in the cabinet"] }],
  "cabinet-tag": [{ storey: 0, room: "0-38", text: ["cabinet key", "at Security"] }],
  // The vehicle shed in the dock court (src/game/escape/places.ts SHED).
  "truck-keys": [{ storey: 0, at: [-49.75, -35.2], site: true, text: ["TRUCK 2"] }],
}

const items: ItemId[] = []
const notes: NoteId[] = []
const searched = new Set<string>()
const listeners = new Set<() => void>()
const changed = () => {
  for (const l of listeners) l()
}

export const hasItem = (id: string) => items.includes(id as ItemId)
export const hasNote = (id: string) => notes.includes(id as NoteId)
export const carriedItems = (): readonly Item[] => items.map((i) => ITEMS[i])
export const readNotes = (): readonly Note[] => notes.map((n) => NOTES[n])

export function addItem(id: ItemId) {
  if (!ITEMS[id] || hasItem(id)) return false
  items.push(id)
  changed()
  return true
}
export function removeItem(id: ItemId) {
  const i = items.indexOf(id)
  if (i < 0) return false
  items.splice(i, 1)
  changed()
  return true
}
export function addNote(id: NoteId) {
  if (!NOTES[id] || hasNote(id)) return false
  notes.push(id)
  changed()
  return true
}

/** Searchable spots already searched (by id), so a checkpoint restore keeps them empty. */
export const wasSearched = (id: string) => searched.has(id)
export function markSearched(id: string) {
  searched.add(id)
}

export function onInventory(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The marks for every note read and story item carried. */
export function mapMarks(): MapMark[] {
  return [...notes, ...items].flatMap((k) => MAP_MARKS[k as NoteId] ?? [])
}

let propPersistence: { save(): InteractiveState; restore(state?: InteractiveState): void } | null = null
export function bindPropPersistence(persistence: typeof propPersistence) { propPersistence = persistence }
export type InventoryState = { items: ItemId[]; notes: NoteId[]; searched: string[]; props?: InteractiveState }
export const inventoryState = (): InventoryState => ({ items: [...items], notes: [...notes], searched: [...searched], props: propPersistence?.save() })
export function restoreInventory(s: Partial<InventoryState> | undefined) {
  items.length = 0
  notes.length = 0
  searched.clear()
  for (const i of s?.items ?? []) if (ITEMS[i]) items.push(i)
  for (const n of s?.notes ?? []) if (NOTES[n]) notes.push(n)
  for (const k of s?.searched ?? []) searched.add(k)
  propPersistence?.restore(s?.props)
  changed()
}

;(globalThis as { __ashwoodInventory?: unknown }).__ashwoodInventory = { hasItem, hasNote, addItem, addNote, carriedItems, readNotes, inventoryState, restoreInventory }
