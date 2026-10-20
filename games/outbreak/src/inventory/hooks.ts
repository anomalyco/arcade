import type { Command, SessionView } from "../../shared/session"

/**
 * What the inventory feature (AR-94, `src/inventory/`) offers the central input and HUD modules, which never import a
 * feature: the bag Tab opens in every style but Today, and what digits, keys and commands mean while it is open.
 */
export interface InventoryPresenter {
  /** The bag is open. */
  readonly open: boolean
  /** A style other than Today owns Tab. */
  owns(): boolean
  toggle(): void
  /** Closes the bag; true if it was open. */
  close(): boolean
  /** A digit while open (binds the hovered item to that hand slot); null falls through to Today's digit. */
  digit(index: number, view: SessionView): Partial<Command> | null
  /** A key while open (G drops what the cursor is over); true when the bag used it. */
  key(code: string, view: SessionView): boolean
  /** Each fixed-tick command, on its way to the session: the queued move and kneeling. */
  shape(command: Command, first: boolean): Command
}

let current: InventoryPresenter | null = null

export function setInventoryPresenter(presenter: InventoryPresenter | null): void {
  current = presenter
}

export function inventoryPresenter(): InventoryPresenter | null {
  return current
}
