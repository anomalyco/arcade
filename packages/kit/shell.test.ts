import { describe, expect, test } from "bun:test"
import { AdaptiveQualityController, selectStartupTier, type QualityMode, type QualityTier } from "./quality"
import { GameShell, audioRuntimeSync } from "./shell"
import { ShellFlow, isTextEntry } from "./shell/flow"
import { ShellLobby } from "./shell/lobby"
import { LeaveGuard, ShellLoading } from "./shell/page"
import { ShellSettings, muteStorageKey } from "./shell/settings"
import { volumeLevel } from "./shell/volume"

const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init))
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

class FakeDoc extends EventTarget {
  pointerLockElement: Element | null = null
  hidden = false
  exitPointerLock() {
    this.setLock(null)
  }
  setLock(el: Element | null) {
    this.pointerLockElement = el
    this.dispatchEvent(new Event("pointerlockchange"))
  }
}

const esc = (win: EventTarget, target?: object) => {
  const e = new Event("keydown", { cancelable: true }) as Event & { code: string; repeat: boolean; target: EventTarget | null }
  Object.defineProperty(e, "code", { value: "Escape" })
  Object.defineProperty(e, "repeat", { value: false })
  if (target) Object.defineProperty(e, "target", { value: target })
  win.dispatchEvent(e)
}

/** A GameShell needs a window and document; these stand in for both while `run` builds and drives one. */
function withFakePage<T>(run: () => T): T {
  const g = globalThis as Record<string, unknown>
  const saved = { window: g.window, document: g.document }
  g.window = new EventTarget()
  g.document = new FakeDoc()
  try {
    return run()
  } finally {
    g.window = saved.window
    g.document = saved.document
  }
}

describe("@arcade/kit/shell settings", () => {
  test("volumes and mute are saved per game and gain is master × channel, 0 muted", () => {
    const storage = memory()
    const a = new ShellSettings({ game: "lot", storage, automated: false, prefersReducedMotion: false })
    expect(a.muted).toBe(false)
    expect(a.gain("master")).toBeCloseTo(0.8)
    a.setVolume("effects", 50)
    expect(a.gain("effects")).toBeCloseTo(0.4)
    a.setMuted(true)
    expect(a.gain("effects")).toBe(0)
    expect(storage.m.get(muteStorageKey("lot"))).toBe("1")
    const b = new ShellSettings({ game: "lot", storage, automated: false })
    expect(b.volume("effects")).toBe(50)
    expect(b.muted).toBe(true)
    expect(new ShellSettings({ game: "other", storage, automated: false }).volume("effects")).toBe(100)
  })

  test("automation starts muted and ignores saved volumes; legacy keys are read once", () => {
    const storage = memory({ "arcade.volume.brawl.v1": JSON.stringify({ volumeMaster: 10 }), "brawl.muted": "0", "nightshift.reduceMotion": "true" })
    const auto = new ShellSettings({ game: "brawl", storage, automated: true })
    expect(auto.muted).toBe(true)
    expect(auto.volume("master")).toBe(80)
    const legacy = new ShellSettings({ game: "brawl", storage, automated: false, legacyMuteKey: "brawl.muted", legacyReduceMotionKey: "nightshift.reduceMotion" })
    expect(legacy.muted).toBe(false)
    expect(legacy.volume("master")).toBe(10)
    expect(legacy.reduceMotion).toBe(true)
  })

  test("master and mute are one control: 0 is muted, unmuting at 0 brings back the last level heard", () => {
    const storage = memory()
    const s = new ShellSettings({ game: "lot", storage, automated: false, prefersReducedMotion: false })
    s.setVolume("master", 60)
    s.setVolume("master", 0)
    expect(s.muted).toBe(true)
    expect(storage.m.get(muteStorageKey("lot"))).toBe("1")
    s.toggleMute()
    expect(s.muted).toBe(false)
    expect(s.volume("master")).toBe(60)
    // Moving the slider while muted unmutes; a saved master of 0 loads muted.
    s.setMuted(true)
    s.setVolume("master", 40)
    expect(s.muted).toBe(false)
    expect(new ShellSettings({ game: "x", storage: memory({ "arcade.volume.x.v1": JSON.stringify({ volumeMaster: 0 }) }), automated: false }).muted).toBe(true)
  })

  test("quality goes through the game's ShellQuality and notifies views", () => {
    let mode: QualityMode = "auto"
    const quality = { get mode() { return mode }, tier: "high" as QualityTier, setMode: (m: QualityMode) => void (mode = m) }
    const s = new ShellSettings({ game: "x", storage: memory(), quality, automated: false })
    let n = 0
    s.subscribe(() => n++)
    s.setQuality("low")
    s.setQuality("low")
    expect(mode as QualityMode).toBe("low")
    expect(n).toBe(1)
  })
})

describe("@arcade/kit/shell quality policy (Auto starts High, steps down only on slow frames)", () => {
  test("startup keeps High when the GPU is busy but frames make the budget", () => {
    expect(selectStartupTier(16.6, 15.5)).toBe("balanced")
    expect(selectStartupTier(16.6, 15.5, 1000 / 60, "slow-frames")).toBe("high")
    expect(selectStartupTier(22, 20, 1000 / 60, "slow-frames")).toBe("balanced")
    expect(selectStartupTier(30, 28, 1000 / 60, "slow-frames")).toBe("low")
  })

  test("runtime: GPU without headroom alone does not step down; missed frames do", () => {
    const run = (stepDown: "headroom" | "slow-frames", frame: number, gpu: number) => {
      const c = new AdaptiveQualityController({ stepDown, warmupFrames: 1, startupSamples: 2, adaptWindowMs: 100, minWindowSamples: 4 })
      let now = 0
      for (let i = 0; i < 200; i++) c.recordFrame(frame, gpu, (now += frame))
      return c.state(2)
    }
    expect(run("headroom", 16.6, 15.5).resolutionScale).toBeLessThan(1)
    const kept = run("slow-frames", 16.6, 15.5)
    expect(kept.activeTier).toBe("high")
    expect(kept.resolutionScale).toBe(1)
    const slow = run("slow-frames", 24, 20)
    expect(slow.activeTier !== "high" || slow.resolutionScale < 1).toBe(true)
  })
})

describe("@arcade/kit/shell flow", () => {
  test("Escape pauses, opens back out of Settings, and resumes; Leave goes to the title", () => {
    const doc = new FakeDoc(), win = new EventTarget()
    const flow = new ShellFlow({ doc: doc as never, win: win as never })
    expect(flow.screen).toBe("title")
    flow.play()
    expect(flow.screen).toBe("playing")
    esc(win)
    expect(flow.screen).toBe("paused")
    flow.openSettings()
    expect(flow.settingsOpen).toBe(true)
    esc(win)
    expect(flow.settingsOpen).toBe(false)
    expect(flow.screen).toBe("paused")
    esc(win)
    expect(flow.screen).toBe("playing")
    flow.pause()
    flow.leave()
    expect(flow.screen).toBe("title")
  })

  test("pointer lock: losing it pauses, its own Escape is not a second press, a refusal never strands the menu", async () => {
    const doc = new FakeDoc(), win = new EventTarget(), canvas = {} as HTMLElement
    const relockMs = { afterEsc: 40, retry: 20 }
    let panel = false
    const flow = new ShellFlow({ doc: doc as never, win: win as never, pointerLock: canvas, blocked: () => panel, requestLock: (el) => doc.setLock(el as never), relockMs })
    flow.play()
    expect(flow.screen).toBe("playing")
    doc.setLock(null) // the browser ate Esc
    esc(win) // and Firefox still delivers it
    expect(flow.screen).toBe("paused")
    expect(flow.overlay).toBe("paused")
    panel = true
    expect(flow.overlay).toBe(null)
    panel = false
    // One click on Resume right after the player's Esc: the request waits out the browser's cooldown, no second click.
    flow.resume()
    expect(flow.arming).toBe(true)
    expect(flow.screen).toBe("paused")
    await Bun.sleep(60)
    expect(flow.arming).toBe(false)
    expect(flow.screen).toBe("playing")
    // The shell's own release (pause, Settings) has no cooldown: Resume takes the lock at once.
    flow.pause()
    expect(flow.screen).toBe("paused")
    flow.resume()
    expect(flow.screen).toBe("playing")
    // A refusal is retried once quietly; refused again, the menu stays up and says so.
    let asked = 0
    const other = new FakeDoc()
    const refusing = new ShellFlow({ doc: other as never, win: win as never, pointerLock: canvas, requestLock: () => (asked++, other.dispatchEvent(new Event("pointerlockerror"))), relockMs })
    refusing.play()
    expect(refusing.lockRefused).toBe(false)
    await Bun.sleep(80)
    expect(asked).toBe(2)
    expect(refusing.screen).toBe("title")
    expect(refusing.lockRefused).toBe(true)
  })

  test("a Resume waiting out the Esc cooldown is dropped when Settings or the Lab panel takes the screen", async () => {
    const doc = new FakeDoc(), win = new EventTarget(), canvas = {} as HTMLElement
    const relockMs = { afterEsc: 40, retry: 20 }
    let panel = false, asked = 0
    const flow = new ShellFlow({ doc: doc as never, win: win as never, pointerLock: canvas, blocked: () => panel, requestLock: (el) => (asked++, doc.setLock(el as never)), relockMs })
    flow.play()
    doc.setLock(null) // the player's Esc
    flow.resume()
    expect(flow.arming).toBe(true)
    flow.openSettings(true)
    expect(flow.arming).toBe(false)
    await Bun.sleep(60)
    expect(flow.screen).toBe("paused")
    expect(flow.settingsOpen).toBe(true)
    expect(asked).toBe(1)
    flow.openSettings(false)
    // Again, with the Lab panel opening while it waits.
    doc.setLock(canvas as never)
    doc.setLock(null)
    flow.resume()
    panel = true
    await Bun.sleep(60)
    expect(flow.screen).toBe("paused")
    expect(flow.arming).toBe(false)
    expect(asked).toBe(1)
  })

  test("a refusal of someone else's lock request (the Lab panel's on Esc) is neither retried nor reported", async () => {
    const doc = new FakeDoc(), win = new EventTarget(), canvas = {} as HTMLElement
    let asked = 0
    const flow = new ShellFlow({ doc: doc as never, win: win as never, pointerLock: canvas, requestLock: (el) => (asked++, doc.setLock(el as never)), relockMs: { afterEsc: 300, retry: 20 } })
    flow.play()
    expect(flow.screen).toBe("playing")
    doc.setLock(null) // the panel opens and frees the mouse
    doc.dispatchEvent(new Event("pointerlockerror")) // its resumeLock is refused (Esc within the cooldown)
    await Bun.sleep(40)
    expect(asked).toBe(1)
    expect(flow.lockRefused).toBe(false)
    // A Resume dropped by pause() forgets its click too.
    flow.resume()
    flow.pause()
    doc.dispatchEvent(new Event("pointerlockerror"))
    await Bun.sleep(80)
    expect(asked).toBe(1)
    expect(flow.lockRefused).toBe(false)
  })

  test("Settings opened from play (a HUD button) goes straight back to play when closed", () => {
    const doc = new FakeDoc(), win = new EventTarget()
    const flow = new ShellFlow({ doc: doc as never, win: win as never, start: "playing" })
    flow.openSettings()
    expect(flow.screen).toBe("paused")
    expect(flow.settingsOpen).toBe(true)
    flow.openSettings(false)
    expect(flow.screen).toBe("playing")
    flow.openSettings()
    esc(win)
    expect(flow.screen).toBe("playing")
    flow.pause()
    flow.openSettings()
    flow.openSettings(false)
    expect(flow.screen).toBe("paused")
  })

  test("a game menu that owns Escape keeps it", () => {
    const doc = new FakeDoc(), win = new EventTarget()
    let owned = true
    const flow = new ShellFlow({ doc: doc as never, win: win as never, start: "playing", escapeOwned: () => owned })
    esc(win)
    expect(flow.screen).toBe("playing")
    owned = false
    esc(win)
    expect(flow.screen).toBe("paused")
  })
})

describe("@arcade/kit/shell keys after using a control", () => {
  test("sliders, checkboxes and buttons aren't text entry; text fields are", () => {
    for (const type of ["range", "checkbox", "radio", "button", "submit", "color"]) expect(isTextEntry({ tagName: "INPUT", type })).toBe(false)
    for (const type of ["text", "search", "number", "email", "password"]) expect(isTextEntry({ tagName: "INPUT", type })).toBe(true)
    expect(isTextEntry({ tagName: "TEXTAREA" })).toBe(true)
    expect(isTextEntry({ tagName: "BUTTON" })).toBe(false)
  })

  test("Escape closes Settings with a volume slider still focused; in a text field it only leaves the field", () => {
    const doc = new FakeDoc()
    const win = new EventTarget()
    const flow = new ShellFlow({ doc: doc as never, win: win as never, start: "playing" })
    flow.pause()
    flow.openSettings(true)
    let blurred = 0
    esc(win, { tagName: "INPUT", type: "text", blur: () => blurred++ })
    expect(flow.settingsOpen).toBe(true)
    expect(blurred).toBe(1)
    esc(win, { tagName: "INPUT", type: "range", blur: () => blurred++ })
    expect(flow.settingsOpen).toBe(false)
    expect(flow.screen).toBe("paused")
    expect(blurred).toBe(1)
  })
})

describe("@arcade/kit/shell leaving a room", () => {
  const loc = () => ({ origin: "https://anoma.ly", pathname: "/arcade/brawl/", search: "?room=ab12" })

  test("Leave from the pause menu leaves the room: room, invite param and guard clear, and the game's Leave runs once", () =>
    withFakePage(() => {
      let left = 0
      const shell = new GameShell({ game: "brawl", title: "BRAWL", view: false, hidden: false, start: "playing", onLeave: () => left++, lobby: { storage: memory(), location: loc(), onJoin: () => {} } })
      const lobby = shell.lobby!
      expect(lobby.join("ab12")).toBe(true)
      expect(shell.guard!.armed).toBe(true)
      shell.flow.pause()
      shell.flow.leave()
      expect(lobby.room).toBe(null)
      expect(lobby.linkedRoom).toBe(null)
      expect(shell.guard!.armed).toBe(false)
      expect(left).toBe(1)
      shell.dispose()
    }))

  test("a game's own onLeaveRoom runs before its Leave; the room card's Leave room uses Leave when there is none", () =>
    withFakePage(() => {
      const calls: string[] = []
      const own = new GameShell({ game: "g", title: "G", view: false, hidden: false, start: "playing", onLeave: () => calls.push("leave"), lobby: { storage: memory(), location: loc(), onJoin: () => {}, onLeaveRoom: () => calls.push("room") } })
      own.lobby!.join("ab12")
      own.flow.leave()
      expect(calls).toEqual(["room", "leave"])
      own.dispose()
      calls.length = 0
      const plain = new GameShell({ game: "g", title: "G", view: false, hidden: false, start: "title", onLeave: () => calls.push("leave"), lobby: { storage: memory(), location: loc(), onJoin: () => {} } })
      plain.lobby!.join("ab12")
      plain.lobby!.leaveRoom()
      expect(calls).toEqual(["leave"])
      plain.dispose()
    }))

  test("a game whose onLeave calls flow.leave() again still leaves once", () =>
    withFakePage(() => {
      let left = 0
      const shell: GameShell = new GameShell({ game: "g", title: "G", view: false, hidden: false, start: "playing", onLeave: () => { left++; shell.flow.leave() } })
      shell.flow.leave()
      expect(left).toBe(1)
      shell.dispose()
    }))

  test("Play alone from an invite link clears the room from the address", () => {
    const l = new ShellLobby({ game: "g", storage: memory(), location: loc(), onJoin: () => {}, onSolo: () => {} })
    expect(l.linkedRoom).toBe("ab12")
    l.playAlone()
    expect(l.linkedRoom).toBe(null)
  })
})

describe("@arcade/kit/shell audio runtime", () => {
  test("the sync turns the runtime's own M off so mute isn't bound twice", () => {
    const runtime = { muted: false, muteKey: true, ctx: undefined, setMuted() {}, setVolume() {}, setBusGain() {} }
    const sync = audioRuntimeSync(new ShellSettings({ game: "g", storage: memory(), automated: false }), runtime)
    expect(runtime.muteKey).toBe(false)
    sync()
  })
})

describe("@arcade/kit/shell lobby", () => {
  const loc = { origin: "https://anoma.ly", pathname: "/arcade/woods/", search: "?room=ab12" }
  test("names, codes, invite links", () => {
    const storage = memory({ "woods.name": "Kit" })
    const joined: string[] = []
    const l = new ShellLobby({ game: "woods", storage, location: loc, onJoin: (r) => joined.push(r) })
    expect(l.name).toBe("Kit")
    expect(l.linkedRoom).toBe("ab12")
    expect(l.parseRoom("https://anoma.ly/arcade/woods/?room=XY99")).toBe("xy99")
    expect(l.parseRoom("no")).toBe(null)
    expect(l.join("??")).toBe(false)
    expect(l.message).toContain("room code")
    expect(l.join("ab12")).toBe(true)
    expect(joined).toEqual(["ab12"])
    expect(l.inviteLink()).toBe("https://anoma.ly/arcade/woods/?room=ab12")
    l.setName("Olive")
    expect(storage.m.get("woods.name")).toBe("Olive")
  })

  test("ready and start: the host starts once everyone here is ready", () => {
    const l = new ShellLobby({ game: "g", storage: memory(), location: loc, onJoin: () => {}, onReady: () => {}, onStart: () => {} })
    l.setPlayers([{ id: "a", name: "A", host: true, you: true, ready: true }, { id: "b", name: "B", ready: false }])
    expect(l.canStart).toBe(false)
    l.setPlayers([{ id: "a", name: "A", host: true, you: true, ready: true }, { id: "b", name: "B", away: true }])
    expect(l.canStart).toBe(true)
  })

  test("a required name stops room joins until one is typed; solo still plays", () => {
    const joined: string[] = []
    const solo: string[] = []
    const l = new ShellLobby({ game: "g", storage: memory(), location: loc, fallbackName: "Dax", nameRequired: "Type a callsign.", onJoin: (r) => joined.push(r), onSolo: (n) => solo.push(n) })
    expect(l.join("ab12")).toBe(false)
    expect(l.message).toBe("Type a callsign.")
    l.playAlone()
    expect(solo).toEqual(["Dax"])
    l.setName("Kit")
    expect(l.join("ab12")).toBe(true)
    expect(joined).toEqual(["ab12"])
    expect(l.hasSolo).toBe(true)
    expect(new ShellLobby({ game: "g", storage: memory(), location: loc, onJoin: () => {} }).hasSolo).toBe(false)
  })

  test("socket status maps onto reconnect UI", () => {
    const l = new ShellLobby({ game: "g", storage: memory(), location: loc })
    l.setSocketStatus("Connecting…")
    expect(l.connection).toBe("connecting")
    l.setSocketStatus("Connection lost. Reconnecting…")
    expect(l.connection).toBe("reconnecting")
    l.setSocketStatus(null)
    expect(l.connection).toBe("online")
  })

  test("an idle warning stays online with its line; a final lost isn't overwritten by later status", () => {
    const l = new ShellLobby({ game: "g", storage: memory(), location: loc })
    l.setSocketStatus("IDLE · kicked in 20 s")
    expect(l.connection).toBe("online")
    expect(l.message).toBe("IDLE · kicked in 20 s")
    l.setConnection("lost", "The room is full.")
    l.setSocketStatus(null)
    l.setSocketStatus("Connecting…")
    expect(l.connection).toBe("lost")
    expect(l.message).toBe("The room is full.")
  })
})

describe("@arcade/kit/shell page", () => {
  test("the leave guard asks only while active and never under automation", () => {
    let active = false
    const win = new EventTarget()
    const g = new LeaveGuard(() => active, { automated: false, win: win as never })
    expect(g.armed).toBe(false)
    active = true
    expect(g.armed).toBe(true)
    expect(new LeaveGuard(() => true, { automated: true, win: win as never }).armed).toBe(false)
  })

  test("loading progress follows reported work", () => {
    const l = new ShellLoading({ assets: 3, gpu: 1 })
    expect(l.progress).toBe(0)
    const assets = l.stage("assets", "Loading assets", 3)
    assets(0.5)
    expect(l.progress).toBeCloseTo(0.375)
    l.done("gpu")
    expect(l.progress).toBeCloseTo(0.625)
    l.finish()
    expect(l.progress).toBe(1)
  })
})

describe("HUD volume control", () => {
  test("the icon follows mute and the level", () => {
    expect(volumeLevel(true, 80)).toBe("muted")
    expect(volumeLevel(false, 0)).toBe("muted")
    expect(volumeLevel(false, 45)).toBe("low")
    expect(volumeLevel(false, 50)).toBe("high")
  })
})
