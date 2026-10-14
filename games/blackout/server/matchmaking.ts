import {
  DEFAULT_RESERVE_MS,
  DEFAULT_STALE_MS,
  SharedMatchmaker,
  pickOpenRoom,
  type RoomEntry as SharedRoomEntry,
} from "@arcade/kit/sim/matchmaking"
import { MAX_PLAYERS } from "../shared/config"
import { randomCode } from "../shared/protocol"

/**
 * What a Room tells the Lobby about itself. `players` counts held seats, so a room at MAX_PLAYERS is full. `mode` is
 * the current game mode; quick join ignores it: everyone votes on the next one anyway.
 */
export type RoomReport = { code: string; players: number; phase: string; private: boolean; mode?: string }
export type RoomEntry = SharedRoomEntry<RoomReport>

export const STALE_MS = DEFAULT_STALE_MS
export const RESERVE_MS = DEFAULT_RESERVE_MS

/** Any room with people in it and a free seat, whatever its phase or mode, and whether or not it was made with Create game. */
const open = (r: RoomEntry) => r.players > 0 && r.players < MAX_PLAYERS

export const pickRoom = (rooms: Iterable<RoomEntry>): RoomEntry | null => pickOpenRoom(rooms, open)

export class Matchmaker extends SharedMatchmaker<RoomReport> {
  constructor(rand: () => number = Math.random) {
    super({ maxPlayers: MAX_PLAYERS, staleMs: STALE_MS, reserveMs: RESERVE_MS, rand, randomCode, isOpen: open })
  }
}
