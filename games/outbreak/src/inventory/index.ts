import { LIGHT_FLOATS } from "@arcade/kit/limits"
import type { LabCommand } from "@arcade/kit/lab/commands"
import { registerOutbreakClientFeature } from "../feature-registry"
import { SURVIVOR_COLOURS } from "../seat-colours"
import { InventoryBag } from "./bag"
import { setInventoryPresenter } from "./hooks"
import { DEFAULT_INVENTORY_SETTINGS, INVENTORY_STYLES, inventoryControls, type InventorySettings, type InventoryStyle } from "./settings"

/**
 * The inventory (AR-94, after the co-op playtest: "It sucks now... A cooler thing. Tab should bring it up."). Lab ›
 * Inventory › Style picks what Tab opens: Today's pack chip, A Ground Pack, B Attaché Case or C Survivor Sheet. Every
 * style sends the same moves to the room (`shared/inventory-ops`), so teammates can each use their own.
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
        cam: ctx.cam,
        w: ctx.w,
        h: ctx.h,
        dt: ctx.dt,
        zoom: ctx.settings.view.zoom,
        names: (i) => (net ? net.nameOf(i) : `Survivor ${i + 1}`),
        colours: colour,
      })
    },
    // The Ground Pack's own lamp: a warm pool on the floor so the mat reads at night (Sons of the Forest's bag light).
    lights: (ctx, lights, count, max) => {
      const a = bag.matAnchor()
      const power = ctx.settings.inventory.invLamp
      if (!a || power <= 0 || count >= max) return count
      const o = count * LIGHT_FLOATS
      lights.fill(0, o, o + LIGHT_FLOATS)
      lights[o] = a.x - a.w * 0.1
      lights[o + 1] = a.ground + 0.9
      lights[o + 2] = a.y
      lights[o + 3] = Math.max(2.2, a.w * 1.1)
      lights[o + 4] = 1
      lights[o + 5] = 0.72
      lights[o + 6] = 0.42
      lights[o + 7] = 1.6 * power
      lights[o + 11] = -1
      lights[o + 14] = 0.12
      lights[o + 15] = -1
      return count + 1
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
