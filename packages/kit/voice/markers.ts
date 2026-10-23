import type { VoiceChat } from "./client"
import type { VoicePoint } from "./spatial"

/** A small speaking glyph at a visible friend's head. Callers filter visibility, so this never reveals a hidden player. */
export class VoiceMarkers {
  private readonly root: HTMLDivElement
  private readonly markers = new Map<string, HTMLSpanElement>()
  constructor(parent = document.body) {
    this.root = document.createElement("div")
    Object.assign(this.root.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "10", overflow: "hidden" })
    parent.append(this.root)
  }
  update(voice: VoiceChat, points: readonly { id: string; point: VoicePoint }[], matrix: ArrayLike<number>, visible: boolean): void {
    this.root.hidden = !visible || !voice.enabled
    const shown = new Set<string>()
    if (this.root.hidden) return
    for (const { id, point: p } of points) {
      if (!voice.speaking(id)) continue
      const x = matrix[0]! * p.x + matrix[4]! * p.y + matrix[8]! * p.z + matrix[12]!
      const y = matrix[1]! * p.x + matrix[5]! * p.y + matrix[9]! * p.z + matrix[13]!
      const w = matrix[3]! * p.x + matrix[7]! * p.y + matrix[11]! * p.z + matrix[15]!
      if (w <= 0 || Math.abs(x / w) > 1 || Math.abs(y / w) > 1) continue
      let marker = this.markers.get(id)
      if (!marker) {
        marker = document.createElement("span")
        marker.setAttribute("aria-label", "Speaking")
        marker.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 7v4m4-7v10m4-12v14m4-9v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
        Object.assign(marker.style, { position: "absolute", color: "#f2c96b", filter: "drop-shadow(0 1px 2px #000)", transform: "translate(-50%,-100%)" })
        this.root.append(marker); this.markers.set(id, marker)
      }
      marker.hidden = false
      marker.style.left = `${(x / w + 1) * 50}%`; marker.style.top = `${(1 - y / w) * 50}%`
      shown.add(id)
    }
    for (const [id, marker] of this.markers) if (!shown.has(id)) { marker.remove(); this.markers.delete(id) }
  }
  dispose(): void { this.root.remove(); this.markers.clear() }
}
