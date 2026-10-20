import type { Rect } from "@arcade/kit/sim/geom"

/**
 * House styles (AR-79): what a streamed home is (its form and condition), how its rooms are laid out, and the dressing
 * the client draws from it (roof, siding, trim, porch, chimney, garage, fence, yard). Pure data, picked from the chunk
 * seed by `pickHouseStyle` (`pick.ts`) and stored on the building, so every co-op client draws the same house.
 */

export const HOUSE_FORMS = ["bungalow", "colonial", "ranch", "duplex", "shotgun", "farmhouse", "trailer", "apartment", "corner_store"] as const
export type HouseForm = (typeof HOUSE_FORMS)[number]

export const HOUSE_FORM_LABELS: Record<HouseForm, string> = {
  bungalow: "Bungalow",
  colonial: "Two-storey colonial",
  ranch: "L-shaped ranch",
  duplex: "Duplex",
  shotgun: "Shotgun house",
  farmhouse: "Farmhouse, wrap porch",
  trailer: "Trailer",
  apartment: "Small apartment block",
  corner_store: "Corner store, flat above",
}

/** Kept homes, and the three states a home can be found in instead. */
export const HOUSE_CONDITIONS = ["kept", "derelict", "burnt", "construction"] as const
export type HouseCondition = (typeof HOUSE_CONDITIONS)[number]

export type RoofShape = "gable" | "cross" | "hip" | "flat" | "gambrel" | "shed"
export type Siding = "clapboard" | "brick" | "shingle" | "stucco" | "metal"
export type PorchStyle = "none" | "stoop" | "hood" | "gable" | "shed" | "wrap" | "deck" | "awning"
export type GarageKind = "none" | "attached" | "detached" | "carport"
export type FenceKind = "none" | "picket" | "chainlink" | "hedge" | "rail"
export type WindowPattern = "single" | "pairs" | "band" | "picture"
export type Household = "family" | "elderly" | "hoarder" | "student" | "ransacked" | "hideout"
export type YardKind = "shed" | "swing" | "garden" | "pool" | "junk_car" | "woodpile" | "clothesline" | "tyres" | "trampoline"
export type RoomType =
  | "living"
  | "kitchen"
  | "dining"
  | "bedroom"
  | "nursery"
  | "study"
  | "bath"
  | "laundry"
  | "hall"
  | "garage"
  | "shop"
  | "store"
  | "lobby"
  | "unit"

/** A room: its cell between wall centre lines (walls stand inside it) and what it is. */
export type HouseRoom = { rect: Rect; type: RoomType }

/** Something standing in the yard; `rect` is its ground footprint (sheds, pools, junk cars and woodpiles also collide). */
export type YardItem = { kind: YardKind; rect: Rect; yaw: number }

export type HouseStyle = {
  form: HouseForm
  condition: HouseCondition
  storeys: 1 | 2
  roof: RoofShape
  roofColor: number
  siding: Siding
  trim: number
  /** 0..1: grime, streaks and moss on the walls. */
  wear: number
  porch: PorchStyle
  /** 0 for none, else where along the ridge the chimney stands (0..1). */
  chimney: number
  garage: GarageKind
  fence: FenceKind
  windows: WindowPattern
  shutters: boolean
  household: Household
  rooms: HouseRoom[]
  yard: YardItem[]
  /** Detached garage or carport footprint beside the driveway. */
  outbuilding?: Rect
}

/** Room kinds the floor shader tiles (kitchens, baths, laundries) or leaves bare concrete (garages, stores). */
export const TILED_ROOMS: ReadonlySet<RoomType> = new Set(["kitchen", "bath", "laundry", "shop", "lobby"])
export const BARE_ROOMS: ReadonlySet<RoomType> = new Set(["garage", "store"])
