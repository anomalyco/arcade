import {
  DEFAULT_RESERVE_MS,
  SharedMatchmaker,
  pickOpenRoom,
  type RoomEntry as SharedRoomEntry,
} from "@arcade/kit/sim/matchmaking"
import { MAX_PLAYERS } from "../shared/config"
import { randomCode } from "../shared/protocol"

/** What a Room tells the Lobby about itself. `players` counts held seats, so a room at MAX_PLAYERS is full. */
export type RoomReport = { code: string; players: number; phase: string; private: boolean }
export type RoomEntry = SharedRoomEntry<RoomReport>

export const STALE_MS = 120_000
export const RESERVE_MS = DEFAULT_RESERVE_MS

const open = (r: RoomEntry) => !r.private && r.players > 0 && r.players < MAX_PLAYERS

export const pickRoom = (rooms: Iterable<RoomEntry>): RoomEntry | null => pickOpenRoom(rooms, open, "waiting")

export class Matchmaker extends SharedMatchmaker<RoomReport> {
  constructor(rand: () => number = Math.random) {
    super({ maxPlayers: MAX_PLAYERS, staleMs: STALE_MS, reserveMs: RESERVE_MS, rand, randomCode, isOpen: open, preferPhase: "waiting" })
  }
}
