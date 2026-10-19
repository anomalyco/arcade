/**
 * Pencil glyphs for materials and what they make, matching the corkboard sketches: 24×24 SVG strokes in
 * `currentColor`, so the recipe panel reads by shape first.
 */
const PATHS: Record<string, string> = {
  plank: '<path d="M3 15.5 19.5 5l1.5 2.5L4.5 18z"/><circle cx="6.5" cy="15" r=".6"/><circle cx="17.5" cy="8" r=".6"/>',
  scrap: '<path d="M4 17c3-1 4-5 7-5s3 3 6 2"/><path d="M14 6v5M17 5v5M11 7v3"/><path d="M13 6h2M16 5h2"/>',
  chem: '<path d="M8 4h3v3l2 2v10H6V9l2-2z"/><path d="M13 13c2-1 4 0 5 2l-2 4"/>',
  battery: '<rect x="7" y="6" width="10" height="14" rx="1"/><path d="M10 4h4v2h-4zM12 10v6M9 13h6"/>',
  bandage: '<circle cx="10" cy="12" r="6"/><circle cx="10" cy="12" r="2"/><path d="M16 12h5v3h-5"/>',
  noisemaker: '<circle cx="12" cy="13" r="6"/><path d="M12 13V9.5M12 13l2.5 1.5"/><circle cx="6.5" cy="6" r="2"/><circle cx="17.5" cy="6" r="2"/><path d="M8 19l-2 2M16 19l2 2"/>',
  bottle: '<path d="M4 15.5 13 10.5l3 .2 4-2.4 1 1.8-4 2.4-1.4 2.6-9 5z"/><path d="M7.5 13.6l2 3.4"/>',
  cans: '<path d="M3 7h18"/><path d="M7 7v2M12 7v2M17 7v2"/><rect x="5" y="9" width="4" height="6" rx=".6"/><rect x="10" y="9" width="4" height="6" rx=".6"/><rect x="15" y="9" width="4" height="6" rx=".6"/>',
  "spiked-board": '<path d="M3 17 18 6l2 2.5L5 19.5z"/><path d="M14 8.5l-1.5-3M16.5 7l-1-3.5M11 11l-2-2.5M18.5 9.5l3-1"/>',
  reinforced: '<rect x="4" y="5" width="16" height="14"/><path d="M4 9l16 4M4 15l16-4"/><circle cx="7" cy="9.8" r=".6"/><circle cx="17" cy="12.2" r=".6"/>',
  // Fire & explosives (AR-62): also the hotbar glyphs for these items.
  flamethrower: '<rect x="2.5" y="10" width="4.5" height="9" rx="2"/><path d="M4.75 10V8"/><path d="M7 14.5h2.5l1.5-2h6v2.5h-6"/><path d="M17.5 12c1.6-.4 2.6-1.8 2.2-3.7 1.4 1 2 2.6 1.2 4.3-.6 1.3-2 1.8-3.4 1.6"/>',
  dynamite: '<rect x="5" y="10" width="4" height="10" rx="1"/><rect x="10" y="10" width="4" height="10" rx="1"/><rect x="15" y="10" width="4" height="10" rx="1"/><path d="M4.5 14h15"/><path d="M12 10c0-3 2-4.5 4-5.5"/><path d="M17.5 2.5l.6 1.4M20 3.6l-1.3.8"/>',
  firecrackers: '<path d="M3 21C8 18 9 12 13 11s5-5 8-8"/><path d="M4.5 16.5l3 3M8.5 11.5l3 3.2M13.5 7.8l2.8 3.2"/><path d="M5.8 15.2l3 3M10 10.5l2.8 3M15 6.5l2.6 3"/>',
  molotov: '<path d="M10 9V5.5h4V9l2 3v8H8v-8z"/><path d="M8 14.5h8"/><path d="M12 5.5c-1.2-1.4-.3-3 1-3.5-.3 1.2.8 1.8.4 3"/>',
  "flare-gun": '<path d="M3 7h13.5v5H10l-1.5 7H4.5L6 12H3z"/><path d="M16.5 8.5h3.5M16.5 10.5h3.5"/><path d="M8.5 12l1 2.5h2"/>',
  "bear-trap": '<path d="M4 15a8 8 0 0 1 16 0"/><path d="M4 15l2-3 2 2.5 2-3 2 2.5 2-3 2 2.5 2-3 2 4"/><path d="M3 15h18M12 15v5M9 20h6"/>',
  fuel: '<path d="M5 9l3.5-4H17a2 2 0 0 1 2 2v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M8.5 5V3H12"/><path d="M8.5 11.5l7 5.5M15.5 11.5l-7 5.5"/>',
  "pressure-tank": '<rect x="7" y="6" width="10" height="15" rx="5"/><path d="M10 6V3.5h4V6"/><circle cx="12" cy="12" r="2.2"/><path d="M12 12l1.2-1.2"/>',
  "bolt-cutters": '<path d="M9 3l1.6 8M15 3l-1.6 8"/><circle cx="12" cy="12" r="1.3"/><path d="M10.8 13L6 21M13.2 13L18 21"/><path d="M5 19.5l2 1.5M19 19.5l-2 1.5"/>',
}

/** Whether `item` has its own pencil glyph. */
export const hasItemIcon = (item: string): boolean => item in PATHS

/** An inline pencil glyph for `item`, or a plain dot for anything without a sketch. */
export function itemIcon(item: string, size = 22): string {
  const body = PATHS[item] ?? '<circle cx="12" cy="12" r="3"/>'
  return `<svg class="glyph" data-item="${item}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}
