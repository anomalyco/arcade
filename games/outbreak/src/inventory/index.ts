import type { LabCommand } from "@arcade/kit/lab/commands"
import { registerOutbreakClientFeature } from "../feature-registry"
import { SURVIVOR_COLOURS } from "../seat-colours"
import { InventoryBag } from "./bag"
import { setInventoryPresenter } from "./hooks"
import { DEFAULT_INVENTORY_SETTINGS, INVENTORY_STYLES, inventoryControls, type InventorySettings, type InventoryStyle } from "./settings"

/**
 * The inventory (AR-94, after the co-op playtest: "It sucks now... A cooler thing. Tab should bring it up."). D-46
 * picked the Attaché Case: Tab opens it (Lab › Inventory › Style keeps Today's dock sheet one setting away). Both send
 * the same moves to the room (`shared/inventory-ops`), so teammates can each use their own.
 */
let settingsRef: InventorySettings = { ...DEFAULT_INVENTORY_SETTINGS }
const bag = new InventoryBag(() => settingsRef)
setInventoryPresenter(bag)

const colour = (index: number) => SURVIVOR_COLOURS[index % SURVIVOR_COLOURS.length]!.css

export const outbreakInventoryFeature = registerOutbreakClientFeature({
  id: "inventory",
  order: 62,
  settingsGroup: { subsystem: "inventory", defaults: DEFAULT_INVENTORY_SETTINGS },
  labControls: () => inventoryControls(),
  frame: {
    overlay: (ctx) => {
      settingsRef = ctx.settings.inventory
      const net = ctx.coop.net
      bag.frame({
        view: ctx.session.view,
        session: ctx.session,
        w: ctx.w,
        h: ctx.h,
        dt: ctx.dt,
        names: (i) => (net ? net.nameOf(i) : `Survivor ${i + 1}`),
        colours: colour,
      })
    },
  },
  gameCommands: (host): LabCommand[] => [
    {
      id: "inventory.open",
      label: "Open the Inventory",
      shortLabel: "Inventory",
      category: "Scene",
      undoable: false,
      enabled: () => true,
      args: { style: { type: "string", description: `${INVENTORY_STYLES.join(" | ")} (default: the Lab setting)` } },
      run: (_ctx, args) => {
        const style = typeof args?.style === "string" && (INVENTORY_STYLES as readonly string[]).includes(args.style) ? (args.style as InventoryStyle) : null
        if (style) host.settings.inventory.inventoryStyle = style
        settingsRef = host.settings.inventory
        bag.close()
        bag.show()
        return bag.inspect()
      },
    },
    {
      id: "inventory.close",
      label: "Close the Inventory",
      shortLabel: "Close",
      category: "Scene",
      undoable: false,
      enabled: () => true,
      run: () => ({ closed: bag.close() }),
    },
  ],
  harnessState: () => ({ inventory: bag.inspect() }),
})
