import type { LabCommand } from "@arcade/kit/lab/commands"
import type { LabControl } from "@arcade/kit/lab-panel"
import { blastAge, DYN_RING, ringId } from "../../shared/fire/fire"
import { supportHeight } from "../../shared/terrain"
import { registerOutbreakClientFeature } from "../feature-registry"
import { currentFire } from "./presenter"
import { allFireControls, DEFAULT_FIRE_SETTINGS } from "./settings"
import { FIRE_GIVE_ITEMS, FIRE_SCENES, giveFire, stageFire, type FireScene } from "./stage"

const G = "Fire & explosives"

/** Blasts already felt, by `dyn:<k>` and its throw time, so each shakes the camera once. */
const felt = new Map<string, number>()

/**
 * Fire & explosives (AR-62), client half: Lab tunables and look (Backquote › Fire & explosives), give and stage
 * actions, the `fire.give` and `fire.stage` commands, harness telemetry, and each blast's camera shake and gore.
 * The flames, smoke, light, scorch marks and rigs are drawn by `FirePresenter` from `scene/frame-renderer.ts`.
 */
export const outbreakFireFeature = registerOutbreakClientFeature({
  id: "fire",
  order: 29,
  settingsGroup: { subsystem: "fire", defaults: DEFAULT_FIRE_SETTINGS },
  labControls: (host) => [
    ...allFireControls,
    ...FIRE_GIVE_ITEMS.map(
      (item): LabControl => ({
        key: `fireGive-${item}`,
        label: `Give: ${item.replace(/-/g, " ")}`,
        group: G,
        type: "action",
        run: () => {
          if (host.progressionHost.offline()) giveFire(host.discoveryHost.view(), item, item === "fuel" ? 2 : 1)
        },
      }),
    ),
    ...FIRE_SCENES.map(
      (scene): LabControl => ({
        key: `fireStage-${scene}`,
        label: `Stage: ${scene.replace(/-/g, " ")}`,
        group: G,
        type: "action",
        run: () => {
          if (host.progressionHost.offline()) stageFire(host.discoveryHost, host.session(), scene)
        },
      }),
    ),
  ],
  gameCommands: (host): LabCommand[] => [
    {
      id: "fire.give",
      label: "Give a Fire & Explosives Item",
      shortLabel: "Give Fire Item",
      category: "Scene",
      undoable: false,
      args: {
        item: { type: "string", description: `Item (${FIRE_GIVE_ITEMS.join(", ")})` },
        count: { type: "number", description: "How many (default 1)" },
      },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const item = String(args?.item ?? "flamethrower")
        if (!(FIRE_GIVE_ITEMS as readonly string[]).includes(item)) throw new Error(`Unknown item ${item}`)
        const count = Math.max(1, Math.round(Number(args?.count ?? 1)))
        giveFire(host.session().view, item, count)
        return { item, count }
      },
    },
    {
      id: "fire.stage",
      label: "Stage a Fire & Explosives Scene",
      shortLabel: "Fire Scene",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${FIRE_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "flamethrower") as FireScene
        if (!FIRE_SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
        return { scene, at: stageFire(host.discoveryHost, host.session(), scene) }
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages a fire & explosives scene (`fire.stage`). */
    stageFire(scene: FireScene) {
      return stageFire(host.discoveryHost, host.session(), scene)
    },
    /** Gives a fire & explosives item and puts it in hand (`fire.give`). */
    giveFire(item: string, count = 1) {
      giveFire(host.session().view, item, count)
    },
  }),
  harnessState: () => ({ fire: currentFire()?.shown ?? null }),
  feel: {
    reset: () => felt.clear(),
    processFrame: (ctx) => {
      const view = ctx.session.view
      const time = view.time
      for (let k = 0; k < DYN_RING; k++) {
        const st = view.progression.ledger.store(ringId("dyn", k))
        if (!st?.at || !st.counts.t) continue
        const age = blastAge(st, time)
        const key = ringId("dyn", k)
        if (age < 0 || age > 0.5 || felt.get(key) === st.counts.t) continue
        felt.set(key, st.counts.t)
        const { x, y } = st.at
        const d = Math.hypot(x - view.player.x, y - view.player.y)
        ctx.cam.add(Math.max(0, Math.min(1, 1.1 - d / 32)) * ctx.settings.fire.blastShake)
        // Blood thrown out from the dead caught in it.
        const R = ctx.settings.fire.dynRadius * 1.2
        let n = 0
        for (const z of view.zombies) {
          if (n >= 8) break
          const dz = Math.hypot(z.x - x, z.y - y)
          if (dz > R) continue
          ctx.combatFx.emitShoveHit(z.x, z.y, Math.atan2(z.y - y, z.x - x), supportHeight(view.town, z.x, z.y), 3, z.id * 31 + k)
          n++
        }
      }
      return ctx.addCount
    },
  },
})
