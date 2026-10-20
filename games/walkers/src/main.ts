import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { LabPanel, type LabControl, type LabValue } from "@arcade/kit/lab-panel"
import { CREATURE_IDS, CREATURES, type CreatureId } from "../shared/creatures"
import { DEFAULT_REWARD, Episode, type RewardSettings } from "../shared/episode"
import { DEFAULT_ES } from "../shared/es"
import { TASK_IDS, TASKS, type TaskId } from "../shared/tasks"
import { parsePolicy, type SavedPolicy, type TrainerOptions } from "../shared/trainer"
import { Chart } from "./chart"
import { RemoteTrainer } from "./remote-trainer"
import { generationShow, policyRunner, Show, type Runner } from "./show"
import { View } from "./view"

const PRETRAINED = import.meta.glob<unknown>("./pretrained/*.json", { eager: true, import: "default" })
const pretrainedFor = (creature: CreatureId, task: TaskId): SavedPolicy | null => parsePolicy(PRETRAINED[`./pretrained/${creature}-${task}.json`])
const storageKey = (creature: CreatureId, task: TaskId) => `walkers.policy.${creature}.${task}`

const params = new URLSearchParams(location.search)
const cores = navigator.hardwareConcurrency || 4
const pick = <T extends string>(value: string | null, options: readonly T[], fallback: T): T => (options.includes(value as T) ? (value as T) : fallback)
const num = (key: string, fallback: number) => (params.has(key) && Number.isFinite(Number(params.get(key))) ? Number(params.get(key)) : fallback)

const S = {
  creature: pick(params.get("creature"), CREATURE_IDS, "biped") as string,
  task: pick(params.get("task"), TASK_IDS, "room") as string,
  speed: num("speed", 2),
  ghosts: num("ghosts", 24),
  watchEvery: false,
  compare: params.get("compare") !== "0",
  pairs: DEFAULT_ES.pairs,
  sigma: DEFAULT_ES.sigma,
  lr: DEFAULT_ES.lr,
  hidden: 16,
  workers: num("workers", Math.max(1, Math.min(8, cores - 2))),
  // Seed 7: the biped finds its run in ~750 generations (seed 6 gets stuck standing still; ES is that seed-sensitive).
  seed: num("seed", 7),
  seconds: DEFAULT_REWARD.seconds,
  upright: DEFAULT_REWARD.upright,
  effort: DEFAULT_REWARD.effort,
  fall: DEFAULT_REWARD.fall,
  finish: DEFAULT_REWARD.finish,
  phase: DEFAULT_REWARD.phase,
}

const creature = () => S.creature as CreatureId
const task = () => S.task as TaskId
const reward = (): RewardSettings => ({ seconds: S.seconds, progress: 1, upright: S.upright, effort: S.effort, fall: S.fall, finish: S.finish, phase: S.phase })

const canvas = document.getElementById("view") as HTMLCanvasElement
const view = new View(canvas)
const chart = new Chart(document.getElementById("chart") as HTMLCanvasElement)
const stats = document.getElementById("stats")!
const toast = document.getElementById("toast")!
const trainer = new RemoteTrainer(trainerOptions(), S.workers)
let running = false
let mode: "train" | "replay" = "train"
let show: Show | null = null
let replayPolicy: SavedPolicy | null = null
let shownGen = -1
let trainedMs = 0
let lastGenAt = 0
let genRate = 0
let replayCheck = ""

function trainerOptions(init?: SavedPolicy): TrainerOptions {
  return {
    creature: creature(),
    task: task(),
    hidden: init?.hidden ?? S.hidden,
    seed: S.seed,
    es: { pairs: S.pairs, sigma: S.sigma, lr: S.lr, weightDecay: DEFAULT_ES.weightDecay },
    reward: reward(),
    init: init ? Float64Array.from(init.params) : undefined,
  }
}

function flash(text: string): void {
  toast.textContent = text
  toast.dataset.on = "1"
  clearTimeout((flash as { t?: number }).t)
  ;(flash as { t?: number }).t = window.setTimeout(() => delete toast.dataset.on, 2200)
}

trainer.onGeneration = () => {
  const now = performance.now()
  if (lastGenAt) {
    const dt = now - lastGenAt
    trainedMs += Math.min(dt, 2000)
    genRate = genRate ? genRate * 0.9 + 0.1 * (1000 / dt) : 1000 / dt
  }
  lastGenAt = now
}
trainer.onError = (message) => {
  running = false
  flash(`Training stopped: ${message}`)
  syncButtons()
}

function setRunning(on: boolean): void {
  running = on
  if (on && mode === "replay") enterTrain()
  trainer.run(on)
  lastGenAt = 0
  syncButtons()
}

function reset(init?: SavedPolicy): void {
  trainer.reset(trainerOptions(init))
  trainedMs = 0
  genRate = 0
  lastGenAt = 0
  shownGen = -1
  if (mode === "train") show = nextShow()
  syncButtons()
}

function pretrainedRunner(): Runner | null {
  if (!S.compare) return null
  const p = pretrainedFor(creature(), task())
  return p ? policyRunner(p, "pretrained", "pre-trained", reward()) : null
}

function nextShow(): Show | null {
  if (mode === "replay") {
    const runners: Runner[] = []
    const pre = pretrainedRunner()
    if (replayPolicy) runners.push(policyRunner(replayPolicy, replayPolicy === pretrainedFor(creature(), task()) ? "pretrained" : "saved", replayLabel(replayPolicy), reward()))
    if (pre && replayPolicy !== pretrainedFor(creature(), task())) runners.unshift(pre)
    return runners.length ? new Show("replay", runners, replayPolicy?.generation ?? 0) : null
  }
  const extra: Runner[] = []
  const pre = pretrainedRunner()
  if (pre) extra.push(pre)
  const g = generationShow(trainer, S.ghosts, extra)
  if (g) {
    shownGen = g.gen
    return g
  }
  // Before the first generation: the creature standing still, so there's something to look at.
  const ep = new Episode(creature(), task(), null, reward())
  return new Show("generation", [...extra, { ep, role: "best", label: "waiting for generation 0", expected: null }], -1)
}

function replayLabel(p: SavedPolicy): string {
  if (p === pretrainedFor(p.creature, p.task)) return "pre-trained"
  return `best · gen ${p.generation}`
}

function enterReplay(policy: SavedPolicy | null): void {
  if (!policy) {
    flash("Nothing to replay yet: train for a few generations first.")
    return
  }
  if (policy.creature !== creature() || policy.task !== task()) {
    S.creature = policy.creature
    S.task = policy.task
    panel.sync()
    reset()
  }
  running = false
  mode = "replay"
  replayPolicy = policy
  replayCheck = ""
  show = nextShow()
  syncButtons()
}

function enterTrain(): void {
  mode = "train"
  replayPolicy = null
  show = nextShow()
  syncButtons()
}

function saveBest(): void {
  const best = trainer.best
  if (!best) return flash("Nothing to save yet.")
  localStorage.setItem(storageKey(best.creature, best.task), JSON.stringify(best))
  flash(`Saved ${CREATURES[best.creature].label} on ${TASKS[best.task].label}: fitness ${best.fitness.toFixed(2)}.`)
}

function loadSaved(): void {
  const raw = localStorage.getItem(storageKey(creature(), task()))
  const p = raw ? parsePolicy(JSON.parse(raw)) : null
  if (!p) return flash(`No saved ${CREATURES[creature()].label} for ${TASKS[task()].label}.`)
  enterReplay(p)
}

function download(): void {
  const best = mode === "replay" && replayPolicy ? replayPolicy : trainer.best
  if (!best) return flash("Nothing to download yet.")
  const url = URL.createObjectURL(new Blob([JSON.stringify(best, null, 1)], { type: "application/json" }))
  const a = document.createElement("a")
  a.href = url
  a.download = `${best.creature}-${best.task}-gen${best.generation}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function importFile(): void {
  const input = document.createElement("input")
  input.type = "file"
  input.accept = "application/json,.json"
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      const p = parsePolicy(JSON.parse(await file.text()))
      if (!p) return flash("That file isn't a walkers policy.")
      enterReplay(p)
    } catch {
      flash("Couldn't read that file.")
    }
  }
  input.click()
}

const options = <T extends string>(ids: readonly T[], label: (id: T) => string) => ids.map((value) => ({ value, label: label(value) }))
const controls: LabControl[] = [
  { key: "creature", label: "Creature", group: "Run", type: "select", options: options(CREATURE_IDS, (id) => CREATURES[id].label) },
  { key: "task", label: "Task", group: "Run", type: "select", options: options(TASK_IDS, (id) => TASKS[id].label) },
  { key: "train", label: "Train / pause", group: "Run", type: "action", run: () => setRunning(!running) },
  { key: "reset", label: "Reset (new random brain)", group: "Run", type: "action", run: () => reset() },
  { key: "replay", label: "Replay best", group: "Run", type: "action", run: () => enterReplay(trainer.best) },
  { key: "pretrained", label: "Watch pre-trained", group: "Run", type: "action", run: () => enterReplay(pretrainedFor(creature(), task())) },
  { key: "continue", label: "Train on from pre-trained", group: "Run", type: "action", run: () => { const p = pretrainedFor(creature(), task()); if (!p) return flash("No pre-trained policy here."); mode = "train"; reset(p); setRunning(true) } },
  { key: "save", label: "Save best (this browser)", group: "Policy", type: "action", run: saveBest },
  { key: "load", label: "Load saved", group: "Policy", type: "action", run: loadSaved },
  { key: "download", label: "Download JSON", group: "Policy", type: "action", run: download },
  { key: "import", label: "Open JSON…", group: "Policy", type: "action", run: importFile },
  { key: "speed", label: "Playback speed", group: "View", min: 0.25, max: 16, step: 0.25, unit: "×" },
  { key: "ghosts", label: "Ghosts shown", group: "View", min: 0, max: 64, step: 1 },
  { key: "watchEvery", label: "Watch every generation", group: "View", type: "toggle" },
  { key: "compare", label: "Show pre-trained (gold)", group: "View", type: "toggle" },
  { key: "pairs", label: "Population pairs", group: "Evolution", min: 4, max: 128, step: 1 },
  { key: "sigma", label: "Noise σ", group: "Evolution", min: 0.005, max: 0.3, step: 0.005 },
  { key: "lr", label: "Learning rate", group: "Evolution", min: 0.002, max: 0.15, step: 0.002 },
  { key: "hidden", label: "Hidden neurons (resets)", group: "Evolution", min: 2, max: 64, step: 1 },
  { key: "seed", label: "Seed (resets)", group: "Evolution", min: 1, max: 999, step: 1 },
  { key: "workers", label: "Workers", group: "Evolution", min: 1, max: Math.max(2, cores), step: 1 },
  { key: "seconds", label: "Episode length", group: "Reward", min: 4, max: 30, step: 1, unit: "s" },
  { key: "upright", label: "Upright bonus", group: "Reward", min: 0, max: 1, step: 0.01, unit: "/s" },
  { key: "effort", label: "Effort penalty", group: "Reward", min: 0, max: 0.5, step: 0.01, unit: "/s" },
  { key: "fall", label: "Fall penalty", group: "Reward", min: 0, max: 5, step: 0.1 },
  { key: "finish", label: "Finish bonus", group: "Reward", min: 0, max: 2, step: 0.05, unit: "/s left" },
  { key: "phase", label: "Clock period", group: "Reward", min: 0.3, max: 2, step: 0.05, unit: "s" },
]

const panel = new LabPanel(S as unknown as Record<string, LabValue>, controls, params, () => {}, {
  open: params.get("panel") !== "0",
  capture: "focus",
  presets: false,
  variants: false,
  onTransaction: (_, before, after) => {
    for (const key of Object.keys(after)) if (before[key] !== after[key]) changed(key)
  },
})
panel.header.textContent = "Evolution strategies · Backquote hides"

function changed(key: string): void {
  if (key === "creature" || key === "task" || key === "hidden" || key === "seed") {
    if (mode === "replay") mode = "train"
    replayPolicy = null
    reset()
  } else if (key === "pairs" || key === "sigma" || key === "lr") {
    trainer.setEs({ pairs: S.pairs, sigma: S.sigma, lr: S.lr, weightDecay: DEFAULT_ES.weightDecay })
  } else if (key === "workers") trainer.setWorkers(S.workers)
  else if (["seconds", "upright", "effort", "fall", "finish", "phase"].includes(key)) trainer.setReward(reward())
  else if (key === "compare" || key === "ghosts") show = nextShow()
  else if (key === "watchEvery") trainer.hold(S.watchEvery)
  syncButtons()
}

// HUD buttons and pickers.
const hud = document.getElementById("hud")!
const buttons = document.getElementById("buttons")!
const creatures = document.getElementById("creatures")!
const tasks = document.getElementById("tasks")!
buttons.innerHTML = [
  `<button data-act="train"></button>`,
  `<button data-act="reset">Reset ${keyCapHtml("KeyR")}</button>`,
  `<button data-act="replay">Replay best ${keyCapHtml("KeyB")}</button>`,
  `<button data-act="pretrained">Pre-trained ${keyCapHtml("KeyP")}</button>`,
].join("")
creatures.innerHTML = CREATURE_IDS.map((id) => `<button data-creature="${id}" title="${CREATURES[id].blurb}">${CREATURES[id].label}</button>`).join("")
tasks.innerHTML = TASK_IDS.map((id) => `<button data-task="${id}" title="${TASKS[id].blurb}">${TASKS[id].label}</button>`).join("")
hud.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest("button")
  if (!el) return
  const act = el.dataset.act
  if (act === "train") setRunning(!(running && mode === "train"))
  else if (act === "reset") reset()
  else if (act === "replay") enterReplay(trainer.best)
  else if (act === "pretrained") enterReplay(pretrainedFor(creature(), task()))
  else if (el.dataset.creature) {
    S.creature = el.dataset.creature
    panel.sync()
    changed("creature")
    setRunning(true)
  } else if (el.dataset.task) {
    S.task = el.dataset.task
    panel.sync()
    changed("task")
    setRunning(true)
  }
  el.blur()
})

function syncButtons(): void {
  const train = buttons.querySelector<HTMLButtonElement>('[data-act="train"]')!
  const on = running && mode === "train"
  train.innerHTML = `${on ? "Pause" : mode === "replay" ? "Back to training" : trainer.history.length ? "Resume training" : "Train"} ${keyCapHtml("Space")}`
  train.dataset.on = on ? "1" : ""
  buttons.querySelector<HTMLButtonElement>('[data-act="pretrained"]')!.disabled = !pretrainedFor(creature(), task())
  for (const b of creatures.querySelectorAll<HTMLButtonElement>("button")) b.dataset.on = b.dataset.creature === S.creature ? "1" : ""
  for (const b of tasks.querySelectorAll<HTMLButtonElement>("button")) b.dataset.on = b.dataset.task === S.task ? "1" : ""
}

window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
  if ((e.target as HTMLElement).closest?.("input, textarea, [contenteditable], [data-lab-panel]")) return
  if (e.code === "Space") setRunning(!(running && mode === "train"))
  else if (e.code === "KeyR") reset()
  else if (e.code === "KeyB") enterReplay(trainer.best)
  else if (e.code === "KeyP") enterReplay(pretrainedFor(creature(), task()))
  else return
  e.preventDefault()
})

const fmtTime = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}
const fmtSteps = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n))

function renderStats(): void {
  const h = trainer.history
  const last = h[h.length - 1]
  const best = trainer.best
  const parts: string[] = []
  if (mode === "replay" && replayPolicy) {
    parts.push(`<b>Replay</b> ${replayLabel(replayPolicy)} · fitness ${replayPolicy.fitness.toFixed(2)} · ${replayPolicy.distance.toFixed(1)} m · found after ${fmtSteps(replayPolicy.steps)} sim steps${replayPolicy.trainedSeconds ? ` · headless run took ${replayPolicy.trainedSeconds} s` : ""}`)
    if (replayCheck) parts.push(replayCheck)
  } else {
    parts.push(`<b>Gen ${h.length}</b>${running ? "" : " · paused"}`)
    if (last) parts.push(`best ${best!.fitness.toFixed(2)} (${best!.distance.toFixed(1)} m)`, `mean policy ${last.centerDistance.toFixed(1)} m`, `${last.finished}/${trainer.population} reached the goal`)
    parts.push(`${fmtSteps(trainer.totalSteps)} sim steps · ${fmtTime(trainedMs)}${running && genRate ? ` · ${genRate.toFixed(1)} gen/s` : ""}`)
    parts.push(`${trainer.population} policies × ${trainer.paramSize} weights · ${trainer.workers} workers`)
  }
  stats.innerHTML = parts.map((p) => `<span>${p}</span>`).join("")
}

let lastFrame = performance.now()
let acc = 0
function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000)
  lastFrame = now
  if (show) {
    acc += dt * 60 * S.speed
    const steps = Math.floor(acc)
    acc -= steps
    show.advance(steps)
    if (show.done) {
      show.idle += dt
      if (show.kind === "replay" && !replayCheck) {
        const r = show.runners.find((x) => x.role !== "pretrained") ?? show.runners[0]
        if (r && r.expected !== null) replayCheck = Math.abs(r.ep.fitness - r.expected) < 1e-9 ? "replay matches its training score exactly ✓" : `replay scored ${r.ep.fitness.toFixed(3)} (trained ${r.expected.toFixed(3)})`
      }
      const hold = show.kind === "replay" ? 1.4 : 0.7
      if (mode === "train") trainer.requestLast()
      const fresh = mode === "train" && trainer.last && trainer.last.gen !== shownGen
      if (show.idle > hold && (mode === "replay" || fresh || (!S.watchEvery && show.idle > 3))) {
        show = nextShow()
        if (mode === "train" && S.watchEvery) trainer.go()
      }
    }
    const lead = show?.lead
    if (lead) view.follow(lead.ep.torso.x, dt)
  } else if (mode === "train") {
    trainer.requestLast()
    if (trainer.last) show = nextShow()
  }
  view.draw(task(), show)
  chart.draw(trainer.history, S.compare ? pretrainedFor(creature(), task())?.fitness ?? null : null)
  renderStats()
  requestAnimationFrame(frame)
}

view.resize()
addEventListener("resize", () => view.resize())
show = nextShow()
syncButtons()
if (params.get("autostart") !== "0") setRunning(true)
document.getElementById("app")!.dataset.ready = "1"
requestAnimationFrame(frame)
;(window as unknown as { walkers: unknown }).walkers = { settings: S, trainer: () => trainer, history: () => trainer.history, pretrainedFor }
