// Edge blur for the DOM's selection pills (--k-motion-blur, off at 0). A pill glides on CSS
// transitions of its edges, so its speed is sampled from layout each frame while one runs; it
// widens by its smear and its ends fade over that width, which is what a horizontal box blur (the
// GPU's) does to a shape's sides. Nothing runs while it rests, and a pan (which the fingers move,
// with no transition) doesn't smear, as on the GPU.

/** Smears `pill` by its speed while it glides: `cap` is the widest smear (px), as on the GPU. */
export function smearPill(pill: HTMLElement, cap: number) {
  let frame = 0
  let lastX = 0
  let lastAt = 0
  let smear = 0
  let strength = 0
  const set = (px: number) => {
    const next = px < 0.25 ? 0 : px
    if (next === smear) return
    smear = next
    pill.classList.toggle("knobs-smear-pill", next > 0)
    pill.style.setProperty("--k-smear", next.toFixed(2))
  }
  const centre = () => pill.offsetLeft + pill.offsetWidth / 2
  const run = (now: number) => {
    const x = centre()
    const dt = (now - lastAt) / 1000
    const speed = dt > 0 ? Math.abs(x - lastX) / dt : 0
    lastX = x
    lastAt = now
    const gliding = pill.getAnimations().length > 0
    set(gliding ? Math.min(cap, speed * 0.006 * strength) : 0)
    frame = gliding || smear > 0 ? requestAnimationFrame(run) : 0
  }
  pill.addEventListener("transitionrun", () => {
    if (frame || pill.closest('[data-gpu-active="true"]')) return
    const win = pill.ownerDocument.defaultView
    strength = Math.min(
      1,
      Math.max(0, parseFloat(getComputedStyle(pill).getPropertyValue("--k-motion-blur")) || 0),
    )
    if (strength <= 0 || win?.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    lastX = centre()
    lastAt = performance.now()
    frame = requestAnimationFrame(run)
  })
}
