import { Vector3, type Camera, type Object3D } from "three/webgpu"
import { isEditableEventTarget } from "@arcade/kit/client/controls"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import type { Flow } from "../../game/flow"
import type { InteractiveWorld } from "./world"
import type { Terminal } from "./terminal"

export type TerminalAnchor = { terminal: Terminal; glass: Object3D }

export function installInteractionInput(options: {
  world: InteractiveWorld
  flow: Flow
  camera: Camera
  player: { inputEnabled: boolean }
  terminals: TerminalAnchor[]
  hud: HTMLElement
  signal: AbortSignal
}) {
  const { world, flow, camera, player, terminals, signal } = options
  const prompt = document.createElement("div")
  prompt.className = "door-prompt akc-minimal"
  prompt.style.cssText = "position:absolute;left:50%;top:62%;transform:translateX(-50%);pointer-events:none"
  options.hud.append(prompt)
  const eye = new Vector3(), at = new Vector3()
  let focused = false
  const activeTerminal = () => terminals.find(t => t.terminal.active)
  const release = () => {
    for (const t of terminals) t.terminal.leave()
    if (focused) player.inputEnabled = flow.playerActive
    focused = false
  }
  const focus = () => {
    if (activeTerminal()) { player.inputEnabled = false; focused = true }
    else if (focused) release()
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || isEditableEventTarget(event.target) || !flow.playerActive) return
    const terminal = activeTerminal()
    if (terminal) {
      // Escape retains the shell's pause semantics; Backspace/Q navigate and disconnect without pausing.
      if (event.code === "Escape") { release(); return }
      terminal.terminal.key(event.code)
      event.preventDefault(); event.stopImmediatePropagation(); focus()
    } else if (event.code === "KeyE") {
      const target = world.target(camera)
      if (!target) return
      event.preventDefault(); event.stopImmediatePropagation()
      target.use(); focus()
    }
  }
  const mousemove = (event: MouseEvent) => { if (activeTerminal()) event.stopImmediatePropagation() }
  const hidden = () => { if (document.hidden) release() }
  window.addEventListener("keydown", keydown, { capture: true, signal })
  window.addEventListener("mousemove", mousemove, { capture: true, signal })
  window.addEventListener("blur", release, { signal })
  document.addEventListener("visibilitychange", hidden, { signal })
  const stop = flow.onUpdate(dt => {
    world.update(dt)
    const terminal = activeTerminal()
    if (!flow.playerActive) release()
    else if (terminal) {
      camera.getWorldPosition(eye); terminal.glass.getWorldPosition(at)
      if (!terminal.terminal.services.powered() || eye.distanceTo(at) > 2.4) release()
    }
    focus()
    const target = flow.playerActive && !activeTerminal() ? world.target(camera) : null
    prompt.innerHTML = target ? keyPromptHtml("KeyE", target.label()) : ""
  })
  const offPause = flow.onPause(paused => { if (paused) { release(); prompt.innerHTML = "" } })
  const dispose = () => {
    stop(); offPause(); release(); prompt.remove()
    window.removeEventListener("keydown", keydown, true)
    window.removeEventListener("mousemove", mousemove, true)
    window.removeEventListener("blur", release)
    document.removeEventListener("visibilitychange", hidden)
    signal.removeEventListener("abort", dispose)
  }
  signal.addEventListener("abort", dispose, { once: true })
  if (signal.aborted) dispose()
  return dispose
}
