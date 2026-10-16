import * as THREE from "three/webgpu"

// The one place surface materials come from. Builders ask for a material by name and give their geometry UVs in
// metres (1 UV unit = 1 m) so every material tiles at real-world scale; the material owns its texture repeat.
// This file starts with flat stand-ins and is replaced by the textured PBR library.

export type MaterialName =
  | "asphalt"
  | "asphalt_lot"
  | "road_line_yellow"
  | "road_line_white"
  | "gravel"
  | "forest_floor"
  | "grass"
  | "dirt"
  | "concrete_wall"
  | "concrete_dark"
  | "concrete_floor"
  | "bark"
  | "pine_needles"
  | "wood_pole"
  | "metal_painted"
  | "metal_galvanized"
  | "metal_dark"
  | "chainlink"
  | "barbed_wire"
  | "glass_lit"
  | "glass_dark"
  | "door_steel"
  | "tile_green"
  | "tile_green_dark"
  | "linoleum"
  | "ceiling_tile"
  | "terrazzo"
  | "painted_wall"
  | "rubber"
  | "car_paint"
  | "chrome"
  | "plastic_orange"
  | "emissive_sodium"
  | "emissive_fluorescent"

const STAND_INS: Record<MaterialName, [color: number, roughness: number, metalness: number]> = {
  asphalt: [0x1a1c1c, 0.35, 0],
  asphalt_lot: [0x1d1f1f, 0.45, 0],
  road_line_yellow: [0x8a6a1c, 0.5, 0],
  road_line_white: [0x8a8a86, 0.5, 0],
  gravel: [0x3a3a36, 0.95, 0],
  forest_floor: [0x2a2418, 0.95, 0],
  grass: [0x26301c, 0.9, 0],
  dirt: [0x3a3022, 0.95, 0],
  concrete_wall: [0x6a6a64, 0.9, 0],
  concrete_dark: [0x45463f, 0.9, 0],
  concrete_floor: [0x6b6a64, 0.7, 0],
  bark: [0x2b231c, 0.95, 0],
  pine_needles: [0x1b2a1c, 0.85, 0],
  wood_pole: [0x3a2d22, 0.9, 0],
  metal_painted: [0x5c615c, 0.6, 0.3],
  metal_galvanized: [0x8a8e8c, 0.45, 0.9],
  metal_dark: [0x2a2c2c, 0.55, 0.8],
  chainlink: [0x8a8e8c, 0.5, 0.9],
  barbed_wire: [0x6a6c6a, 0.5, 0.9],
  glass_lit: [0xf0d8a0, 0.1, 0],
  glass_dark: [0x0d1112, 0.05, 0],
  door_steel: [0x56604f, 0.55, 0.5],
  tile_green: [0x9db3a0, 0.35, 0],
  tile_green_dark: [0x3b5a48, 0.35, 0],
  linoleum: [0x8f8f80, 0.15, 0],
  ceiling_tile: [0xc8c6bc, 0.95, 0],
  terrazzo: [0x9a978d, 0.2, 0],
  painted_wall: [0xb8b8a8, 0.85, 0],
  rubber: [0x111111, 0.9, 0],
  car_paint: [0x3a4a3e, 0.35, 0.4],
  chrome: [0xcccccc, 0.15, 1],
  plastic_orange: [0xb5651d, 0.6, 0],
  emissive_sodium: [0xffa040, 1, 0],
  emissive_fluorescent: [0xe8f4ff, 1, 0],
}

const cache = new Map<MaterialName, THREE.Material>()

export function material(name: MaterialName): THREE.Material {
  const hit = cache.get(name)
  if (hit) return hit
  const s = STAND_INS[name]
  const m = new THREE.MeshStandardNodeMaterial({ color: s[0], roughness: s[1], metalness: s[2] })
  if (name === "emissive_sodium" || name === "emissive_fluorescent" || name === "glass_lit") {
    m.emissive = new THREE.Color(s[0])
    m.emissiveIntensity = name === "glass_lit" ? 2 : 8
  }
  m.name = name
  cache.set(name, m)
  return m
}

/** Called once after the renderer exists, before any builder runs. The textured library loads its maps here. */
export async function loadMaterials(_renderer: THREE.WebGPURenderer) {}
