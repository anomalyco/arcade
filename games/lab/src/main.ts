import { mat4 } from "wgpu-matrix"
import { lab } from "@arcade/kit/lab/main"
import type { SectionFactory } from "@arcade/kit/lab/types"
import type { SpawnFactory } from "@arcade/kit/lab/spawn-types"
import { ALL_GAMES, LAB_GAMES, loadPlayground, resolveGames, type LabGameModule } from "./games/registry"
import { startStations } from "./station-host"
import { SceneAudio } from "./sound/scene-audio"
import { audioSection, bindMuteKey, sceneView, withSound } from "./sound/lab-sound"
import { mountSpeaker } from "./sound/speaker"
import "./style.css"

const params = new URLSearchParams(location.search)
const bench = params.has("bench")
const resolved = resolveGames(location.search, location.hash)
const { choice, games } = resolved
const entry = LAB_GAMES.find(game => game.id === choice)
if (entry?.defaultSection && !location.hash && !params.has("section") && !params.has("station") && !bench) {
  params.set("section", entry.defaultSection)
  history.replaceState(null, "", `${location.pathname}?${params}`)
}

let storage: Storage | null = null
try { storage = localStorage } catch { /* Private mode keeps the mix for this page only. */ }
const sound = new SceneAudio({ storage, automated: navigator.webdriver, baseUrl: new URL("./audio-assets/", document.baseURI).href })
// Bench automation stays silent unless a proof opts in with ?sound.
if (!bench || params.has("sound")) sound.arm()
let mode: () => "edit" | "play" | undefined = () => undefined
bindMuteKey(sound, () => mode())
Object.assign(window, { labSound: { telemetry: () => sound.telemetry(), set: sound.set.bind(sound), toggleMute: sound.toggleMute.bind(sound) } })

function gamePicker(slot: HTMLElement) {
  const select = document.createElement("select")
  select.className = "lab-select lab-game"
  select.dataset.control = "game"
  select.setAttribute("aria-label", "Game")
  select.title = "Which game's adapters the Lab loads"
  select.add(new Option("All games", ALL_GAMES))
  for (const game of LAB_GAMES) select.add(new Option(game.label, game.id))
  select.value = choice
  select.addEventListener("change", () => {
    const next = new URLSearchParams()
    if (select.value !== ALL_GAMES) next.set("game", select.value)
    location.assign(`${location.pathname}${next.size ? `?${next}` : ""}`)
  })
  slot.append(select)
}

async function start() {
  const modules = await Promise.all(games.map(async game => ({ game, module: (await game.load()).default })))
  const wantsPlayground = modules.some(({ game, module }) => game.id === "getaway" || module.characters)
  const { getawaySpawn: playground, getawayLabAudio } = wantsPlayground ? await loadPlayground() : {}
  if (getawayLabAudio) sound.add(getawayLabAudio())
  for (const { module } of modules) if (module.audio) sound.add(module.audio())
  const sections: SectionFactory[] = [...modules.flatMap(({ module }) => module.sections), audioSection(sound)]
  const spawn: SpawnFactory | undefined = playground && (context => {
    const base = playground(context)
    const characters = [...base.characters, ...modules.flatMap(({ module }) => module.characters?.(context) ?? [])]
    return { ...base, characters: characters.map(character => withSound(character, sound)) }
  })
  const api = await lab({
    brand: "",
    toolbar: slot => { gamePicker(slot); mountSpeaker(slot, sound) },
    onEvent: event => sound.event(event),
    sections,
    spawn,
    materials: modules.flatMap(({ module }) => module.materials),
    camera: (width, height, vp, inverse, eye, focus) => {
      eye.set([focus[0], focus[1] + 22, focus[2] + 23])
      mat4.multiply(mat4.perspective(0.65, width / height, 0.1, 150), mat4.lookAt(eye, focus, [0, 1, 0]), vp)
      mat4.inverse(vp, inverse)
    },
  })
  mode = () => api.workbench.getMode()
  // A station whose section belongs to a game that isn't loaded fetches that game's adapters when it opens.
  const loaded = new Map<string, Promise<boolean>>(modules.map(({ game }) => [game.id, Promise.resolve(true)]))
  const ensureGame = (id: string) => {
    let pending = loaded.get(id)
    if (!pending) {
      const game = LAB_GAMES.find(g => g.id === id)
      pending = game
        ? game.load().then(({ default: module }: { default: LabGameModule }) => {
          api.addSections(module.sections)
          if (module.audio) sound.add(module.audio())
          return true
        })
        : Promise.resolve(false)
      loaded.set(id, pending)
      pending.catch(() => loaded.delete(id))
    }
    return pending
  }
  if (!bench) await startStations(api, ensureGame)
  let last = 0
  const tick = (now: number) => {
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0
    last = now
    if (!document.hidden) sound.update(sceneView(api), dt)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return api
}

start().catch(error => {
  const notice = document.createElement("p")
  notice.dataset.labNotice = ""
  notice.className = "lab-notice"
  if (error instanceof Error && error.message === "WebGPU unavailable") notice.textContent = "The Lab needs WebGPU. Open it in a recent Chrome, Edge or Safari."
  else { console.error(error); notice.textContent = String(error) }
  document.body.replaceChildren(notice)
})
