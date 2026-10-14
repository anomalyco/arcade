import type { SceneAudio } from "./scene-audio"

const ICON = (muted: boolean) => `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor"/>${muted
  ? `<path d="M10.5 6l4 4M14.5 6l-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`
  : `<path d="M10.4 5.6a3.4 3.4 0 0 1 0 4.8M12.3 3.8a6 6 0 0 1 0 8.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`}</svg>`

/** Top-bar speaker: click toggles mute (also `M` in Edit mode); the slider sets master volume. Both persist. */
export function mountSpeaker(slot: HTMLElement, sound: SceneAudio) {
  const root = document.createElement("div")
  root.className = "lab-audio"
  root.innerHTML = `<button type="button" class="lab-btn lab-icon-btn" data-action="audio-mute" aria-label="Mute sound"></button><input type="range" class="lab-audio-volume" data-control="audio-volume" min="0" max="100" step="1" aria-label="Master volume">`
  const button = root.querySelector("button")!, slider = root.querySelector("input")!
  button.addEventListener("click", () => sound.toggleMute())
  slider.addEventListener("input", () => sound.set({ volume: Number(slider.value) / 100, ...(sound.mix.muted && Number(slider.value) > 0 ? { muted: false } : {}) }))
  sound.onChange(mix => {
    button.innerHTML = ICON(mix.muted)
    button.setAttribute("aria-pressed", String(mix.muted))
    button.setAttribute("aria-label", mix.muted ? "Unmute sound" : "Mute sound")
    button.title = `${mix.muted ? "Unmute" : "Mute"} (M) · sound starts after your first click or key`
    slider.value = String(Math.round(mix.volume * 100))
    slider.title = `Master volume ${slider.value}%`
    root.dataset.muted = String(mix.muted)
  })
  slot.append(root)
}
