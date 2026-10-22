import type { ForestFrameInput, ForestView } from "../../../packages/kit/forest/view"

declare const woods: { view: { forest: ForestView }; __input: ForestFrameInput }

/** Paired removal diagnostics, never used as appearance candidates. Shadow submission is outside measure(). */
export async function profileProbe() {
  const f = woods.view.forest, renderer = f.renderer
  const look = { ...f.settings }, debug = { ...f.debug }, quality = { ...f.quality }
  const measure = renderer.measure.bind(renderer)
  const cases = ["all", "no-fog", "no-shadows", "no-ferns", "no-trees", "no-prepass", "all"]
  const rounds: { round: number; id: string; gpu: Awaited<ReturnType<ForestView["measure"]>> }[] = []
  try {
    for (let round = 0; round < 3; round++) for (const id of round % 2 ? [...cases].reverse() : cases) {
      Object.assign(f.settings, look); Object.assign(f.debug, debug); f.quality = { ...quality }
      renderer.measure = frame => measure(id === "no-fog" ? { ...frame, volume: null, fogBlur: null } : frame)
      if (id === "no-shadows") f.settings.torchShadows = "off"
      if (id === "no-ferns") f.debug.fern = false
      if (id === "no-trees") f.debug.tree = false
      if (id === "no-prepass") f.debug.prepass = false
      f.update(woods.__input)
      await f.measure(1)
      rounds.push({ round, id, gpu: await f.measure(9) })
    }
  } finally {
    renderer.measure = measure; Object.assign(f.settings, look); Object.assign(f.debug, debug); f.quality = quality
    f.update(woods.__input)
  }
  return rounds
}
