/**
 * Pencil glyphs for materials and what they make, matching the corkboard sketches: 24×24 SVG strokes in
 * `currentColor`, so the field-craft strip reads by shape instead of words.
 */
const PATHS: Record<string, string> = {
  plank: '<path d="M3 15.5 19.5 5l1.5 2.5L4.5 18z"/><circle cx="6.5" cy="15" r=".6"/><circle cx="17.5" cy="8" r=".6"/>',
  scrap: '<path d="M4 17c3-1 4-5 7-5s3 3 6 2"/><path d="M14 6v5M17 5v5M11 7v3"/><path d="M13 6h2M16 5h2"/>',
  chem: '<path d="M8 4h3v3l2 2v10H6V9l2-2z"/><path d="M13 13c2-1 4 0 5 2l-2 4"/>',
  battery: '<rect x="7" y="6" width="10" height="14" rx="1"/><path d="M10 4h4v2h-4zM12 10v6M9 13h6"/>',
  bandage: '<circle cx="10" cy="12" r="6"/><circle cx="10" cy="12" r="2"/><path d="M16 12h5v3h-5"/>',
  noisemaker: '<circle cx="12" cy="13" r="6"/><path d="M12 13V9.5M12 13l2.5 1.5"/><circle cx="6.5" cy="6" r="2"/><circle cx="17.5" cy="6" r="2"/><path d="M8 19l-2 2M16 19l2 2"/>',
  "spiked-board": '<path d="M3 17 18 6l2 2.5L5 19.5z"/><path d="M14 8.5l-1.5-3M16.5 7l-1-3.5M11 11l-2-2.5M18.5 9.5l3-1"/>',
  reinforced: '<rect x="4" y="5" width="16" height="14"/><path d="M4 9l16 4M4 15l16-4"/><circle cx="7" cy="9.8" r=".6"/><circle cx="17" cy="12.2" r=".6"/>',
}

/** An inline pencil glyph for `item`, or a plain dot for anything without a sketch. */
export function itemIcon(item: string, size = 22): string {
  const body = PATHS[item] ?? '<circle cx="12" cy="12" r="3"/>'
  return `<svg class="glyph" data-item="${item}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}
