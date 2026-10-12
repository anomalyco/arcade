/** Follow camera. The view is centred on a world point, with a pixels-per-metre scale that fits the window height. */
export class Camera {
  x = 0
  y = 0
  ppm = 30
  private snapped = false

  snap(x: number, y: number): void {
    this.x = x
    this.y = y
    this.snapped = true
  }

  follow(x: number, y: number, dt: number): void {
    if (!this.snapped) return this.snap(x, y)
    const k = 1 - Math.exp(-dt * 9)
    this.x += (x - this.x) * k
    this.y += (y - this.y) * k
  }

  /** Local play zooms so about 34 m of height is visible. Spectators see the whole map. */
  fit(width: number, height: number, mapW: number, mapH: number, spectator: boolean): void {
    this.ppm = spectator ? Math.max(8, Math.min(width / mapW, height / mapH) * 0.92) : Math.max(14, Math.min(60, height / 34))
  }

  toWorld(px: number, py: number, width: number, height: number): { x: number; y: number } {
    return { x: this.x + ((px - width / 2) / this.ppm), y: this.y + ((py - height / 2) / this.ppm) }
  }
}
