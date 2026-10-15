// The chat's keys, by physical KeyboardEvent.code (docs/controls.md), kept free of the DOM so tests can run them.

import type { ChatChannel } from "../../shared/chat"

/** What a key does while the chat is closed: open it on a channel, or nothing (the game's). */
export function chatOpenKey(e: { code: string; repeat: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): ChatChannel | null {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return null
  return e.code === "KeyT" ? "all" : e.code === "KeyY" ? "crew" : null
}

/** What a key does inside the open input. Everything else is typing: the input owns every key while it is open. */
export function chatInputKey(code: string): "send" | "cancel" | "channel" | "type" {
  if (code === "Enter" || code === "NumpadEnter") return "send"
  if (code === "Escape") return "cancel"
  if (code === "Tab") return "channel"
  return "type"
}
