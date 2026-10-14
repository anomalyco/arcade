import { mat4 } from "wgpu-matrix"
import { lab } from "@arcade/kit/lab/main"
import { createAudioLab } from "@arcade/kit/audio/lab"
import type { SectionFactory } from "@arcade/kit/lab/types"
import type { SpawnFactory } from "@arcade/kit/lab/spawn-types"
import { ALL_GAMES, LAB_GAMES, loadPlayground, resolveGames } from "./games/registry"
import "./style.css"

const { choice, games } = resolveGames(location.search, location.hash)
const params = new URLSearchParams(location.search)
const entry = LAB_GAMES.find(game => game.id === choice)
if (entry?.defaultSection && !location.hash && !params.has("section") && !params.has("bench")) {
  params.set("section", entry.defaultSection)
  history.replaceState(null, "", `${location.pathname}?${params}`)
}

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
  const playground = wantsPlayground ? (await loadPlayground()).getawaySpawn : undefined
  const sections: SectionFactory[] = [...modules.flatMap(({ module }) => module.sections), createAudioLab]
  const spawn: SpawnFactory | undefined = playground && (context => {
    const base = playground(context)
    return { ...base, characters: [...base.characters, ...modules.flatMap(({ module }) => module.characters?.(context) ?? [])] }
  })
  return lab({
    brand: "",
    toolbar: gamePicker,
    sections,
    spawn,
    materials: modules.flatMap(({ module }) => module.materials),
    camera: (width, height, vp, inverse, eye, focus) => {
      eye.set([focus[0], focus[1] + 22, focus[2] + 23])
      mat4.multiply(mat4.perspective(0.65, width / height, 0.1, 150), mat4.lookAt(eye, focus, [0, 1, 0]), vp)
      mat4.inverse(vp, inverse)
    },
  })
}

start().catch(error => {
  console.error(error)
  document.body.textContent = String(error)
})
