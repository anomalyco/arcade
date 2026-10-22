import { cleanPlayerName, randomRoomCode } from "../sim/matchmaking"

export type LobbyPlayer = {
  id: string
  name: string
  /** Ready to start (games with a ready step). */
  ready?: boolean
  host?: boolean
  you?: boolean
  /** Disconnected and inside the reconnect grace. */
  away?: boolean
}

/** The room connection as the player sees it. `lost` is final (the room refused or ended the session). */
export type LobbyConnection = "offline" | "connecting" | "online" | "reconnecting" | "lost"

export type ShellLobbyOptions = {
  game: string
  /** Where the name is saved (default `<game>.name`, the key every game already used). */
  nameKey?: string
  maxName?: number
  /** The name used when the field is empty. */
  fallbackName?: string
  /** Whether the title offers Play with friends (create, join, invite). */
  friends?: boolean
  /** The invite link's query parameter (default `room`; Getaway's is `r`). */
  roomParam?: string
  /** Room codes the game accepts (default 4–8 letters and digits). */
  roomPattern?: RegExp
  /** Room codes are upper case in this game (Getaway, Carrier display). */
  upperCase?: boolean
  /** Asks the server for a fresh private room (`api/create`); a random code when it can't be reached. */
  createRoom?: () => Promise<string>
  /** Play alone, from the title. */
  onSolo?: (name: string) => void
  /** Enter a room (created, joined by code or from an invite link). */
  onJoin?: (room: string, name: string) => void
  /** Leave the room for the title. */
  onLeaveRoom?: () => void
  /** The player toggled ready (games with a ready step). */
  onReady?: (ready: boolean) => void
  /** The host starts (games that start together). */
  onStart?: () => void
  /** The name changed (a game in a room renames the seat). */
  onRename?: (name: string) => void
  storage?: Pick<Storage, "getItem" | "setItem"> | null
  /** The page URL (tests). */
  location?: { origin: string; pathname: string; search: string }
}

const DEFAULT_ROOM = /^[a-z0-9]{4,8}$/i

/**
 * The title's lobby, headless: the player's name (saved), Play alone, Play with friends (create a room, join by code
 * or invite link, copy the invite), the room's players with ready and start, and the connection state for reconnect
 * UI. The game owns the room itself (`@arcade/kit/net/room-socket`) and pushes players and connection here.
 */
export class ShellLobby {
  name: string
  room: string | null = null
  players: readonly LobbyPlayer[] = []
  connection: LobbyConnection = "offline"
  /** A short line for the player: a connection problem, a refused room, a bad code. */
  message: string | null = null
  busy = false
  readonly friends: boolean
  private readonly listeners = new Set<() => void>()
  private readonly loc: { origin: string; pathname: string; search: string }

  constructor(private readonly o: ShellLobbyOptions) {
    this.friends = o.friends ?? Boolean(o.onJoin)
    this.loc = o.location ?? (typeof location === "undefined" ? { origin: "", pathname: "/", search: "" } : location)
    this.name = this.read(o.nameKey ?? `${o.game}.name`) ?? ""
  }

  /** The room code in the page URL (an invite link), if it looks like one. */
  get linkedRoom(): string | null {
    return this.parseRoom(new URLSearchParams(this.loc.search).get(this.o.roomParam ?? "room") ?? "")
  }

  get you(): LobbyPlayer | undefined {
    return this.players.find((p) => p.you)
  }

  get isHost(): boolean {
    return Boolean(this.you?.host)
  }

  get ready(): boolean {
    return Boolean(this.you?.ready)
  }

  /** The host may start: everyone connected is ready (games without a ready step: always). */
  get canStart(): boolean {
    if (!this.o.onStart || !this.isHost) return false
    if (!this.o.onReady) return true
    const here = this.players.filter((p) => !p.away)
    return here.length > 0 && here.every((p) => p.ready)
  }

  get hasReady(): boolean {
    return Boolean(this.o.onReady)
  }

  get hasStart(): boolean {
    return Boolean(this.o.onStart)
  }

  /** The name to play under: what was typed, cleaned, or the game's fallback. */
  get playName(): string {
    return cleanPlayerName(this.name, this.o.maxName ?? 16, this.o.fallbackName ?? "")
  }

  inviteLink(room = this.room): string {
    if (!room) return ""
    return `${this.loc.origin}${this.loc.pathname}?${this.o.roomParam ?? "room"}=${encodeURIComponent(room)}`
  }

  /** Accepts a bare code or a pasted invite link; null when it isn't one. */
  parseRoom(input: string): string | null {
    let v = input.trim()
    try {
      if (/^https?:\/\//i.test(v)) v = new URL(v).searchParams.get(this.o.roomParam ?? "room") ?? ""
    } catch {
      return null
    }
    v = v.replace(/[^a-z0-9]/gi, "")
    if (!(this.o.roomPattern ?? DEFAULT_ROOM).test(v)) return null
    return this.o.upperCase ? v.toUpperCase() : v.toLowerCase()
  }

  setName(name: string): void {
    const clean = name.slice(0, this.o.maxName ?? 16)
    if (clean === this.name) return
    this.name = clean
    this.write(this.o.nameKey ?? `${this.o.game}.name`, clean.trim())
    if (this.room) this.o.onRename?.(this.playName)
    this.emit()
  }

  playAlone(): void {
    this.message = null
    this.o.onSolo?.(this.playName)
    this.emit()
  }

  /** Creates a private room and enters it. */
  async playWithFriends(): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.message = null
    this.emit()
    let room: string | null = null
    try {
      room = this.parseRoom(await (this.o.createRoom ?? defaultCreateRoom)())
    } catch {}
    this.busy = false
    this.enter(room ?? (this.o.upperCase ? randomRoomCode().toUpperCase() : randomRoomCode()))
  }

  /** Joins by code or invite link; false (with a message) when it isn't one. */
  join(input: string): boolean {
    const room = this.parseRoom(input)
    if (!room) {
      this.message = "Enter a room code or paste an invite link."
      this.emit()
      return false
    }
    this.enter(room)
    return true
  }

  /** Copies the invite link; resolves false when the clipboard is unavailable (show the link instead). */
  async copyInvite(): Promise<boolean> {
    const link = this.inviteLink()
    if (!link) return false
    try {
      await navigator.clipboard.writeText(link)
      return true
    } catch {
      return false
    }
  }

  setReady(ready: boolean): void {
    this.o.onReady?.(ready)
  }

  start(): void {
    if (this.canStart) this.o.onStart?.()
  }

  leaveRoom(): void {
    if (!this.room) return
    this.room = null
    this.players = []
    this.connection = "offline"
    this.message = null
    this.replaceRoomParam(null)
    this.o.onLeaveRoom?.()
    this.emit()
  }

  // The game reports its room here.

  /** The room this page is in (null for solo); puts it in the address bar so the URL is the invite. */
  setRoom(room: string | null): void {
    if (room === this.room) return
    this.room = room
    this.replaceRoomParam(room)
    this.emit()
  }

  setPlayers(players: readonly LobbyPlayer[]): void {
    this.players = players
    this.emit()
  }

  setConnection(connection: LobbyConnection, message: string | null = null): void {
    if (connection === this.connection && message === this.message) return
    this.connection = connection
    this.message = message
    this.emit()
  }

  /** Maps a `RoomSocket.status()` line (null when fine) onto the connection state. */
  setSocketStatus(status: string | null): void {
    if (status === null) return this.setConnection("online")
    this.setConnection(/connecting…$/i.test(status) && !/lost/i.test(status) ? "connecting" : /idle/i.test(status) ? "online" : "reconnecting", status)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private enter(room: string): void {
    this.setRoom(room)
    this.connection = "connecting"
    this.o.onJoin?.(room, this.playName)
    this.emit()
  }

  private replaceRoomParam(room: string | null): void {
    if (typeof history === "undefined" || typeof location === "undefined" || this.o.location) return
    const url = new URL(location.href)
    const key = this.o.roomParam ?? "room"
    if (room) url.searchParams.set(key, room)
    else url.searchParams.delete(key)
    if (url.href !== location.href) history.replaceState(history.state, "", url)
  }

  private read(key: string): string | null {
    try {
      return (this.o.storage === undefined ? globalThis.localStorage : this.o.storage)?.getItem(key) ?? null
    } catch {
      return null
    }
  }

  private write(key: string, value: string): void {
    try {
      ;(this.o.storage === undefined ? globalThis.localStorage : this.o.storage)?.setItem(key, value)
    } catch {}
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }
}

async function defaultCreateRoom(): Promise<string> {
  const res = await fetch("api/create", { method: "POST", cache: "no-store" })
  const body = (await res.json()) as { room?: unknown }
  return typeof body.room === "string" ? body.room : ""
}
