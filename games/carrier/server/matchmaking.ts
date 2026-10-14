import {
  DEFAULT_RESERVE_MS,
  DEFAULT_STALE_MS,
  SharedMatchmaker,
  pickOpenRoom,
  type RoomEntry as SharedRoomEntry,
  type RoomInfo,
} from "@arcade/kit/sim/matchmaking"
import { CREW, randomCode } from "../shared/crew"

export type { RoomInfo }
export type RoomReport = { code: string; players: number; private: boolean }
export type RoomEntry = SharedRoomEntry<RoomReport>

export const STALE_MS = DEFAULT_STALE_MS
export const RESERVE_MS = DEFAULT_RESERVE_MS

export const isOpen = (r: RoomReport): boolean => !r.private && r.players > 0 && r.players < CREW.roomMax

export function pickRoom(rooms: Iterable<RoomEntry>, open: (r: RoomEntry) => boolean = isOpen): RoomEntry | null {
  return pickOpenRoom(rooms, open)
}

export class Matchmaker extends SharedMatchmaker<RoomReport> {
  constructor(rand: () => number = Math.random, open: (r: RoomEntry) => boolean = isOpen) {
    super({ maxPlayers: CREW.roomMax, staleMs: STALE_MS, reserveMs: RESERVE_MS, rand, randomCode, isOpen: open })
  }
}
