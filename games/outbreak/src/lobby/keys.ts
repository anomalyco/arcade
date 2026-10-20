export type LobbyKeyAction =
  | { act: "variant"; variant: 0 | 1 | 2 | 3 }
  | { act: "solo" | "host" | "training" | "ready" | "unready" | "copy" | "start" | "leave" }

export type LobbyKeyState = {
  mode: "start" | "coop"
  /** The practice space is live behind the panel: the game owns the keyboard except Enter. */
  practice: boolean
  /** The lobby offers the guided training room (only without the practice space). */
  training: boolean
  ready: boolean
  canStart: boolean
}

/**
 * What a key press does in the lobby, or null to leave it to the game. Over the practice space only Enter is the
 * lobby's (Play Solo, or Ready then Start in a room), so moving, F, E, B, Tab, digits, R and C all practise; nothing
 * there can leave a room by accident. Without it, today's menu keys.
 */
export function lobbyKeyAction(code: string, s: LobbyKeyState): LobbyKeyAction | null {
  if (s.practice) {
    if (code !== "Enter" && code !== "NumpadEnter") return null
    if (s.mode === "start") return { act: "solo" }
    if (!s.ready) return { act: "ready" }
    return s.canStart ? { act: "start" } : { act: "unready" }
  }
  if (code === "Digit1" || code === "Digit2" || code === "Digit3" || code === "Digit4") {
    return { act: "variant", variant: (Number(code.slice(-1)) - 1) as 0 | 1 | 2 | 3 }
  }
  if (s.mode === "start") {
    if (code === "Enter" || code === "Escape") return { act: "solo" }
    if (code === "KeyH") return { act: "host" }
    if (code === "KeyT" && s.training) return { act: "training" }
    return null
  }
  if (code === "KeyR") return { act: s.ready ? "unready" : "ready" }
  if (code === "KeyC") return { act: "copy" }
  if (code === "Enter" && s.canStart) return { act: "start" }
  if (code === "Escape") return { act: "leave" }
  return null
}
