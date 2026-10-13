import type { Vehicle } from "../../shared/config"

/** Selectable in the Lab; URL overrides are reserved for automated captures. */
export type LightStyle = 0 | 1 | 2 | 3
export const lightStyles = [
  { value: 0, label: "Original" },
  { value: 1, label: "Recessed" },
  { value: 2, label: "Light bar" },
  { value: 3, label: "Cinematic" },
] as const
export function lightStyle(params: URLSearchParams): LightStyle {
  if (!params.has("bench") && !params.has("mux")) return 1
  const n = Number(params.get("lights") ?? 1)
  return n === 0 || n === 2 || n === 3 ? n : 1
}

/** Lens centres match the front/rear fascia geometry (local +z is forward). */
export function lampMounts(v: Vehicle) {
  const half = v.width / 2
  switch (v.id) {
    case "muscle": return { frontX: half - 0.32, frontY: 0.5, rearX: half - 0.33, rearY: 0.66 }
    case "cruiser": return { frontX: half - 0.37, frontY: 0.56, rearX: half - 0.35, rearY: 0.65 }
    case "interceptor": return { frontX: half - 0.38, frontY: 0.5, rearX: half - 0.37, rearY: 0.64 }
    case "compact": return { frontX: half - 0.31, frontY: 0.52, rearX: half - 0.23, rearY: 0.8 }
    case "van": return { frontX: half - 0.32, frontY: 0.58, rearX: half - 0.13, rearY: 1 }
    case "swat": return { frontX: half - 0.31, frontY: 0.8, rearX: half - 0.16, rearY: 1 }
    default: return { frontX: 0, frontY: 0.9, rearX: 0, rearY: 0.9 }
  }
}
