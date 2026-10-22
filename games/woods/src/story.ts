import { VOICE_LINES } from "../shared/lines.gen"
import { BOT_ID, type WoodsState } from "../shared/sim"
import { CAST_NAMES, openingLines, voiceRoles, type VoiceEvent } from "../shared/voices"
import { terrainHeight, type WoodsWorld } from "../shared/world"
import type { voiceHeard, WoodsAudio } from "./audio"

const NIGHTS_KEY = "woods.nights"
const SUBTITLES_KEY = "woods.subtitles"
/** A line quieter than this where you stand (momentary-max LUFS) is only a sound, not words: no subtitle. */
const SUBTITLE_FLOOR = -54

/**
 * The search's story on screen (STORY.md): the trailhead opening at your first step out (Walt, then searchers calling
 * for Barbara around and ahead of you), the FIND BARBARA card, and subtitles as each searcher's line reaches you. None
 * of it holds you still. Later nights in the same browser get a shorter opening and card.
 */
export class StoryHud {
  /** The opening's lines still to come, in sim time. */
  private opening: VoiceEvent[] = []
  private begun = false
  private time = 0
  private cardAt = Infinity
  private cardUntil = 0
  private subs: { el: HTMLElement; until: number }[] = []
  night = 0

  constructor(private readonly audio: WoodsAudio, private readonly objective = document.getElementById("objective")!, private readonly subsEl = document.getElementById("subs")!) {
    audio.voice.subtitles = localStorage.getItem(SUBTITLES_KEY) !== "0"
    audio.onLine = (e, heard) => this.subtitle(e, heard)
  }

  get subtitles() {
    return this.audio.voice.subtitles
  }
  set subtitles(on: boolean) {
    this.audio.voice.subtitles = on
    localStorage.setItem(SUBTITLES_KEY, on ? "1" : "0")
    if (!on) for (const s of this.subs.splice(0)) s.el.remove()
  }

  /** Your first step out: the opening plays around where you stand, facing `yaw`. Once per page. */
  begin(world: WoodsWorld, state: WoodsState, me: number, x: number, z: number, yaw: number): void {
    if (this.begun) return
    this.begun = true
    this.night = (Number(localStorage.getItem(NIGHTS_KEY)) || 0) + 1
    localStorage.setItem(NIGHTS_KEY, String(this.night))
    const cast = voiceRoles(state.players, BOT_ID).byWalker.get(me) ?? null
    this.opening = openingLines(world, { x, z, fx: -Math.sin(yaw), fz: -Math.cos(yaw) }, cast, this.night, world.params.seed).map((e) => ({ ...e, at: e.at + state.t }))
    const first = this.night <= 1
    this.objective.querySelector(".kicker")!.textContent = first ? "Barbara K. Nakamura · missing since Thursday" : ""
    this.objective.querySelector(".task")!.textContent = "FIND BARBARA"
    this.cardAt = this.time + (first ? 5 : 1.5)
    this.cardUntil = this.cardAt + (first ? 5.5 : 2.8)
  }

  /** Once per frame, before `audio.frame`: the opening's lines that are due go to the audio as the room's would. */
  frame(dt: number, state: WoodsState, world: WoodsWorld): void {
    this.time += dt
    if (this.opening.length && this.opening[0]!.at <= state.t) {
      // A searcher someone walks as (a bot or a friend) calls from where they are; the rest are out in the woods.
      const roles = voiceRoles(state.players, BOT_ID).byWalker
      while (this.opening.length && this.opening[0]!.at <= state.t) {
        const e = this.opening.shift()!
        const w = state.players.find((p) => roles.get(p.id) === e.cast)
        this.audio.event(w ? { ...e, by: w.id, x: w.x, y: terrainHeight(world.terrain, w.x, w.z) + 1.6, z: w.z } : e)
      }
    }
    this.objective.classList.toggle("on", this.time >= this.cardAt && this.time < this.cardUntil)
    for (let i = this.subs.length - 1; i >= 0; i--) {
      const s = this.subs[i]!
      if (this.time > s.until) s.el.style.opacity = "0"
      if (this.time > s.until + 0.6) { s.el.remove(); this.subs.splice(i, 1) }
    }
  }

  private subtitle(e: VoiceEvent, heard: ReturnType<typeof voiceHeard>): void {
    if (!this.audio.voice.subtitles || heard.lufs < SUBTITLE_FLOOR) return
    const line = VOICE_LINES.find((l) => l.id === e.line)
    if (!line) return
    const el = document.createElement("div")
    const who = document.createElement("b")
    who.textContent = CAST_NAMES[e.cast]
    el.append(who, line.text)
    if (heard.distance > 70) el.className = "far"
    el.style.opacity = String(Math.max(0.5, Math.min(1, (heard.lufs - SUBTITLE_FLOOR) / 18 + 0.5)))
    this.subsEl.append(el)
    this.subs.push({ el, until: this.time + line.seconds + 1.4 })
    while (this.subs.length > 2) this.subs.shift()!.el.remove()
  }
}
