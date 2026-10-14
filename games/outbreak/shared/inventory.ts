export const HOTBAR_SIZE = 5

export type ItemKind = "flashlight" | "pistol" | "ammo" | "plank" | "crowbar" | "medkit" | "noisemaker" | "key"

export type ItemSpec = {
  kind: ItemKind
  label: string
  shortLabel: string
  stackable: boolean
  usesCharge: boolean
}

export const ITEM_CATALOG: Readonly<Record<ItemKind, ItemSpec>> = {
  flashlight: {
    kind: "flashlight",
    label: "Flashlight",
    shortLabel: "LIGHT",
    stackable: false,
    usesCharge: true,
  },
  pistol: {
    kind: "pistol",
    label: "9mm Pistol",
    shortLabel: "9MM",
    stackable: false,
    usesCharge: false,
  },
  ammo: {
    kind: "ammo",
    label: "9mm Ammo",
    shortLabel: "AMMO",
    stackable: true,
    usesCharge: false,
  },
  plank: {
    kind: "plank",
    label: "Wood Plank",
    shortLabel: "PLANK",
    stackable: true,
    usesCharge: false,
  },
  crowbar: {
    kind: "crowbar",
    label: "Crowbar",
    shortLabel: "PRY",
    stackable: false,
    usesCharge: true,
  },
  medkit: {
    kind: "medkit",
    label: "First Aid Kit",
    shortLabel: "MED",
    stackable: true,
    usesCharge: false,
  },
  noisemaker: {
    kind: "noisemaker",
    label: "Alarm Timer",
    shortLabel: "LURE",
    stackable: true,
    usesCharge: false,
  },
  key: {
    kind: "key",
    label: "House Key",
    shortLabel: "KEY",
    stackable: true,
    usesCharge: false,
  },
}

export type InventoryItem = {
  id: string
  kind: ItemKind
  label: string
  shortLabel: string
  charge?: number
  count?: number
  active?: boolean
}

export type InventoryState = {
  slots: (InventoryItem | null)[]
  selectedSlot: number
}

export function createItem(kind: ItemKind, overrides: Partial<InventoryItem> = {}): InventoryItem {
  const spec = ITEM_CATALOG[kind]
  return {
    id: overrides.id ?? kind,
    kind,
    label: overrides.label ?? spec.label,
    shortLabel: overrides.shortLabel ?? spec.shortLabel,
    ...(spec.usesCharge ? { charge: overrides.charge ?? 1 } : {}),
    ...(spec.stackable ? { count: overrides.count ?? 1 } : {}),
    ...(overrides.active !== undefined ? { active: overrides.active } : {}),
  }
}

export function createInventoryState(flashlightOn = true): InventoryState {
  const slots: (InventoryItem | null)[] = Array.from({ length: HOTBAR_SIZE }, () => null)
  slots[0] = createItem("flashlight", { charge: 1, active: flashlightOn })
  return {
    slots,
    selectedSlot: 0,
  }
}

/** Selects a 0-based hotbar slot (0..4 for Digit1..Digit5). */
export function selectHotbarSlot(inv: InventoryState, slot: number): InventoryItem | null {
  if (!Number.isInteger(slot) || slot < 0 || slot >= HOTBAR_SIZE) return inv.slots[inv.selectedSlot] ?? null
  inv.selectedSlot = slot
  return inv.slots[slot] ?? null
}

/** Cycles the active hotbar slot by delta steps (e.g. +1 on scroll down, -1 on scroll up). */
export function cycleHotbarSlot(inv: InventoryState, delta: number): InventoryItem | null {
  if (!Number.isFinite(delta) || delta === 0) return inv.slots[inv.selectedSlot] ?? null
  const step = Number.isInteger(delta) && Math.abs(delta) <= HOTBAR_SIZE ? delta : Math.sign(delta)
  inv.selectedSlot = (((inv.selectedSlot + step) % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE
  return inv.slots[inv.selectedSlot] ?? null
}

/** Adds an item to the first matching stackable slot or first empty hotbar slot. Returns the slot index or -1 if full. */
export function addItemToInventory(inv: InventoryState, item: InventoryItem): number {
  const spec = ITEM_CATALOG[item.kind]
  if (spec.stackable) {
    const existingIdx = inv.slots.findIndex((s) => s?.kind === item.kind)
    if (existingIdx >= 0) {
      const existing = inv.slots[existingIdx]!
      existing.count = (existing.count ?? 1) + (item.count ?? 1)
      return existingIdx
    }
  }
  const emptyIdx = inv.slots.findIndex((s) => s === null)
  if (emptyIdx < 0) return -1
  inv.slots[emptyIdx] = { ...item }
  return emptyIdx
}

/** Removes an item (or 1 stack count) from a slot. */
export function removeItemFromSlot(inv: InventoryState, slot: number, count = 1): InventoryItem | null {
  if (slot < 0 || slot >= HOTBAR_SIZE) return null
  const current = inv.slots[slot]
  if (!current) return null
  if (current.count !== undefined && current.count > count) {
    current.count -= count
    return { ...current, count }
  }
  inv.slots[slot] = null
  return current
}

/** Syncs the flashlight item in the hotbar with the player's authoritative battery and switch state. */
export function syncFlashlightItem(inv: InventoryState, battery: number, flashlightOn: boolean): void {
  for (const item of inv.slots) {
    if (item?.kind === "flashlight") {
      item.charge = battery
      item.active = flashlightOn
    }
  }
}

/** Syncs pistol, 9mm ammo, and plank items in the hotbar when combat or scavenging occurs. */
export function syncCombatInventory(
  inv: InventoryState,
  state: { equippedItem: "pistol" | "hands"; magAmmo: number; reserveAmmo: number; planks: number },
  ensureSlots = false,
): void {
  if (ensureSlots) {
    if (!inv.slots.some((s) => s?.kind === "pistol")) {
      addItemToInventory(
        inv,
        createItem("pistol", {
          shortLabel: `9MM ${state.magAmmo}/${state.reserveAmmo}`,
          active: state.equippedItem === "pistol",
        }),
      )
    }
    if (state.reserveAmmo > 0 && !inv.slots.some((s) => s?.kind === "ammo")) {
      addItemToInventory(inv, createItem("ammo", { count: state.reserveAmmo }))
    }
    if (state.planks > 0 && !inv.slots.some((s) => s?.kind === "plank")) {
      addItemToInventory(inv, createItem("plank", { count: state.planks }))
    }
  }

  for (let i = 0; i < inv.slots.length; i++) {
    const item = inv.slots[i]
    if (!item) continue
    if (item.kind === "pistol") {
      item.shortLabel = `9MM ${state.magAmmo}/${state.reserveAmmo}`
      item.active = state.equippedItem === "pistol"
    } else if (item.kind === "ammo") {
      if (state.reserveAmmo <= 0) inv.slots[i] = null
      else item.count = state.reserveAmmo
    } else if (item.kind === "plank") {
      if (state.planks <= 0) inv.slots[i] = null
      else item.count = state.planks
    }
  }
}
