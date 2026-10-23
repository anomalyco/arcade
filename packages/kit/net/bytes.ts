/** Little-endian binary writer that grows as needed. Reuse one per encoder and call `reset()` per message. */
export class ByteWriter {
  private buf: Uint8Array
  private view: DataView
  length = 0

  constructor(capacity = 1024) {
    this.buf = new Uint8Array(capacity)
    this.view = new DataView(this.buf.buffer)
  }

  reset(): this {
    this.length = 0
    return this
  }

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.length + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
    this.view = new DataView(next.buffer)
  }

  u8(v: number): this {
    this.ensure(1)
    this.buf[this.length++] = v
    return this
  }

  u16(v: number): this {
    this.ensure(2)
    this.view.setUint16(this.length, v, true)
    this.length += 2
    return this
  }

  i16(v: number): this {
    this.ensure(2)
    this.view.setInt16(this.length, Math.max(-32768, Math.min(32767, Math.round(v))), true)
    this.length += 2
    return this
  }

  i32(v: number): this {
    this.ensure(4)
    this.view.setInt32(this.length, Math.round(v) | 0, true)
    this.length += 4
    return this
  }

  u32(v: number): this {
    this.ensure(4)
    this.view.setUint32(this.length, v >>> 0, true)
    this.length += 4
    return this
  }

  f32(v: number): this {
    this.ensure(4)
    this.view.setFloat32(this.length, v, true)
    this.length += 4
    return this
  }

  f64(v: number): this {
    this.ensure(8)
    this.view.setFloat64(this.length, v, true)
    this.length += 8
    return this
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length)
    this.buf.set(b, this.length)
    this.length += b.length
    return this
  }

  /** UTF-8 string with a u16 byte length. */
  str(s: string): this {
    const b = encoder.encode(s)
    return this.u16(b.length).bytes(b)
  }

  /** Unsigned LEB128 varint (1 byte for 0..127, 2 bytes for 128..16383). */
  uvar(v: number): this {
    let n = v >>> 0
    while (n >= 0x80) {
      this.u8((n & 0x7f) | 0x80)
      n >>>= 7
    }
    return this.u8(n)
  }

  /** ZigZag-encoded signed varint (1 byte for -64..63, 2 bytes for -8192..8191). */
  ivar(v: number): this {
    const n = Math.round(v) | 0
    return this.uvar(((n << 1) ^ (n >> 31)) >>> 0)
  }

  /** Copy of the written bytes. */
  finish(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.length)
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class ByteReader {
  private view: DataView
  offset = 0

  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  get remaining(): number {
    return this.buf.length - this.offset
  }

  u8(): number {
    return this.view.getUint8(this.offset++)
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true)
    this.offset += 2
    return v
  }

  i16(): number {
    const v = this.view.getInt16(this.offset, true)
    this.offset += 2
    return v
  }

  i32(): number {
    const v = this.view.getInt32(this.offset, true)
    this.offset += 4
    return v
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true)
    this.offset += 4
    return v
  }

  f32(): number {
    const v = this.view.getFloat32(this.offset, true)
    this.offset += 4
    return v
  }

  f64(): number {
    const v = this.view.getFloat64(this.offset, true)
    this.offset += 8
    return v
  }

  bytes(n: number): Uint8Array {
    const b = this.buf.subarray(this.offset, this.offset + n)
    this.offset += n
    return b
  }

  str(): string {
    return decoder.decode(this.bytes(this.u16()))
  }

  uvar(): number {
    let out = 0
    let shift = 0
    for (;;) {
      const b = this.u8()
      out |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) return out >>> 0
      shift += 7
    }
  }

  ivar(): number {
    const u = this.uvar()
    return (u >>> 1) ^ -(u & 1)
  }
}

/**
 * Prefixes a per-recipient part to a payload shared by every recipient, which the caller encodes once per snapshot
 * (the shared-prefix technique from `docs/research/game-notes.md`, here as bytes rather than JSON).
 * Layout: u32 personal length, personal bytes, shared bytes.
 */
export function frame(personal: Uint8Array, shared: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + personal.length + shared.length)
  new DataView(out.buffer).setUint32(0, personal.length, true)
  out.set(personal, 4)
  out.set(shared, 4 + personal.length)
  return out
}

export function unframe(data: Uint8Array): { personal: Uint8Array; shared: Uint8Array } {
  const n = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true)
  return { personal: data.subarray(4, 4 + n), shared: data.subarray(4 + n) }
}

/** Angle in radians to/from a u16 turn fraction (0.0055° steps). */
export const packAngle = (a: number) => Math.round((((a / (Math.PI * 2)) % 1) + 1) % 1 * 65536) & 0xffff
export const unpackAngle = (v: number) => (v / 65536) * Math.PI * 2

/** Angle in radians to/from a 12-bit turn fraction (0..4095, 0.088° steps). */
export const packAngle12 = (a: number) => Math.round((((a / (Math.PI * 2)) % 1) + 1) % 1 * 4096) & 0x0fff
export const unpackAngle12 = (v: number) => ((v & 0x0fff) / 4096) * Math.PI * 2

/** Angle in radians to/from an 8-bit turn fraction (0..255, 1.406° steps). */
export const packAngle8 = (a: number) => Math.round((((a / (Math.PI * 2)) % 1) + 1) % 1 * 256) & 0xff
export const unpackAngle8 = (v: number) => ((v & 0xff) / 256) * Math.PI * 2

/** Packs two signed 4-bit integers in [-8, 7] into one byte. */
export const packNibblePair = (dx: number, dy: number) => ((Math.round(dx) + 8) & 0x0f) | (((Math.round(dy) + 8) & 0x0f) << 4)
export const unpackNibblePair = (b: number): [number, number] => [(b & 0x0f) - 8, ((b >>> 4) & 0x0f) - 8]

/** Writes `bits` as packed bytes without a length prefix (caller knows `bits.length`). */
export function writeBitset(w: ByteWriter, bits: readonly boolean[]): void {
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let k = 0; k < 8 && i + k < bits.length; k++) if (bits[i + k]) b |= 1 << k
    w.u8(b)
  }
}

export function readBitset(r: ByteReader, count: number): boolean[] {
  const out = new Array<boolean>(count)
  for (let i = 0; i < count; i += 8) {
    const b = r.u8()
    for (let k = 0; k < 8 && i + k < count; k++) out[i + k] = Boolean(b & (1 << k))
  }
  return out
}
