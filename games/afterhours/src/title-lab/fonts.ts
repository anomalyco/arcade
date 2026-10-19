// Title Lab candidates (Google Fonts, OFL/Apache; loaded by this dev-only page only). `axis` is the css2 family spec.

export type Candidate = { family: string; group: string; axis?: string; note?: string; local?: boolean }

export const GROUPS = ["Current", "Condensed grotesque & stencil", "Typewriter & mono", "Serif & dread", "Technical & DIN", "Hand & warped"] as const

export const FONTS: Candidate[] = [
  { family: "Helvetica Neue", group: "Current", local: true, note: "the menu today" },

  { family: "Oswald", group: "Condensed grotesque & stencil", axis: "wght@200..700" },
  { family: "Bebas Neue", group: "Condensed grotesque & stencil" },
  { family: "Archivo Black", group: "Condensed grotesque & stencil" },
  { family: "Anton", group: "Condensed grotesque & stencil" },
  { family: "Big Shoulders Stencil", group: "Condensed grotesque & stencil", axis: "wght@100..900" },
  { family: "Saira Stencil One", group: "Condensed grotesque & stencil" },
  { family: "Stardos Stencil", group: "Condensed grotesque & stencil", axis: "wght@400;700" },
  { family: "Allerta Stencil", group: "Condensed grotesque & stencil" },

  { family: "Special Elite", group: "Typewriter & mono" },
  { family: "Courier Prime", group: "Typewriter & mono", axis: "wght@400;700" },
  { family: "IBM Plex Mono", group: "Typewriter & mono", axis: "wght@100;200;300;400;500;600;700" },
  { family: "VT323", group: "Typewriter & mono" },
  { family: "Share Tech Mono", group: "Typewriter & mono" },
  { family: "Major Mono Display", group: "Typewriter & mono" },
  { family: "Space Mono", group: "Typewriter & mono", axis: "wght@400;700" },

  { family: "Cormorant", group: "Serif & dread", axis: "wght@300..700" },
  { family: "EB Garamond", group: "Serif & dread", axis: "wght@400..800" },
  { family: "Libre Caslon Display", group: "Serif & dread" },
  { family: "Playfair Display SC", group: "Serif & dread", axis: "wght@400;700;900" },
  { family: "Old Standard TT", group: "Serif & dread", axis: "wght@400;700" },
  { family: "Cinzel", group: "Serif & dread", axis: "wght@400..900" },

  { family: "Barlow Condensed", group: "Technical & DIN", axis: "wght@100;200;300;400;500;600;700;800;900" },
  { family: "Rajdhani", group: "Technical & DIN", axis: "wght@300;400;500;600;700" },
  { family: "Chakra Petch", group: "Technical & DIN", axis: "wght@300;400;500;600;700" },
  { family: "Michroma", group: "Technical & DIN" },
  { family: "Orbitron", group: "Technical & DIN", axis: "wght@400..900", note: "sparingly" },
  { family: "Syncopate", group: "Technical & DIN", axis: "wght@400;700" },

  { family: "Rubik Glitch", group: "Hand & warped" },
  { family: "Nosifer", group: "Hand & warped" },
  { family: "Permanent Marker", group: "Hand & warped", note: "probably not" },
]

export function loadFonts() {
  for (const f of FONTS) {
    if (f.local) continue
    const link = document.createElement("link")
    link.rel = "stylesheet"
    link.href = `https://fonts.googleapis.com/css2?family=${f.family.replace(/ /g, "+")}${f.axis ? `:${f.axis}` : ""}&display=swap`
    document.head.append(link)
  }
}
