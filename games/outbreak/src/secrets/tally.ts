import { SECRET_IDS, type SecretId } from "../../shared/secrets/catalog"

/** Where this browser remembers every secret it has ever noticed. */
export const SECRETS_MEMORY_KEY = "arcade.outbreak.secrets"

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">

/** The secrets noticed this run, and every one this browser has ever noticed. */
export class SecretMemory {
  readonly run = new Set<SecretId>()
  readonly ever = new Set<SecretId>()
  constructor(private readonly storage: Storage | null = typeof localStorage === "undefined" ? null : localStorage) {
    try {
      const raw = JSON.parse(storage?.getItem(SECRETS_MEMORY_KEY) ?? "[]")
      if (Array.isArray(raw)) for (const id of raw) if (SECRET_IDS.includes(id)) this.ever.add(id)
    } catch {}
  }

  /** Notes a secret; true when it is new this run. */
  notice(id: SecretId): boolean {
    if (this.run.has(id)) return false
    this.run.add(id)
    if (!this.ever.has(id)) {
      this.ever.add(id)
      try {
        this.storage?.setItem(SECRETS_MEMORY_KEY, JSON.stringify([...this.ever]))
      } catch {}
    }
    return true
  }

  newRun(): void {
    this.run.clear()
  }

  forget(): void {
    this.run.clear()
    this.ever.clear()
    try {
      this.storage?.removeItem(SECRETS_MEMORY_KEY)
    } catch {}
  }
}

/** The tally's markup: pencil marks for this run (struck through in fives), a dot per secret, filled if ever noticed. */
export function tallyHtml(run: number, ever: ReadonlySet<SecretId>): string {
  let marks = ""
  for (let i = 0; i < run; i += 5) {
    const n = Math.min(5, run - i)
    marks += `<span class="osx-five${n === 5 ? " full" : ""}">${"<i></i>".repeat(Math.min(4, n))}</span>`
  }
  const dots = SECRET_IDS.map((id) => `<b${ever.has(id) ? ' class="on"' : ""}></b>`).join("")
  return `<div class="osx-marks">${marks}</div><div class="osx-dots">${dots}</div>`
}

/**
 * Puts the tally on the run-over or escape card when one is up and something was noticed this run. The cards are
 * other features' DOM, rebuilt when their text changes, so the tally is re-attached whenever it goes missing.
 */
export class CardTally {
  private html = ""
  shown = false
  constructor(private readonly doc: Document | null = typeof document === "undefined" ? null : document) {}

  update(memory: SecretMemory): void {
    this.shown = false
    if (!this.doc || !memory.run.size) return
    const card = this.doc.querySelector<HTMLElement>(".obd-card, .owo-card")
    if (!card) return
    const html = tallyHtml(memory.run.size, memory.ever)
    let el = card.querySelector<HTMLElement>(".osx-tally")
    if (!el) {
      el = this.doc.createElement("div")
      el.className = "osx-tally"
      el.setAttribute("aria-label", `${memory.run.size}`)
      const actions = card.querySelector(".obd-actions, .owo-actions")
      card.insertBefore(el, actions)
      this.html = ""
    }
    if (html !== this.html || el.innerHTML !== html) {
      this.html = html
      el.innerHTML = html
    }
    this.shown = true
  }
}
