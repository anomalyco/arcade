import { lifeIn } from "../../shared/death/spectate"
import type { DeathState } from "../../shared/death/rules"
import { supportHeight } from "../../shared/terrain"
import type { Vision } from "../../shared/vision"
import type { OutbreakClientFrameContext } from "../feature-registry"
import { SURVIVOR_COLOURS } from "../seat-colours"
import { edgeMark, markMode } from "./edge"
import { TEAMMATE_MARKERS_TODAY, type TeammateMarkerSettings } from "./settings"
import "./teammates.css"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function seen(vision: Vision, x: number, y: number): boolean {
  const soft = (vision as Vision & { actorVisible?: (x: number, y: number) => number }).actorVisible
  return soft ? soft.call(vision, x, y) > 0.05 : vision.visible(x, y)
}

type Mark = { el: HTMLDivElement; label: HTMLSpanElement; text: string }

/**
 * Where your teammates are when you can't see them (playtest: "Where'd you guys go?"; Kit: "You can easily lose each
 * other"): a chevron at the screen edge pointing at anyone off screen, with their name and distance in their seat
 * colour, and a faint ring with their name where someone on screen is out of sight. Teammates in plain view keep only
 * their name tag. A downed teammate's mark is red; on screen nearby, the death HUD's revive marker takes over.
 */
export class TeammateMarkers {
  private readonly root: HTMLDivElement
  private readonly marks = new Map<number, Mark>()
  /** Proof readout: which seats are marked and how. */
  readonly drawn: { index: number; mode: "edge" | "ring"; down: boolean }[] = []

  constructor(doc: Document = document) {
    this.root = doc.createElement("div")
    this.root.className = "otm-marks"
    doc.body.append(this.root)
  }

  draw(ctx: OutbreakClientFrameContext): void {
    const { session, coop, cam, vision, w, h } = ctx
    const s = ctx.settings.hud as unknown as TeammateMarkerSettings
    this.drawn.length = 0
    const local = "local" in session ? session.local : session.slot
    const state = session.sim.getFeatureState<DeathState>("death")
    const on = s.teammateMarkers !== TEAMMATE_MARKERS_TODAY && session.sim.slots.length > 1 && !coop.paused
    const centre = cam.unproject(w / 2, h / 2, w, h)
    const keep = new Set<number>()
    if (on) {
      for (const slot of session.sim.slots) {
        if (slot.index === local.index) continue
        const life = lifeIn(state, slot.index)
        if (life === "dead") continue
        const p = slot.survivor
        const proj = cam.project(p.x, supportHeight(session.view.town, p.x, p.y) + 1, p.y, w, h)
        const m = edgeMark(proj.x, proj.y, w, h, s.teammateMarkerMargin, proj.ok, { x: p.x - centre.x, y: p.y - centre.y })
        const down = life === "down"
        const dist = Math.hypot(p.x - centre.x, p.y - centre.y)
        const mode = markMode({ onScreen: m.onScreen, visible: m.onScreen && seen(vision, p.x, p.y), down, dist })
        if (!mode) continue
        keep.add(slot.index)
        let mark = this.marks.get(slot.index)
        if (!mark) {
          const el = document.createElement("div")
          el.className = "otm-mark"
          el.innerHTML = `<i class="otm-chev" aria-hidden="true"></i><span class="otm-label"></span>`
          this.root.append(el)
          mark = { el, label: el.querySelector(".otm-label")!, text: "" }
          this.marks.set(slot.index, mark)
        }
        const name = coop.net ? coop.net.nameOf(slot.index) : `Survivor ${slot.index + 1}`
        const text = `${down ? "Down · " : ""}${name}${mode === "edge" ? ` · ${Math.round(dist)} m` : ""}`
        if (text !== mark.text) {
          mark.text = text
          mark.label.innerHTML = esc(text)
        }
        mark.el.dataset.mode = mode
        mark.el.dataset.down = String(down)
        mark.el.style.setProperty("--otm-colour", SURVIVOR_COLOURS[slot.index % SURVIVOR_COLOURS.length]!.css)
        mark.el.style.setProperty("--otm-angle", `${m.angle.toFixed(3)}rad`)
        mark.el.style.opacity = down ? "1" : String(s.teammateMarkerOpacity)
        mark.el.style.transform = `translate(${Math.round(m.x)}px, ${Math.round(m.y)}px)`
        this.drawn.push({ index: slot.index, mode, down })
      }
    }
    for (const [index, mark] of this.marks) {
      if (keep.has(index)) continue
      mark.el.remove()
      this.marks.delete(index)
    }
  }
}
