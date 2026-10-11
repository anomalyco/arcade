import type { Role } from "../../shared/config"
import type { Session } from "./session"

/** Online room session. Implemented by the netcode module. */
export const NetSession = {
  async connect(room: string, name: string, picks: Record<Role, string>): Promise<Session> {
    void room
    void name
    void picks
    throw new Error("multiplayer not implemented yet")
  },
}
