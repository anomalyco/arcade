/** Who the lobby is waiting on, for the banner and a guest's start button (you first, then everyone else). */
export function lobbyWaitingOn(
  roster: readonly { id: string; name: string; connected: boolean; ready?: boolean }[],
  you: string | undefined,
): { text: string; button: string } {
  const waiting = roster.filter((p) => p.connected && !p.ready)
  if (!waiting.length) return { text: "", button: "Waiting for Host…" }
  const meToo = waiting.some((p) => p.id === you)
  const others = waiting.filter((p) => p.id !== you).map((p) => p.name)
  if (meToo && !others.length) return { text: "waiting for you: press Ready", button: "Ready up to start" }
  const names = others.length > 2 ? `${others.slice(0, 2).join(", ")} +${others.length - 2}` : others.join(" and ")
  return meToo
    ? { text: `waiting for you and ${names}`, button: "Ready up to start" }
    : { text: `waiting for ${names}`, button: `Waiting for ${names}` }
}
