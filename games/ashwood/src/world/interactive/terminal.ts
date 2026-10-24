export type TerminalPage = "menu" | "lockers" | "logs" | "doors" | "specimens"
export type TerminalRow = { id: string; text: string }
export type TerminalDoor = { id: string; label: string; open: boolean; locked: boolean }
export type TerminalServices = {
  powered: () => boolean
  lockers: () => TerminalRow[]
  logs: () => TerminalRow[]
  doors: () => TerminalDoor[]
  specimens: () => TerminalRow[]
  setDoor: (id: string, open: boolean) => boolean
}
export type TerminalFrame = { title: string; lines: string[]; selected: number; status: string; powered: boolean }
const MENU = [
  { id: "lockers", text: "LOCKER DIRECTORY" }, { id: "logs", text: "ACCESS LOGS" },
  { id: "doors", text: "DOOR CONTROL" }, { id: "specimens", text: "SPECIMEN INVENTORY" },
] as const

/** Input is scoped to this device; the host keeps simulation/hunter updates running while it has focus. */
export class Terminal {
  page: TerminalPage = "menu"
  selected = 0
  active = false
  status = "ASHWOOD / STATION SERVICES"
  private selectedId: string | null = null
  constructor(readonly id: string, readonly services: TerminalServices) {}

  enter(): boolean {
    if (!this.services.powered()) return false
    this.active = true
    return true
  }

  leave(): void { this.active = false }

  private rows(): TerminalRow[] {
    if (this.page === "menu") return [...MENU]
    if (this.page === "doors") return this.services.doors().map(d => ({ id: d.id, text: `${d.open ? "OPEN  " : "CLOSED"} ${d.locked ? "LOCKED " : "       "}${d.label}` }))
    return this.services[this.page]()
  }

  frame(): TerminalFrame {
    const powered = this.services.powered()
    if (!powered) this.leave()
    const rows = this.rows()
    const previous = this.selectedId ? rows.findIndex(r => r.id === this.selectedId) : -1
    this.selected = Math.max(0, Math.min(previous >= 0 ? previous : this.selected, rows.length - 1))
    this.selectedId = rows[this.selected]?.id ?? null
    const first = Math.floor(this.selected / 10) * 10
    return { title: this.page === "menu" ? "ASHWOOD FACILITY NETWORK" : MENU.find(m => m.id === this.page)!.text,
      lines: rows.slice(first, first + 10).map(r => r.text), selected: this.selected - first, status: rows.length ? this.status : "NO RECORDS AVAILABLE", powered }
  }

  key(code: string): boolean {
    if (!this.active) return false
    if (!this.services.powered()) { this.leave(); return false }
    const rows = this.rows()
    if (code === "KeyQ") { this.leave(); return true }
    if (code === "Escape" || code === "Backspace") {
      if (this.page === "menu") this.leave()
      else { this.page = "menu"; this.selected = 0; this.selectedId = null; this.status = "ASHWOOD / STATION SERVICES" }
      return true
    }
    if (code === "ArrowDown" || code === "ArrowUp") {
      this.selected = rows.length ? (this.selected + rows.length + (code === "ArrowDown" ? 1 : -1)) % rows.length : 0
      this.selectedId = rows[this.selected]?.id ?? null
      return true
    }
    if (code !== "Enter" && code !== "KeyE") return false
    if (this.page === "menu") {
      this.page = MENU[this.selected]?.id ?? "menu"
      this.selected = 0; this.selectedId = null
    } else if (this.page === "doors") {
      // Resolve by identity again: a changing directory must not operate the neighbouring door.
      const id = this.selectedId ?? rows[this.selected]?.id
      const door = this.services.doors().find(d => d.id === id)
      if (!door) this.status = "DOOR NO LONGER AVAILABLE"
      else if (door.locked) this.status = "ACCESS DENIED / DOOR LOCKED"
      else this.status = this.services.setDoor(door.id, !door.open) ? `COMMAND SENT / ${door.label}` : "COMMAND REJECTED"
    }
    return true
  }
}
