import { isRecord, normalize, equal, type Schema, type Values } from "./schema.js"
import type { StoragePort } from "./storage.js"

export interface Variant<V> {
  readonly id: string
  readonly name?: string
  readonly values: V
}
export interface Variants<V> {
  readonly ready: boolean
  list(): readonly Variant<V>[]
  save(name?: string): Variant<V>
  load(id: string): void
  remove(id: string): void
  export(): string
  import(json: string): void
}
export function createVariants<S extends Schema>(
  schema: () => S,
  id: string,
  key: string,
  storage: () => StoragePort | null,
  get: () => Values<S>,
  set: (v: Values<S>) => void,
  notify: () => void,
  enabled: () => boolean,
): Variants<Values<S>> {
  type V = Variant<Values<S>>
  let ready = false
  let list: readonly V[] = Object.freeze([])
  function parse(json: string): readonly V[] {
    const data: unknown = JSON.parse(json)
    if (
      !isRecord(data) ||
      data.version !== 1 ||
      data.controls !== id ||
      !Array.isArray(data.variants)
    )
      throw new Error("Expected a version 1 export for these controls.")
    const ids = new Set<string>()
    return Object.freeze(
      data.variants.map((item: unknown) => {
        if (!isRecord(item) || typeof item.id !== "string" || !item.id || ids.has(item.id))
          throw new Error("Variant IDs must be unique nonempty strings.")
        ids.add(item.id)
        if (item.name !== undefined && (typeof item.name !== "string" || item.name.length > 100))
          throw new Error("Variant names must be at most 100 characters.")
        if (!isRecord(item.values)) throw new Error("Invalid variant values.")
        const values = normalize(schema(), item.values)
        if (!equal(values, item.values as Values<S>))
          throw new Error("Variant values do not match the schema, bounds, or step.")
        return Object.freeze({
          id: item.id,
          ...(typeof item.name === "string" ? { name: item.name } : {}),
          values,
        })
      }),
    )
  }
  const encode = (variants: readonly V[]) =>
    JSON.stringify({ version: 1, controls: id, variants }, null, 2)
  function read() {
    if (ready || !enabled()) return
    const json = storage()?.getItem(key)
    const next = json ? parse(json) : Object.freeze([])
    list = next
    ready = true
  }
  function persist(next: readonly V[]) {
    if (!enabled()) throw new Error("Controls are disabled.")
    if (!ready)
      throw new Error(
        "Read variants with list() before writing; unread storage will not be overwritten.",
      )
    storage()?.setItem(key, encode(next))
    list = Object.freeze(next)
    notify()
  }
  return {
    get ready() {
      return ready
    },
    list() {
      read()
      return list
    },
    save(name) {
      read()
      if (name !== undefined && name.length > 100)
        throw new Error("Variant names must be at most 100 characters.")
      const variant = Object.freeze({
        id: crypto.randomUUID(),
        ...(name?.trim() ? { name: name.trim() } : {}),
        values: get(),
      })
      persist([...list, variant])
      return variant
    },
    load(id) {
      read()
      const variant = list.find((v) => v.id === id)
      if (!variant) throw new Error(`Unknown variant: ${id}`)
      set(variant.values)
    },
    remove(id) {
      read()
      persist(list.filter((v) => v.id !== id))
    },
    export() {
      read()
      return encode(list)
    },
    import(json) {
      if (!ready)
        throw new Error(
          "Read variants with list() before importing; unread storage will not be overwritten.",
        )
      const incoming = parse(json)
      const ids = new Set(list.map((v) => v.id))
      persist([...list, ...incoming.filter((v) => !ids.has(v.id))])
    },
  }
}
