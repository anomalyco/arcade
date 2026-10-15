import { SharedMatchmaker, type RoomEntry } from "@arcade/kit/sim/matchmaking"
import { LobbyObject } from "@arcade/kit/server/lobby-object"
import { MAX_PLAYERS } from "../shared/config"
import { randomCode } from "../shared/protocol"
import type { Env } from "./env"

export type RoomReport = { code: string; players: number; phase: string; private: boolean }

/** Quick join fills any room with people in it and a free seat. */
const open = (r: RoomEntry<RoomReport>) => r.players > 0 && r.players < MAX_PLAYERS

export class Lobby extends LobbyObject<Env, RoomReport> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, new SharedMatchmaker<RoomReport>({ maxPlayers: MAX_PLAYERS, randomCode, isOpen: open, preferPhase: "select" }))
  }
}
