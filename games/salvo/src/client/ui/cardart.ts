import type { WeaponId } from "../../sim/weapons"
import { weaponGlyphInner } from "./glyphs"

// Small illustrated header for each armory card: launch point, glowing arc and a
// weapon-specific impact signature, on a 240x84 canvas. Drawn in currentColor.

const GROUND = 76

function sparks(cx: number, cy: number, n: number, r: number, seed: number): string {
  let out = ""
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 9301 + 49297) % 233280
    const a = Math.PI + (s / 233280) * Math.PI
    s = (s * 9301 + 49297) % 233280
    const d = r * (0.4 + (s / 233280) * 0.8)
    const x = cx + Math.cos(a) * d
    const y = cy + Math.sin(a) * d
    out += `<line x1="${(cx + Math.cos(a) * d * 0.55).toFixed(1)}" y1="${(cy + Math.sin(a) * d * 0.55).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`
  }
  return `<g stroke-width="1.3" opacity=".9">${out}</g>`
}

let gid = "cg"

function burst(cx: number, cy: number, r: number, seed: number): string {
  return `<circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="url(#${gid})" stroke="none"/><circle cx="${cx}" cy="${cy}" r="${r * 0.18}" fill="#fff" stroke="none"/>${sparks(cx, cy, 12, r, seed)}`
}

const ARC = (x1: number, y1: number, cx: number, cy: number, x2: number, y2: number, dash = true) =>
  `<path d="M${x1} ${y1}Q${cx} ${cy} ${x2} ${y2}" stroke-width="1.8" ${dash ? 'stroke-dasharray="5 4"' : ""}/>`

const LAUNCH = `<circle cx="16" cy="${GROUND - 4}" r="3" fill="currentColor" stroke="none"/>`

function art(id: WeaponId): string {
  switch (id) {
    case "cluster":
      return `${ARC(16, 72, 70, -4, 116, 26)}
        ${[150, 168, 186, 204, 222].map((x, i) => `<path d="M116 26Q${(116 + x) / 2} ${14 + i * 2} ${x} ${66 - (i % 2) * 4}" stroke-width="1.2" stroke-dasharray="3 3" opacity=".8"/>`).join("")}
        ${[150, 168, 186, 204, 222].map((x, i) => `<circle cx="${x}" cy="${66 - (i % 2) * 4}" r="3.2" fill="currentColor" stroke="none"/><circle cx="${x}" cy="${66 - (i % 2) * 4}" r="1.2" fill="#fff" stroke="none"/>`).join("")}`
    case "mirv":
      return `${ARC(16, 72, 66, -4, 112, 22)}
        ${[[160, 70], [190, 62], [224, 70]].map(([x, y]) => `<path d="M112 22Q${(112 + x) / 2 + 6} ${10} ${x} ${y}" stroke-width="1.3" stroke-dasharray="4 3"/>${burst(x, y, 14, x)}`).join("")}`
    case "drill":
      return `${ARC(16, 72, 90, -18, 168, 52)}
        <path d="M128 ${GROUND - 14}h112" stroke-width="1" opacity=".5"/>
        <path d="M168 52 L196 80" stroke-width="5" stroke-linecap="round" opacity=".55"/>
        <g transform="translate(160 32) scale(1.4)" stroke-width="1.4">${weaponGlyphInner("drill")}</g>
        ${sparks(170, 60, 10, 22, 7)}`
    case "napalm":
      return `${ARC(16, 72, 90, -14, 170, 66)}
        <path d="M128 ${GROUND - 2}h112" stroke-width="1" opacity=".5"/>
        ${[0, 1, 2, 3, 4, 5, 6].map((i) => {
          const x = 140 + i * 13
          const hgt = 14 + ((i * 37) % 5) * 5 - Math.abs(i - 3) * 2
          return `<path d="M${x - 6} ${GROUND - 2}Q${x - 3} ${GROUND - hgt * 0.6} ${x} ${GROUND - 2 - hgt}Q${x + 3} ${GROUND - hgt * 0.6} ${x + 6} ${GROUND - 2}" fill="currentColor" fill-opacity=".25" stroke-width="1.2"/>`
        }).join("")}`
    case "gravity":
      return `${ARC(16, 72, 90, -14, 176, 40)}
        ${[0, 1, 2].map((k) => {
          let d = ""
          for (let a = 0; a < Math.PI * 3.2; a += 0.2) {
            const r = 2 + a * 3.4 + k * 1.5
            const aa = a + k * 2.1
            d += `${d ? "L" : "M"}${(176 + Math.cos(aa) * r).toFixed(1)} ${(40 + Math.sin(aa) * r * 0.62).toFixed(1)}`
          }
          return `<path d="${d}" stroke-width="${1.6 - k * 0.3}" opacity="${1 - k * 0.2}"/>`
        }).join("")}
        <circle cx="176" cy="40" r="3" fill="#fff" stroke="none"/>`
    case "builder":
      return `${ARC(16, 72, 80, -8, 160, 60)}
        <path d="M120 ${GROUND}h120" stroke-width="1" opacity=".5"/>
        ${[[154, 66], [168, 66], [182, 66], [196, 66], [161, 56], [175, 56], [189, 56], [168, 46], [182, 46], [175, 36]].map(([x, y]) => `<rect x="${x}" y="${y}" width="13" height="9" fill="currentColor" fill-opacity=".18" stroke-width="1.3"/>`).join("")}`
    case "airstrike":
      return `<g transform="translate(36 6) scale(1.3)" stroke-width="1.3">${weaponGlyphInner("airstrike")}</g>
        <g transform="translate(86 14) scale(.9) rotate(20 12 12)" stroke-width="1.4">${weaponGlyphInner("airstrike")}</g>
        <path d="M60 18h170" stroke-width="1" stroke-dasharray="2 5" opacity=".6"/>
        ${[130, 158, 186, 214].map((x, i) => `<path d="M${x - 12} 20L${x} ${GROUND - 6}" stroke-width="1.2" stroke-dasharray="3 3" opacity=".7"/>${burst(x, GROUND - 6, 13, i + 3)}`).join("")}`
    case "bouncer":
      return `${ARC(16, 72, 60, 0, 104, 70)}${ARC(104, 70, 134, 22, 164, 70)}${ARC(164, 70, 184, 40, 204, 70)}
        <path d="M90 ${GROUND - 4}h150" stroke-width="1" opacity=".5"/>
        ${burst(214, 62, 18, 11)}`
    case "buster":
      return `${ARC(16, 72, 80, -20, 164, 30)}
        <path d="M164 30L174 70" stroke-width="3.5"/>
        <path d="M128 50h112M134 50l6 26M228 50l-6 26" stroke-width="1.2" opacity=".6"/>
        ${burst(176, 72, 22, 5)}`
    case "shield":
      return `${LAUNCH}<path d="M-8 74A26 26 0 0 1 44 74" stroke-width="2" fill="currentColor" fill-opacity=".14"/>
        <path d="M-2 74A20 20 0 0 1 38 74" stroke-width="1" opacity=".6"/>
        <path d="M70 10Q120 0 150 40" stroke-width="1.3" stroke-dasharray="4 4" opacity=".55"/>
        <path d="M150 40L60 60" stroke-width="1.3" stroke-dasharray="2 4" opacity=".4"/>
        <g transform="translate(172 18) scale(2)" stroke-width="1.3">${weaponGlyphInner("shield")}</g>`
    case "teleport":
      return `${ARC(16, 72, 90, -10, 176, 64)}
        ${[1, 2, 3].map((k) => `<ellipse cx="176" cy="64" rx="${k * 10}" ry="${k * 3.2}" stroke-width="1.2" opacity="${1.1 - k * 0.25}"/>`).join("")}
        <path d="M176 64V30" stroke-width="2.2"/><circle cx="176" cy="28" r="3" fill="#fff" stroke="none"/>`
    default:
      return `${ARC(16, 72, 90, -14, 176, 66)}${burst(176, 66, 26, 9)}`
  }
}

export function cardArt(id: WeaponId): string {
  gid = `cg-${id}`
  return `<svg class="card-art" viewBox="0 0 240 84" preserveAspectRatio="xMinYMid meet" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <defs><radialGradient id="${gid}"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".35" stop-color="currentColor" stop-opacity=".8"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></radialGradient></defs>
    ${id === "shield" ? "" : LAUNCH}${art(id)}
  </svg>`
}
