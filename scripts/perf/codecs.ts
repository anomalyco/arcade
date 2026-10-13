// Offline wire prototypes, not a production protocol. Numbers round-trip as Float64.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Patch = null | [0, Json] | [1 | 2, Record<string, Patch>]
export function delta(before: Json, after: Json): Patch {
  if (before === after) return null
  if (!before || !after || typeof before !== "object" || typeof after !== "object" || Array.isArray(before) !== Array.isArray(after)) return [0, after]
  const a = Object.keys(before), b = Object.keys(after)
  // Full replacement also preserves deletions, ordering, array splice and optional fields.
  if (a.length !== b.length || a.some((x,i)=>x!==b[i])) return [0, after]
  const changes: Record<string,Patch> = {}
  for (const key of b) {
    const d = delta((before as any)[key], (after as any)[key])
    if (d) changes[key] = d
  }
  return Object.keys(changes).length ? [Array.isArray(after) ? 2 : 1, changes] : null
}
export function apply(before: Json, patch: Patch): Json {
  if (!patch) return before
  if (patch[0] === 0) return patch[1]
  const next: any = patch[0] === 2 ? [...before as Json[]] : { ...before as object }
  for (const [k,p] of Object.entries(patch[1])) next[k] = apply(next[k], p)
  return next
}

/** Streaming string dictionary. First use is transmitted; no corpus lookahead/schema subsidy. */
export class Binary {
  private strings: string[] = []
  private ids = new Map<string, number>()
  private scratch = new Uint8Array(1 << 20)
  encode(json: Json): Uint8Array {
    const buf = this.scratch, view = new DataView(buf.buffer)
    let at = 0
    const uint = (n: number) => { do { const b = n & 127; n = Math.floor(n / 128); buf[at++] = b | (n ? 128 : 0) } while (n) }
    const text = (s: string) => {
      const known = this.ids.get(s)
      if (known !== undefined) { uint(known + 1); return }
      uint(0)
      const bytes = new TextEncoder().encode(s); uint(bytes.length); buf.set(bytes, at); at += bytes.length
      this.ids.set(s, this.strings.length); this.strings.push(s)
    }
    const write = (x: Json): void => {
      if (x === null) buf[at++] = 0
      else if (typeof x === "boolean") buf[at++] = x ? 2 : 1
      else if (typeof x === "number") {
        if (Number.isSafeInteger(x) && x >= 0 && x <= 0xffffffff) { buf[at++] = 3; uint(x) }
        else { buf[at++] = 4; view.setFloat64(at, x, true); at += 8 }
      } else if (typeof x === "string") { buf[at++] = 5; text(x) }
      else if (Array.isArray(x)) { buf[at++] = 6; uint(x.length); x.forEach(write) }
      else { buf[at++] = 7; const keys = Object.keys(x); uint(keys.length); for (const k of keys) { text(k); write(x[k]!) } }
    }
    write(json)
    if (at >= buf.length) throw Error("Prototype packet too large")
    return buf.slice(0, at)
  }
  decode(buf: Uint8Array): Json {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    let at = 0
    const uint = () => { let n = 0, mul = 1, b: number; do { b = buf[at++]!; n += (b & 127) * mul; mul *= 128 } while (b & 128); return n }
    const text = () => {
      const id = uint(); if (id) return this.strings[id-1]!
      const n = uint(), s = new TextDecoder().decode(buf.subarray(at, at+n)); at += n; this.strings.push(s); return s
    }
    const read = (): Json => {
      switch (buf[at++]) {
        case 0: return null
        case 1: return false
        case 2: return true
        case 3: return uint()
        case 4: { const x = view.getFloat64(at, true); at += 8; return x }
        case 5: return text()
        case 6: return Array.from({length:uint()},read)
        case 7: { const n = uint(), x: Record<string,Json> = {}; for(let i=0;i<n;i++) { const k=text(); Object.defineProperty(x,k,{ value:read(),enumerable:true,writable:true,configurable:true }) }; return x }
        default: throw Error("Unknown binary tag")
      }
    }
    const result = read(); if (at !== buf.length) throw Error("Trailing binary bytes"); return result
  }
}
