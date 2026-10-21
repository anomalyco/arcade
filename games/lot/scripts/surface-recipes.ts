// Ashwood render/materials.ts library values. UVs are metres, not normalized tiles.
// The source CC0 scans are decoded offline; no Three/Basis runtime ships.
export type SurfaceRecipe = { set: string; size: number; tint: number | number[]; sat: number; rough: [number, number]; normal: number; metal?: number; damp?: number }
export const recipes: Record<string, SurfaceRecipe> = {
  asphalt: { set: "asphalt", size: 3.5, tint: 0.5, sat: 0.5, rough: [0.25, 0.7], normal: 1.2 },
  asphalt_lot: { set: "asphalt_lot", size: 2.6, tint: 0.78, sat: 0.3, rough: [0.25, 0.68], normal: 1.1 },
  gravel: { set: "gravel", size: 1.5, tint: 0.55, sat: 0.6, rough: [1, 0], normal: 1.3 },
  concrete_floor: { set: "concrete_floor", size: 3, tint: 0.9, sat: 0.4, rough: [0.3, 0.62], normal: 1 },
  concrete_floor_dry: { set: "concrete_floor", size: 3, tint: 0.9, sat: 0.4, rough: [0.35, 0.45], normal: 1 },
  concrete_wall: { set: "concrete_wall", size: 1.8, tint: [0.8, 0.83, 0.82], sat: 0.3, rough: [0.2, 0.76], normal: 1.4 },
  concrete_dark: { set: "concrete_dark", size: 2, tint: 0.62, sat: 0.35, rough: [1, 0], normal: 1.2 },
  concrete_block: { set: "concrete_dark", size: 2, tint: [0.78, 0.72, 0.6], sat: 0.3, rough: [0.5, 0.45], normal: 1.1 },
  wood_pole: { set: "wood_pole", size: 1, tint: [0.42, 0.33, 0.26], sat: 0.6, rough: [0.25, 0.7], normal: 1.6 },
  bark: { set: "bark", size: 1.2, tint: [0.5, 0.44, 0.4], sat: 0.8, rough: [0.3, 0.68], normal: 1.6 },
  metal_galvanized: { set: "metal_galvanized", size: 1, tint: 1.05, sat: 0.15, rough: [0.6, 0.12], normal: 0.6, metal: 1 },
  metal_dark: { set: "metal_dark", size: 1, tint: 0.7, sat: 1, rough: [0.8, 0.25], normal: 1 },
  metal_painted: { set: "metal_painted", size: 1.2, tint: [0.107, 0.119, 0.107], sat: 0, rough: [0.45, 0.42], normal: 0.8 },
  door_steel: { set: "metal_painted", size: 1.2, tint: [0.047, 0.102, 0.07], sat: 0, rough: [0.45, 0.42], normal: 0.8 },
  forest_floor: { set: "forest_floor", size: 1.75, tint: [0.42, 0.4, 0.38], sat: 0.8, rough: [0.88, 0], normal: 1.2, damp: 0.6 },
  grass: { set: "grass", size: 2, tint: [0.34, 0.33, 0.24], sat: 0.75, rough: [0.925, 0], normal: 1.1, damp: 0.5 },
  dirt: { set: "dirt", size: 1.4, tint: 0.62, sat: 0.7, rough: [0.73, 0], normal: 1.2, damp: 0.9 },
}
