import { parseRunSeed, runSeedCode, runSeedLink, runSeedLocation, type RunSeed } from "./run-seed"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * Outbreak's part of the shell's Escape menu (`shell.view.pauseSlot`, #399): solo, the run's seed with Copy replay
 * link and Play seed, Restart, New town and back to the Lobby; in a room, Leave room. Restart, New town and Play seed
 * reload the page onto the new run.
 */
export class RunTools {
  readonly el: HTMLDivElement
  private shown = ""

  constructor(
    private readonly host: {
      run: () => RunSeed
      inRoom: () => boolean
      loadout: () => void
      leaveRoom: () => void
    },
  ) {
    this.el = document.createElement("div")
    this.el.className = "ob-run-tools"
    this.el.addEventListener("click", (e) => this.click(e))
    this.el.addEventListener("input", (e) => (e.target as HTMLInputElement).setCustomValidity?.(""))
    this.el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || (e.target as HTMLElement).dataset.role !== "run-seed") return
      e.preventDefault()
      this.playSeed()
    })
  }

  /** Redraws for the run and room on screen (call when the menu opens). */
  sync(): void {
    const room = this.host.inRoom()
    const run = this.host.run()
    const key = `${room}|${runSeedCode(run)}`
    if (key === this.shown) return
    this.shown = key
    this.el.innerHTML = room
      ? `<button type="button" class="as-btn" data-act="leave-coop">Leave room</button>`
      : `<label class="as-field"><span>Seed</span><input type="text" class="ob-run-seed" data-role="run-seed" value="${esc(runSeedCode(run))}" inputmode="decimal" autocomplete="off" spellcheck="false" /></label>
        <div class="as-row2"><button type="button" class="as-btn" data-act="copy-seed">Copy replay link</button><button type="button" class="as-btn" data-act="play-seed">Play seed</button></div>
        <div class="ob-run-row3"><button type="button" class="as-btn" data-act="restart-run">Restart</button><button type="button" class="as-btn" data-act="new-town">New town</button><button type="button" class="as-btn" data-act="loadout">Lobby</button></div>`
  }

  private click(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]")
    const run = this.host.run()
    switch (el?.dataset.act) {
      case "copy-seed":
        return void this.copySeed(el)
      case "play-seed":
        return this.playSeed()
      case "restart-run":
        return location.assign(runSeedLocation(run, location.href))
      case "new-town": {
        const seed = crypto.getRandomValues(new Uint32Array(1))[0]!
        return location.assign(runSeedLocation({ ...run, seed, houseSeed: seed }, location.href))
      }
      case "loadout":
        return this.host.loadout()
      case "leave-coop":
        return this.host.leaveRoom()
    }
  }

  private playSeed(): void {
    const input = this.el.querySelector<HTMLInputElement>('[data-role="run-seed"]')!
    const seed = parseRunSeed(input.value)
    input.setCustomValidity(seed ? "" : "Enter a seed from 0 to 4294967295, or a town.house seed.")
    if (!input.reportValidity() || !seed) return
    location.assign(runSeedLocation({ ...this.host.run(), ...seed }, location.href))
  }

  private async copySeed(button: HTMLButtonElement): Promise<void> {
    const link = runSeedLink(this.host.run())
    try {
      await navigator.clipboard.writeText(link)
      button.textContent = "Link copied"
    } catch {
      button.textContent = link
    }
    setTimeout(() => (button.textContent = "Copy replay link"), 2400)
  }
}
