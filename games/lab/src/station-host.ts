import { createStations, type StationChanges, type StationDev, type StationsController } from "@arcade/kit/lab/stations/workspace"
import { orderStations, validateStations, type LabStation } from "@arcade/kit/lab/stations/types"
import type { lab } from "@arcade/kit/lab/main"
import { STATIONS } from "./stations/index"

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

/** The station files, checked: a bad file is reported and skipped, never fatal. */
export function stationList(): LabStation[] {
  for (const problem of validateStations(STATIONS)) console.warn(`[stations] ${problem}`)
  return orderStations(STATIONS).map(o => o.station)
}

/** Mounts stations into the running Lab, with the dev server's recent changes and voice notes when present. */
export async function startStations(api: LabApi, ensureGame: (game: string) => Promise<boolean>): Promise<StationsController> {
  const router = devRouter()
  const dev: StationDev | undefined = router ? { changes: station => fetchChanges(router.pageToken, station) } : undefined
  const stations = createStations({
    host: {
      stage: api.context.stage,
      viewport: api.viewport,
      canvas: api.canvas,
      root: api.slots.root,
      slots: api.slots,
      panel: api.panel,
      commands: api.workbench.commands,
      hasSection: id => api.sections.some(s => s.id === id),
      groups: id => api.groups(id),
      activeSection: () => api.settings.section,
      select: id => api.select(id),
      onSection: listener => void api.onSection(listener),
      invoke: (id, args) => api.workbench.invoke(id, args),
      suspend: api.suspend,
      mode: () => api.workbench.getMode(),
      onDigit: handler => api.workbench.onDigit(handler),
      ensureGame,
      libraryOpen: () => api.workbench.libraryOpen(),
    },
    stations: stationList(),
    dev,
  })
  if (import.meta.env.DEV && router && dev) {
    // The recorder is dev-only and loads after the Lab is up.
    const { createFeedbackRecorder } = await import("@arcade/kit/lab/feedback/recorder")
    const recorder = createFeedbackRecorder({
      viewport: api.viewport,
      canvas: api.canvas,
      capture: async target => {
        if (await stations.capturePage(target)) return
        await api.render()
        await api.context.stage.captureToCanvas(target)
      },
      stations,
      state: () => ({
        preset: (() => { try { return JSON.parse(api.workbench.exportPreset()) as unknown } catch { return null } })(),
        scene: (() => { try { const s = api.workbench.state(); return { section: s.section, environment: s.environment, seed: s.seed, effectSeed: s.effectSeed, transport: s.transport, camera: s.camera, settings: s.settings, lighting: s.lighting } } catch { return null } })(),
        tuning: { ...api.panel.tuning },
      }),
      submit: payload => postFeedback(router.pageToken, payload),
      isBusy: () => api.workbench.getMode() === "play",
    })
    dev.toggleNote = () => recorder.toggle()
    dev.noteActive = () => recorder.active()
  }
  const params = new URLSearchParams(location.search)
  const station = params.get("station")
  if (station) await stations.open(station)
  // Handles for proofs and the dev console: the stations, the Details panel (knobs over the settings) and the workbench.
  Object.assign(window, { stations, labPanel: api.panel, labWorkbench: api.workbench })
  return stations
}

async function fetchChanges(token: string, station: LabStation): Promise<StationChanges | null> {
  const q = new URLSearchParams()
  if (station.paths?.length) q.set("paths", station.paths.join(","))
  if (station.branches?.length) q.set("branches", station.branches.join(","))
  if (!q.size) return null
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
