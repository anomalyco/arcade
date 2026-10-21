// Build-time adapter only. The authored Three geometry is baked to kit vertices; no Three code ships.
import * as THREE from "three"
import { recipes } from "./surface-recipes"

type Recipe = { color?: THREE.ColorRepresentation; color2?: number; roughness?: number; metalness?: number; emissive?: THREE.Color; intensity?: number; transparent?: number; name?: string }
class ExportMaterial extends THREE.MeshStandardMaterial {
  surfaceParams = new Float32Array(24)
  override copy(source: THREE.Material): this {
    super.copy(source)
    this.surfaceParams.set((source as ExportMaterial).surfaceParams ?? new Float32Array(16))
    return this
  }
}
export function materialFor(kind: string, p: Recipe = {}) {
  const m = new ExportMaterial({ color: p.color ?? 0x555956, roughness: p.roughness ?? 0.8, metalness: p.metalness ?? 0,
    emissive: p.emissive ?? 0, emissiveIntensity: p.intensity ?? 0, transparent: p.transparent !== undefined, opacity: p.transparent ?? 1 })
  m.name = p.name ?? kind
  m.userData.library = kind
  m.surfaceParams.set([m.color.r,m.color.g,m.color.b,m.roughness,m.emissive.r*m.emissiveIntensity,m.emissive.g*m.emissiveIntensity,m.emissive.b*m.emissiveIntensity])
  return m
}
const colors: Record<string, number> = { asphalt: 0x454745, asphalt_lot: 0x454745, road_line_white: 0xa7a397, road_line_yellow: 0x8c5c0f,
  concrete_wall: 0x888c88, concrete_dark: 0x505653, concrete_floor: 0x70746e, metal_dark: 0x292e2a, metal_galvanized: 0x60645d,
  metal_painted: 0x505447, door_steel: 0x42483c, wood_pole: 0x4a3527, bark: 0x352e24, glass_dark: 0x080e0c, rubber: 0x080808,
  forest_floor: 0x20251c, gravel: 0x45463b, grass: 0x263021, dirt: 0x29251d }
const cache = new Map<string, THREE.MeshStandardMaterial>()
export function material(name: string) {
  let m = cache.get(name)
  if (m) return m
  m = materialFor(name, { color: colors[name] ?? 0x555956 })
  // The sampled asphalt supplies its own colour; Ashwood multiplies it by a linear 0.5 tint.
  if(recipes[name]) m.color.setRGB(1,1,1)
  if (name === "emissive_sodium") { m.emissive.setRGB(1, 0.5, 0.14); m.emissiveIntensity = 9 }
  cache.set(name, m)
  return m
}
export function decalBias() {}
