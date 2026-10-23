import type { NightState } from "../shared/night"
import { EVIDENCE, evidenceKnown, SUSPECT_LINES, SUSPECT_NAMES, SUSPECTS, type Suspect } from "../shared/verdict"
import { keyCapHtml } from "@arcade/kit/client/key-cap"

/**
 * The naming card at the radio by the tower (NIGHT.md "The verdict"): the suspects, what each is, the evidence on
 * your own map and which of it rules each one out. 1–4 names one; E or Escape puts the handset down. It doesn't free
 * the pointer: you keep looking at the woods while you decide.
 */
const STYLE = `
#verdict { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; z-index: 30; pointer-events: none; }
#verdict.on { display: flex; }
#verdict .card { width: min(46rem, 92vw); background: rgba(10,9,7,0.9); border: 1px solid #4a4334; border-radius: 10px; padding: 22px 26px; color: #efe6cc; font: 14px/1.45 system-ui, sans-serif; box-shadow: 0 10px 40px #000; }
#verdict .kicker { font: 600 11px system-ui, sans-serif; letter-spacing: 0.25em; color: #f2c96b; }
#verdict h1 { font: 400 26px Georgia, serif; letter-spacing: 0.08em; margin: 4px 0 6px; }
#verdict .seen { font: italic 13px Georgia, serif; color: #cdbf9c; margin: 0 0 12px; }
#verdict .seen div::before { content: "· "; }
#verdict .s { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; padding: 8px 0; border-top: 1px solid #2f2a20; }
#verdict .s .name { font: 600 15px system-ui, sans-serif; }
#verdict .s .what { color: #b9b19c; font-size: 13px; }
#verdict .s .out { color: #d77a6a; font-size: 12.5px; }
#verdict .s .fits { color: #9fc48a; font-size: 12.5px; }
#verdict .s.struck { opacity: 0.4; text-decoration: line-through; }
#verdict .s.mine .name::after { content: "  ← your vote"; color: #f2c96b; font-weight: 400; }
#verdict .foot { margin-top: 12px; color: #a59c86; font-size: 12.5px; }
`

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

export class VerdictCard {
  readonly el = document.createElement("div")
  private key = ""

  constructor(root: HTMLElement = document.body) {
    const style = document.createElement("style")
    style.textContent = STYLE
    document.head.append(style)
    this.el.id = "verdict"
    root.append(this.el)
  }

  get visible(): boolean {
    return this.el.classList.contains("on")
  }

  open(): void {
    this.el.classList.add("on")
  }

  close(): void {
    this.el.classList.remove("on")
  }

  /** Redraw from the night and your map (cheap when nothing changed). */
  frame(n: NightState, clues: readonly number[], me: number): void {
    if (!this.visible) return
    const mine = n.verdict.votes.find((v) => v.by === me)?.suspect ?? ""
    const key = `${n.rev}|${clues.join(",")}|${mine}`
    if (key === this.key) return
    this.key = key
    const seen = evidenceKnown(n.layout.verdict, clues).map((i) => EVIDENCE[i]!)
    const rows = SUSPECTS.map((s: Suspect, i) => {
      const struck = n.verdict.struck.includes(s)
      const against = seen.filter((e) => !e.fits.includes(s))
      const note = struck
        ? `<div class="out">Named already. It wasn't.</div>`
        : against.length
          ? `<div class="out">Doesn't fit: ${esc(against.map((e) => e.why).join("; "))}.</div>`
          : seen.length
            ? `<div class="fits">Fits everything on your map.</div>`
            : ""
      return `<div class="s${struck ? " struck" : ""}${mine === s ? " mine" : ""}">${keyCapHtml(`Digit${i + 1}`)}<div><div class="name">${esc(SUSPECT_NAMES[s])}</div><div class="what">${esc(SUSPECT_LINES[s])}</div>${note}</div></div>`
    }).join("")
    const evidence = seen.length
      ? seen.map((e) => `<div>${esc(e.text)}</div>`).join("")
      : "<div>Nothing on your map says. Compare maps with the others (hold G together), or guess.</div>"
    this.el.innerHTML = `<div class="card"><div class="kicker">County radio · the foot of the tower</div><h1>What took her?</h1><div class="seen">${evidence}</div>${rows}<div class="foot">Press 1–4 to name it. Everyone at the radio gets a vote; a wrong name and it starts taking people. ${keyCapHtml("KeyE")} puts the handset down.</div></div>`
  }
}
