import { describe, expect, test } from "bun:test"
import type { FinalPass } from "../renderer"
import { FinalPassChain } from "./final-chain"

type Named = GPUTextureView & { name: string }
const view = (name: string) => ({ name }) as Named
const encoder = {} as GPUCommandEncoder
const frame = new Float32Array(20)

/** A pass that logs what it draws into and frames it is left out of; `holds` and `repeat` as given. */
function pass(name: string, log: string[], o: { holds?: boolean; repeat?: boolean } = {}): FinalPass & { skip(): void } {
  const src = view(`${name}.src`)
  return {
    active: true,
    source: () => src,
    encode: (_e, target) => { log.push(`${name}>${(target as Named).name}`) },
    skip: () => { log.push(`${name} skipped`) },
    ...(o.holds === undefined ? {} : { holds: () => o.holds! }),
    ...(o.repeat === undefined ? {} : { repeat: (_e: GPUCommandEncoder, target: GPUTextureView) => o.repeat ? (log.push(`${name} again>${(target as Named).name}`), true) : false }),
  }
}

function run(passes: (log: string[]) => FinalPass[]) {
  const log: string[] = []
  const chain = new FinalPassChain(passes(log))
  expect(chain.active).toBe(true)
  chain.source(1600, 900)
  const holds = chain.holds(frame)
  chain.encode(encoder, view("canvas"), frame)
  return { log, holds }
}

describe("final pass chain", () => {
  test("each pass draws into the next one's source, the last into the canvas", () => {
    expect(run((l) => [pass("lens", l), pass("filter", l, { holds: false }), pass("codec", l, { repeat: true })])).toEqual({
      log: ["lens>filter.src", "filter>codec.src", "codec>canvas"], holds: false,
    })
  })

  test("a held frame: the last pass repeats its picture and nothing else runs, the composite included", () => {
    expect(run((l) => [pass("lens", l), pass("filter", l, { holds: true }), pass("codec", l, { repeat: true })])).toEqual({
      log: ["codec again>canvas", "lens skipped", "filter skipped"], holds: true,
    })
  })

  test("a held frame with no picture to repeat runs from the holding pass on", () => {
    expect(run((l) => [pass("lens", l), pass("filter", l, { holds: true }), pass("codec", l, { repeat: false })])).toEqual({
      log: ["lens skipped", "filter>codec.src", "codec>canvas"], holds: true,
    })
  })

  test("the last pass holding draws its held picture itself", () => {
    expect(run((l) => [pass("blur", l), pass("lens", l), pass("filter", l, { holds: true })])).toEqual({
      log: ["blur skipped", "lens skipped", "filter>canvas"], holds: true,
    })
  })
})
