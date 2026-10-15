export interface StoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
export function memoryStorage(): StoragePort {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}
export function browserStorage(): StoragePort | null {
  return typeof window === "undefined" ? null : window.localStorage
}
export function urlFlag(name: string): () => boolean {
  return () => typeof location !== "undefined" && new URLSearchParams(location.search).has(name)
}
export const storageKey = (id: string, part: string) => `knobs:${encodeURIComponent(id)}:${part}:v1`
