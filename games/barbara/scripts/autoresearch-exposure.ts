/** Real scene-meter latency and adaptation after 0 → 4 → 0 torches, at the fixed four-light pose. */
export async function exposureProbe() {
  const w = (window as any).woods, f = w.view.forest, device: GPUDevice = f.renderer.passContext.device
  w.camera.flashlight = true
  for (const b of w.state.brains) {
    const p = w.state.players.find((p: any) => p.id === b.id)
    p.light = true; p.yaw = b.heading; p.pitch = -0.2
  }
  w.state.players[0].light = true
  w.state.players[0].yaw = w.camera.yaw; w.state.players[0].pitch = w.camera.pitch
  f.camera.stops = 0; f.camera.exposure = 1
  const trace: { lights: number; seconds: number; stops: number; exposure: number; centre: number; logMean: number }[] = []
  let maxFrameStep = 0, previous = 0
  for (const [lights, seconds] of [[0, 16], [4, 8], [0, 24]]) {
    w.debug.dark = lights ? [] : w.state.players.map((p: any) => p.id)
    for (let i = 0; i < seconds! * 60; i++) {
      w.__putTime(12); w.step(1000 / 60)
      await device.queue.onSubmittedWorkDone()
      if (i % 8 === 7) await new Promise(r => setTimeout(r, 0))
      maxFrameStep = Math.max(maxFrameStep, Math.abs(f.camera.stops - previous)); previous = f.camera.stops
      if (i % 15 === 14) trace.push({ lights: lights!, seconds: (i + 1) / 60, stops: previous, exposure: f.settings.exposure * 2 ** previous, centre: f.renderer.sceneMeter?.centre ?? 0, logMean: f.renderer.sceneMeter?.logMean ?? 0 })
    }
  }
  return { trace, maxFrameStep }
}
