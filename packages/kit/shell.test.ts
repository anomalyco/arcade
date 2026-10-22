import { describe, expect, test } from "bun:test"
import { AdaptiveQualityController, selectStartupTier, type QualityMode, type QualityTier } from "./quality"
import { ShellFlow } from "./shell/flow"
import { ShellLobby } from "./shell/lobby"
import { LeaveGuard, ShellLoading } from "./shell/page"
import { ShellSettings, muteStorageKey } from "./shell/settings"

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

const esc = (win: EventTarget) => {
  const e = new Event("keydown", { cancelable: true }) as Event & { code: string; repeat: boolean; target: EventTarget | null }
  Object.defineProperty(e, "code", { value: "Escape" })
  Object.defineProperty(e, "repeat", { value: false })
  win.dispatchEvent(e)
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

  test("pointer lock: losing it pauses, its own Escape is not a second press, a refusal never strands the menu", () => {
    const doc = new FakeDoc(), win = new EventTarget(), canvas = {} as HTMLElement
    let panel = false
    const flow = new ShellFlow({ doc: doc as never, win: win as never, pointerLock: canvas, blocked: () => panel, requestLock: (el) => doc.setLock(el as never) })
    flow.play()
    expect(flow.screen).toBe("playing")
    doc.setLock(null) // the browser ate Esc
    esc(win) // and Firefox still delivers it
    expect(flow.screen).toBe("paused")
    expect(flow.overlay).toBe("paused")
    panel = true
    expect(flow.overlay).toBe(null)
    panel = false
    flow.resume()
    expect(flow.screen).toBe("playing")
    const refusing = new ShellFlow({ doc: doc as never, win: win as never, pointerLock: canvas, requestLock: () => doc.dispatchEvent(new Event("pointerlockerror")) })
    doc.setLock(null)
    refusing.resume()
    expect(refusing.screen).toBe("title")
    expect(refusing.lockRefused).toBe(true)
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
