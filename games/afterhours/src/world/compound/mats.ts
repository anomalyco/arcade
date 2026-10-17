import * as THREE from "three/webgpu"
import { materialFor } from "../../render/materials"

// The compound's one-off finishes. Every one is a member of the shared "flat" or "emissive" surface class from
// render/materials.ts, so all colours, glows, the booth glass and the contact-shadow layers compile to a handful of
// shaders in total. Patterns (boom stripes, sign pictograms) are geometry, not textures or node graphs.

/** Flat painted steel or plastic. */
export const flat = (color: number, roughness = 0.6, metalness = 0) => materialFor("flat", { color, roughness, metalness })

/** Weathered wood: a noisy blend between two browns. */
export const wood = (dark: number, light: number, roughness = 0.55) =>
  materialFor("flat", { color: dark, color2: light, roughness, noise: { scale: 6, channel: 2, smooth: true } })

/** A self-lit emitter (a bulb, glowing heater coils, a CRT screen). */
export const glow = (r: number, g: number, b: number, intensity: number) =>
  materialFor("emissive", { color: 0x000000, roughness: 1, emissive: new THREE.Color(r, g, b), intensity })

/** Transparent, double-sided flat layers: glass and the contact-shadow decals share this flag set (one shader). */
const seeThrough = (color: number, opacity: number, roughness: number, glowColor?: THREE.Color, intensity?: number) =>
  materialFor("flat", {
    color,
    roughness,
    transparent: opacity,
    side: THREE.DoubleSide,
    ...(glowColor ? { emissive: glowColor, intensity } : {}),
  })

/** Booth window glass: thin, slightly dirty, with a faint warm glow from the lit interior behind it. */
export const boothGlass = () => seeThrough(0x6a6252, 0.16, 0.06, new THREE.Color(1, 0.6, 0.28), 0.25)

/** One layer of a stacked contact-shadow decal (several nested layers fake the soft falloff). */
export const shadowLayer = () => seeThrough(0x000000, 0.2, 1)

/** Boom barrier stripe colours. */
export const boomRed = () => flat(0x7a120c, 0.5)
export const boomWhite = () => flat(0xb8b4a8, 0.5)

/** Warning-plate colours: weathered enamel with rust bloom, and the pictogram inks. */
export const signPlate = () => materialFor("flat", { color: 0xb8b2a0, color2: 0x6a3a1c, roughness: 0.75, metalness: 0.1, noise: { scale: 3, channel: 1, lo: 0.55, hi: 0.85, smooth: true } })
export const signBlank = () => materialFor("flat", { color: 0x7a7a70, color2: 0x5a3018, roughness: 0.8, metalness: 0.15, noise: { scale: 3, channel: 1, lo: 0.45, hi: 0.8, smooth: true } })
export const signRed = () => flat(0x7c1a12, 0.7)
export const signYellow = () => flat(0xa8841c, 0.7)
export const signInk = () => flat(0x1b1b18, 0.8)
