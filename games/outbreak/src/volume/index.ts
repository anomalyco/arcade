import "./volume.css"

const SPEAKER = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 9h4l5-4v14l-5-4H4z"/><path class="vm-wave" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10"/><path class="vm-cross" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9l5 6M21 9l-5 6"/></svg>`

/**
 * The speaker button in the top-right corner (playtest, Oct 20: "I need to have a volume button too"). It opens the
 * game shell's Settings (volume, mute, quality); closing them plays on. By default M is the map, so this and the
 * Escape menu are how a player reaches sound.
 */
export function soundButton(open: () => void, doc: Document = document): { sync(muted: boolean): void } {
  const root = doc.createElement("div")
  root.className = "vm"
  root.innerHTML = `<button type="button" class="vm-button" aria-label="Sound and settings" title="Sound and settings">${SPEAKER}</button>`
  doc.body.append(root)
  const button = root.querySelector("button")!
  button.addEventListener("click", () => {
    button.blur()
    open()
  })
  return { sync: (muted) => void (root.dataset.muted = String(muted)) }
}
