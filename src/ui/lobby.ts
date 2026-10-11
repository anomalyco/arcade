import type { Role } from "../../shared/config"

export type LobbyResult = { mode: "solo" | "room"; room: string | null; name: string; picks: Record<Role, string> }

/** Title screen: name entry, solo practice or create/join a room from the shared link. */
export async function lobby(root: HTMLElement): Promise<LobbyResult> {
  void root
  const room = new URLSearchParams(location.search).get("r")
  return { mode: room ? "room" : "solo", room, name: localStorage.getItem("getaway.name") ?? "Driver", picks: { robber: "muscle", cop: "cruiser" } }
}
