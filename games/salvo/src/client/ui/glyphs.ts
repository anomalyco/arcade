import type { WeaponId } from "../../sim/weapons"

// Weapon glyphs on a 24x24 grid, drawn in currentColor.
const WEAPON_GLYPHS: Record<WeaponId, string> = {
  shell: `<g transform="rotate(40 12 12)"><path d="M12 2.5c2.6 2.2 3.6 5 3.6 8.2v7.6H8.4v-7.6c0-3.2 1-6 3.6-8.2z" fill="currentColor" fill-opacity=".22"/><path d="M12 2.5c2.6 2.2 3.6 5 3.6 8.2v7.6H8.4v-7.6c0-3.2 1-6 3.6-8.2zM8.4 11.5h7.2M8.4 18.3l-1.4 3h10l-1.4-3"/></g>`,
  cluster: `<circle cx="12" cy="6" r="2.3" fill="currentColor"/><circle cx="8" cy="12" r="2.3" fill="currentColor"/><circle cx="16" cy="12" r="2.3" fill="currentColor"/><circle cx="4.5" cy="18" r="2.3" fill="currentColor"/><circle cx="12" cy="18" r="2.3" fill="currentColor"/><circle cx="19.5" cy="18" r="2.3" fill="currentColor"/>`,
  mirv: `<path d="M12 21V11M12 11 5 4M12 11l7-7M12 11V3"/><path d="M5 4h3.2M5 4v3.2M19 4h-3.2M19 4v3.2M10 5l2-2 2 2"/><circle cx="12" cy="13" r="2" fill="currentColor"/>`,
  drill: `<path d="M8 3h8l-1 3H9z" fill="currentColor" fill-opacity=".35"/><path d="M8 3h8l-1 3H9zM9 6h6l-3 16z"/><path d="M9.6 9.5l4.6-1.2M10.3 13l3.2-.9M11 16.4l1.8-.5"/>`,
  napalm: `<path d="M12 22c-4.2 0-7-2.8-7-6.6 0-3.4 2.3-5.4 3.6-8.4.6 2 1.6 3 2.6 3.3C11 7 12.6 4.2 15 2c-.3 3.5 4 6.4 4 12.3 0 4.6-3 7.7-7 7.7z" fill="currentColor" fill-opacity=".22"/><path d="M12 22c-4.2 0-7-2.8-7-6.6 0-3.4 2.3-5.4 3.6-8.4.6 2 1.6 3 2.6 3.3C11 7 12.6 4.2 15 2c-.3 3.5 4 6.4 4 12.3 0 4.6-3 7.7-7 7.7z"/><path d="M12 22c-1.8 0-3-1.3-3-3 0-2 1.6-3 2.4-5 1 1.6 3.6 2.6 3.6 5 0 1.7-1.2 3-3 3z" fill="currentColor"/>`,
  gravity: `<path d="M12 12.2c0-1 1.4-1.4 2-.4.9 1.4-.6 3.2-2.4 3-2.6-.3-3.4-3.4-1.8-5.3 2-2.4 6-2 7.4.8 1.6 3.4-.6 7.4-4.4 7.9-4.6.6-8-3.6-7-8C6.7 5.6 11.2 3 15.6 4"/>`,
  builder: `<path d="M3 20h18M4 20v-4h6v4M10 20v-4h6v4M16 20v-4h4v4M7 16v-4h6v4M13 16v-4h6v4M10 12V8h6v4"/>`,
  airstrike: `<path d="M12 2.5c.9 0 1.4.9 1.4 2v5.2l7.6 4.4v2l-7.6-2.2v4.4l2.4 1.8v1.6L12 20.6l-3.8 1.1v-1.6l2.4-1.8v-4.4L3 16.1v-2l7.6-4.4V4.5c0-1.1.5-2 1.4-2z" fill="currentColor" fill-opacity=".25"/><path d="M12 2.5c.9 0 1.4.9 1.4 2v5.2l7.6 4.4v2l-7.6-2.2v4.4l2.4 1.8v1.6L12 20.6l-3.8 1.1v-1.6l2.4-1.8v-4.4L3 16.1v-2l7.6-4.4V4.5c0-1.1.5-2 1.4-2z"/>`,
  bouncer: `<circle cx="18" cy="6" r="3" fill="currentColor" fill-opacity=".3"/><circle cx="18" cy="6" r="3"/><path d="M2 21h20" /><path d="M3 9c1.5 6 3 12 3 12s1.6-6 4.5-6S15 21 15 21s.8-3 2-3" stroke-dasharray="2 1.6"/>`,
  buster: `<path d="M12 2v11M8.5 9.5 12 13l3.5-3.5"/><path d="M9.6 2h4.8" /><path d="M2 16h20M4.5 16l2 6M19.5 16l-2 6M8 19h8"/><path d="M12 13l-2.5 3M12 13l2.5 3"/>`,
  shield: `<path d="M12 2.5 4.5 5.5v6c0 4.8 3.2 8.4 7.5 10 4.3-1.6 7.5-5.2 7.5-10v-6z" fill="currentColor" fill-opacity=".2"/><path d="M12 2.5 4.5 5.5v6c0 4.8 3.2 8.4 7.5 10 4.3-1.6 7.5-5.2 7.5-10v-6zM12 6.5v11M8 10h8"/>`,
  teleport: `<path d="M12 4l4 8-4 8-4-8z" fill="currentColor" fill-opacity=".3"/><path d="M12 4l4 8-4 8-4-8z"/><path d="M5 7.5A9 9 0 0 0 5 16.5M19 7.5a9 9 0 0 1 0 9M2.6 5a12.5 12.5 0 0 0 0 14M21.4 5a12.5 12.5 0 0 1 0 14"/>`,
}

export function weaponGlyph(id: WeaponId, size = 24): string {
  return `<svg class="glyph" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${WEAPON_GLYPHS[id]}</svg>`
}

export function weaponGlyphInner(id: WeaponId): string {
  return WEAPON_GLYPHS[id]
}


export const CHECK = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6"/></svg>`
export const LOCK = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>`
export const CART = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h3l2.6 12.2a1.5 1.5 0 0 0 1.5 1.2h9.4a1.5 1.5 0 0 0 1.4-1.1L22 7H6"/><circle cx="9.5" cy="20.5" r="1.4"/><circle cx="18" cy="20.5" r="1.4"/></svg>`
export const ARROW_R = `<svg viewBox="0 0 34 16" width="34" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8h29M24 1.5 31 8l-7 6.5"/></svg>`
