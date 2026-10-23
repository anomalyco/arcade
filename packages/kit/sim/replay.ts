/** Portable word-wise FNV-1a over typed values, with IEEE-754 bits rather than formatted floats.
 * Object keys are unordered; arrays are ordered. Project Maps/Sets into sorted arrays
 * only when their iteration order is irrelevant to the simulation. No implicit omissions.
 */
export function replayHash(value: unknown): string {
  return hashValue(value)
}

function hashValue(value: unknown, normalizeNumber?: (value: number) => number): string {
  let hash = 0x811c9dc5
  const bytes = new DataView(new ArrayBuffer(8))
  const parents = new Set<object>()
  const word = (n: number) => { hash = Math.imul(hash ^ n, 0x01000193) }
  const text = (s: string) => {
    word(s.length)
    for (let i = 0; i < s.length; i++) {
      word(s.charCodeAt(i))
    }
  }
  const visit = (v: unknown): void => {
    if (v === null) { word(0); return }
    switch (typeof v) {
      case "undefined": word(1); return
      case "boolean": word(v ? 3 : 2); return
      case "number":
        word(4)
        const number = normalizeNumber ? normalizeNumber(v) : v
        // A single canonical NaN; preserve infinities, signed zero and every finite bit.
        if (Number.isNaN(number)) { word(0); word(0x7ff80000); return }
        bytes.setFloat64(0, number, true)
        word(bytes.getUint32(0, true)); word(bytes.getUint32(4, true))
        return
      case "string": word(5); text(v); return
      case "object": break
      default: throw new TypeError(`Replay state cannot contain ${typeof v}`)
    }
    if (parents.has(v)) throw new TypeError("Replay state cannot contain cycles")
    parents.add(v)
    if (Array.isArray(v)) {
      word(6); word(v.length)
      for (let i = 0; i < v.length; i++) {
        word(Object.hasOwn(v, i) ? 1 : 0)
        visit(v[i])
      }
    } else if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      word(7); text(v.constructor.name)
      // Iterate values, not host-endian backing bytes (including sliced views).
      const array = v as unknown as ArrayLike<number | bigint>
      word(array.length)
      for (let i = 0; i < array.length; i++) visit(array[i])
    } else {
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) throw new TypeError("Project replay state to plain data first")
      if (Object.getOwnPropertySymbols(v).length) throw new TypeError("Replay state cannot contain symbol keys")
      word(8)
      const keys = Object.keys(v).sort()
      word(keys.length)
      for (const key of keys) { text(key); visit((v as Record<string, unknown>)[key]) }
    }
    parents.delete(v)
  }
  visit(value)
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/** Each frame has exactly one input per player, in the fixed `players` order. */
export type ReplayRecording<I> = {
  version: 1
  seed: number
  simVersion: string
  tickDt: number
  players: string[]
  inputs: I[][]
}

export type ReplaySim<S, I> = {
  /** Bump when changing the adapter's setup, stepping contract or state projection. */
  version: string
  init(recording: Omit<ReplayRecording<I>, "inputs">): S
  step(state: S, inputs: readonly I[], dt: number): void
  /** All authoritative state, partitioned into named fields for divergence diagnostics.
   * Read synchronously; no clone is needed. Do not include wall clocks or render state.
   */
  fields(state: S): Record<string, unknown>
  /** Optional snapshot-only numeric projection for cross-runtime math drift.
   * Must be pure; never changes sim state or the exact input/recording hash.
   * Document precision and bump `version` whenever this policy changes.
   */
  normalizeNumber?(value: number): number
}

export type ReplayGolden = {
  version: 1
  recordingHash: string
  /** Index 0 is the initial state; index N is the state after N input frames. */
  hashes: string[]
  fields: Record<string, string[]>
}

function validate<I>(simVersion: string, recording: ReplayRecording<I>): void {
  if (recording.version !== 1) throw new Error(`Unsupported replay version ${recording.version}`)
  if (recording.simVersion !== simVersion) throw new Error(`Replay sim version ${recording.simVersion}, expected ${simVersion}`)
  if (!Number.isInteger(recording.seed) || recording.seed < 0 || recording.seed > 0xffffffff) throw new Error("Replay seed must be a uint32")
  if (!Number.isFinite(recording.tickDt) || recording.tickDt <= 0) throw new Error("Replay tickDt must be positive and finite")
  if (!recording.players.length || new Set(recording.players).size !== recording.players.length) throw new Error("Replay players must be nonempty and unique")
  if (recording.inputs.some((frame) => frame.length !== recording.players.length)) throw new Error("Replay frame must contain one input per player")
}

function capture<S, I>(sim: ReplaySim<S, I>, state: S, trace: ReplayGolden): void {
  const fields = sim.fields(state)
  const hashes: Record<string, string> = Object.create(null)
  const tick = trace.hashes.length
  for (const key of Object.keys(fields)) {
    hashes[key] = hashValue(fields[key], sim.normalizeNumber)
    // Empty string means absent, distinct from a field whose value is undefined.
    trace.fields[key] ??= Array<string>(tick).fill("")
  }
  for (const key of Object.keys(trace.fields)) trace.fields[key]!.push(hashes[key] ?? "")
  trace.hashes.push(replayHash(hashes))
}

/** Record the actual consumed inputs once. Input generation may read the live state. */
export function recordReplay<S, I>(
  sim: ReplaySim<S, I>,
  options: Omit<ReplayRecording<I>, "version" | "simVersion" | "inputs"> & { ticks: number },
  input: (state: S, tick: number) => readonly I[],
): { recording: ReplayRecording<I>; golden: ReplayGolden } {
  if (!Number.isSafeInteger(options.ticks) || options.ticks < 1) throw new Error("Replay ticks must be a positive integer")
  const { ticks, ...header } = options
  const recording: ReplayRecording<I> = { ...header, players: [...header.players], version: 1, simVersion: sim.version, inputs: [] }
  validate(sim.version, recording)
  const state = sim.init(recording)
  const golden: ReplayGolden = { version: 1, recordingHash: "", hashes: [], fields: Object.create(null) }
  capture(sim, state, golden)
  for (let tick = 0; tick < ticks; tick++) {
    const frame = structuredClone([...input(state, tick)])
    if (frame.length !== recording.players.length) throw new Error(`Replay input count at tick ${tick + 1}`)
    recording.inputs.push(frame)
    sim.step(state, structuredClone(frame), recording.tickDt)
    capture(sim, state, golden)
  }
  golden.recordingHash = replayHash(recording)
  return { recording, golden }
}

/** Runs as fast as the CPU permits, with no timers, renderer or bot decisions. */
export function replay<S, I>(sim: ReplaySim<S, I>, recording: ReplayRecording<I>): ReplayGolden {
  validate(sim.version, recording)
  const trace: ReplayGolden = { version: 1, recordingHash: replayHash(recording), hashes: [], fields: Object.create(null) }
  const state = sim.init(recording)
  capture(sim, state, trace)
  for (const frame of recording.inputs) {
    sim.step(state, structuredClone(frame), recording.tickDt)
    capture(sim, state, trace)
  }
  return trace
}

/** Use directly inside bun:test. Goldens are only written by an explicit recording script. */
export function assertReplayMatches(actual: ReplayGolden, golden: ReplayGolden): void {
  if (golden.version !== 1) throw new Error(`Unsupported golden version ${golden.version}`)
  if (actual.recordingHash !== golden.recordingHash) throw new Error("Replay recording changed; review inputs before re-recording the golden")
  const count = Math.max(actual.hashes.length, golden.hashes.length)
  for (let tick = 0; tick < count; tick++) {
    if (actual.hashes[tick] === golden.hashes[tick]) continue
    const keys = [...new Set([...Object.keys(golden.fields), ...Object.keys(actual.fields)])].sort()
    const diffs = keys.filter((key) => (golden.fields[key]?.[tick] ?? "") !== (actual.fields[key]?.[tick] ?? ""))
    throw new Error([
      `Replay diverged at tick ${tick}: expected ${golden.hashes[tick] ?? "<end>"}, got ${actual.hashes[tick] ?? "<end>"}`,
      ...diffs.map((key) => `  ${key}: ${golden.fields[key]?.[tick] || "<absent>"} -> ${actual.fields[key]?.[tick] || "<absent>"}`),
    ].join("\n"))
  }
}
