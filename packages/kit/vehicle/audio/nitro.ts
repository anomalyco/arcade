/** One ignition per held-control press. Fuel exhaustion latches off until release. */
export class NitroGate {
  active = false
  ignited = false
  released = false
  private armed = true
  private hold = 0
  private upTime = 0

  update(held: boolean, fuel: number, dt: number, available = true, remote = false) {
    const was = this.active
    this.ignited = false
    this.upTime = held ? 0 : this.upTime + Math.max(0, dt)
    // Local control edges are exact; remote snapshot edges need a stable release.
    if (!held && (!remote || this.upTime >= 0.1)) this.armed = true
    if (!available || fuel <= 0.005) {
      this.active = false
      this.hold = 0
      if (held) this.armed = false
    } else if (held) {
      if (this.armed) { this.active = true; this.ignited = true; this.armed = false }
      this.hold = 0.1
    } else if (this.active) {
      this.hold -= Math.max(0, dt)
      if (this.hold <= 1e-6) this.active = false
    }
    this.released = was && !this.active
    return this.active
  }

  /** Lifecycle interruption requires a fresh release/press, never a synthetic ignition. */
  cancel() {
    this.active = this.ignited = this.released = this.armed = false
    this.hold = this.upTime = 0
  }
}
