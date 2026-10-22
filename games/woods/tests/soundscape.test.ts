import { expect, test } from "bun:test"
import { makeWorld } from "../shared/world"
import { WOODS_FILES } from "../src/audio/files"
import { SOUND } from "../src/audio/settings"
import { Soundscape, type Listener } from "../src/audio/soundscape"

const world = makeWorld()
const ear: Listener = { x: world.camp.x, y: 1.7, z: world.camp.z, yaw: 0 }

/** Just enough of a BaseAudioContext to build the graph and schedule voices; records stops. */
function fakeContext() {
  const stopped: unknown[] = []
  const param = () => ({ value: 0, setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {} })
  const node = () => ({
    connect() {}, disconnect() {}, start() {}, stop(this: unknown) { stopped.push(this) },
    gain: param(), frequency: param(), Q: param(), playbackRate: param(), positionX: param(), positionY: param(), positionZ: param(),
    buffer: null as unknown, loop: false, loopStart: 0, loopEnd: 0, onended: null as unknown, type: "", panningModel: "", distanceModel: "", refDistance: 1, rolloffFactor: 1,
  })
  const ctx = {
    sampleRate: 200, currentTime: 0, state: "running", destination: node(), listener: { positionX: param(), positionY: param(), positionZ: param(), forwardX: param(), forwardY: param(), forwardZ: param(), upX: param(), upY: param(), upZ: param() },
    createGain: node, createBiquadFilter: node, createConvolver: node, createBufferSource: node, createPanner: node,
    createBuffer: (channels: number, n: number) => { const data = Array.from({ length: channels }, () => new Float32Array(n)); return { duration: n / 200, getChannelData: (c: number) => data[c]! } },
    decodeAudioData: async (b: ArrayBuffer) => ({ duration: 2, tag: new TextDecoder().decode(b) }),
  }
  return { ctx: ctx as unknown as BaseAudioContext, stopped }
}

const fileCount = Object.values(WOODS_FILES).reduce((n, l) => n + l.length, 0)

test("a file that fails is skipped, the woods still start, and the next load fetches only what is missing", async () => {
  const { ctx } = fakeContext()
  const scape = new Soundscape(ctx, ctx.destination, { ...SOUND }, "/a/", () => world)
  const urls: string[] = []
  const bad = "/a/" + WOODS_FILES["tree.knock"][1]!.file
  const ok = await scape.load(async (url) => { urls.push(url); if (url === bad) throw new Error("404"); return new TextEncoder().encode(url).buffer as ArrayBuffer })
  expect(ok).toBe(false)
  expect(urls.length).toBe(fileCount)
  expect(scape.loaded).toBe(true)
  expect(scape.complete).toBe(false)
  // The missing take falls back to one that loaded.
  expect(scape.oneShot("tree.knock", 1, ear.x + 10, 4, ear.z, ear, 0.1)).not.toBeNull()
  urls.length = 0
  expect(await scape.load(async (url) => { urls.push(url); return new TextEncoder().encode(url).buffer as ArrayBuffer })).toBe(true)
  expect(urls).toEqual([bad])
  expect(scape.complete).toBe(true)
})

test("nothing plays mid-load, and a missing bed keeps the woods waiting", async () => {
  const { ctx } = fakeContext()
  const scape = new Soundscape(ctx, ctx.destination, { ...SOUND }, "/a/", () => world)
  let release = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const loading = scape.load(async (url) => { await gate; if (url.includes("bed.lake")) throw new Error("offline"); return new ArrayBuffer(4) })
  expect(scape.load()).toBe(loading)
  expect(scape.oneShot("far.owl", 0, 0, 10, 0, ear, 1)).toBeNull()
  release()
  await loading
  expect(scape.loaded).toBe(false)
  expect(() => scape.update(ear, 1)).not.toThrow()
})

test("a distant sound that would reach you during a signal fades out; stopAll clears what is scheduled", async () => {
  const { ctx, stopped } = fakeContext()
  const scape = new Soundscape(ctx, ctx.destination, { ...SOUND }, "/a/", () => world)
  await scape.load(async () => new ArrayBuffer(4))
  scape.update(ear, 0)
  const far = { kind: "distant", sound: "far.owl", x: ear.x + 300, y: 12, z: ear.z, at: 0, take: 0, seq: 0 } as const
  scape.distant(far, ear, 0)
  stopped.length = 0
  scape.update(ear, 0.1, true)
  expect(stopped.length).toBe(1)
  scape.oneShot("tree.creak", 0, ear.x + 8, 5, ear.z, ear, 0.1)
  scape.update(ear, 0.2, true)
  expect(stopped.length).toBe(1)
  scape.stopAll()
  expect(stopped.length).toBe(3)
})
