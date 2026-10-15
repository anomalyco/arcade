import type { SectionFactory } from "@arcade/kit/lab/types"
import { createOverworldSection, overviewCamera, type OverworldDiorama } from "@arcade/kit/lab/overworld/diorama"
import { createOverworld, type OverworldController, type OverworldDev, type StationChanges } from "@arcade/kit/lab/overworld/overworld"
import { orderStations, validateStations, type LabStation } from "@arcade/kit/lab/overworld/types"
import type { lab } from "@arcade/kit/lab/main"
import { STATIONS } from "./stations"

type LabApi = Awaited<ReturnType<typeof lab>>

/** The dev router's page meta: present only when the page is served by `bun run dev`. */
export function devRouter(): { pageToken: string } | null {
  if (!import.meta.env.DEV) return null
  const meta = document.querySelector<HTMLMetaElement>('meta[name="arcade-dev-router"]')
  try {
    const parsed = meta ? (JSON.parse(meta.content) as { pageToken?: string }) : null
    return parsed?.pageToken ? { pageToken: parsed.pageToken } : null
  } catch {
    return null
  }
}

export function prepareOverworld() {
  const problems = validateStations(STATIONS)
  for (const problem of problems) console.warn(`[overworld] ${problem}`)
  const stations = orderStations(STATIONS).map(o => o.station)
  let diorama: OverworldDiorama | undefined
  let controller: OverworldController | undefined
  const section: SectionFactory = context => {
    diorama = createOverworldSection(context, stations, () =>
      controller?.returnCamera() ?? overviewCamera(diorama!.plots, innerWidth / Math.max(1, innerHeight)), innerWidth / Math.max(1, innerHeight))
    return diorama.section
  }

  async function start(api: LabApi, ensureGame: (game: string) => Promise<boolean>) {
    if (!diorama) throw new Error("Overworld section was not created")
    const router = devRouter()
    const dev: OverworldDev | undefined = router
      ? { changes: station => fetchChanges(router.pageToken, station) }
      : undefined
    controller = createOverworld({
      host: {
        stage: api.context.stage,
        viewport: api.viewport,
        canvas: api.canvas,
        commands: api.workbench.commands,
        hasSection: id => api.sections.some(s => s.id === id),
        select: id => api.select(id),
        invoke: (id, args) => api.workbench.invoke(id, args),
        chrome: api.chrome,
        suspend: api.suspend,
        render: () => api.render(),
        telemetry: () => api.sections.find(s => s.id === api.settings.section)?.telemetry?.() ?? "",
        mode: () => api.workbench.getMode(),
        gridOpen: () => api.workbench.gridOpen(),
        selectedIds: () => api.workbench.getSelectedIds(),
        ensureGame,
      },
      diorama,
      stations,
      dev,
    })
    if (import.meta.env.DEV && router && dev) {
      // The recorder is dev-only and loads after the map is up.
      const { createFeedbackRecorder } = await import("@arcade/kit/lab/feedback/recorder")
      const recorder = createFeedbackRecorder({
        viewport: api.viewport,
        canvas: api.canvas,
        capture: async target => {
          if (await controller!.capturePage(target)) return
          await api.render()
          await api.context.stage.captureToCanvas(target)
        },
        overworld: controller,
        state: () => ({
          preset: (() => { try { return JSON.parse(api.workbench.exportPreset()) as unknown } catch { return null } })(),
          scene: (() => { try { const s = api.workbench.state(); return { section: s.section, environment: s.environment, seed: s.seed, effectSeed: s.effectSeed, transport: s.transport, camera: s.camera, settings: s.settings, lighting: s.lighting } } catch { return null } })(),
        }),
        submit: payload => postFeedback(router.pageToken, payload),
        isBusy: () => api.workbench.getMode() === "play",
      })
      dev.toggleNote = () => recorder.toggle()
      dev.noteActive = () => recorder.active()
      controller.refresh()
    }
    const station = new URLSearchParams(location.search).get("station")
    await controller.start(station)
    Object.assign(window, { overworld: controller })
    return controller
  }

  return { section, start, stations }
}

async function fetchChanges(token: string, station: LabStation): Promise<StationChanges | null> {
  const q = new URLSearchParams()
  if (station.paths?.length) q.set("paths", station.paths.join(","))
  if (station.branches?.length) q.set("branches", station.branches.join(","))
  const res = await fetch(`/__arcade/lab/changes?${q}`, { headers: { "x-arcade-page-token": token } })
  return res.ok ? ((await res.json()) as StationChanges) : null
}

async function postFeedback(token: string, payload: unknown) {
  const res = await fetch("/__arcade/lab/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-arcade-page-token": token },
    body: JSON.stringify(payload),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok && !json.error) json.error = `Dev server answered ${res.status}`
  return json
}
