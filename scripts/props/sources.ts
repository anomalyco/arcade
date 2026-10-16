/** Product-shot prompts for each catalogue prop (`packages/kit/props/catalogue.ts`), in the RE-mansion palette. */

export const STYLE = [
  "Studio product photograph of exactly one object, a prop for a 1998-2002 Resident Evil pre-rendered mansion interior:",
  "old, worn and lightly dusty, in a palette of dark stained walnut, oxblood leather, tarnished brass, faded olive and burgundy fabric, yellowed cream enamel.",
  "Three-quarter view from the front-left and slightly above (about 25 degrees down), the whole object in frame with a generous margin, centred.",
  "Soft, even, shadowless light like a light tent, so colours read as flat albedo with no strong highlights.",
  "No cast shadow, no floor, no reflection, no props around it, plain pure white background. No text, no labels, no people.",
].join(" ")

export const SUBJECTS: Record<string, string> = {
  "chesterfield-sofa": "a long three-seat Chesterfield sofa in cracked oxblood leather with deep button tufting, rolled arms and short turned walnut feet",
  "leather-armchair": "a worn club armchair in cracked dark brown leather with a seat cushion, rolled arms and short wooden feet",
  "coffee-table": "a low rectangular dark walnut coffee table with turned legs and a lower shelf, a few scratches on the top",
  "bookcase": "a tall dark walnut bookcase with five shelves densely filled with old leather-bound books, some leaning, a carved cornice on top",
  "sideboard": "a long Victorian dark walnut sideboard with two cupboard doors, a row of drawers and brass handles, on short legs",
  "dining-table": "a rectangular dark walnut dining table with four turned legs, the top scuffed and stained",
  "dining-chair": "a single dark walnut dining chair with a carved back and a faded burgundy upholstered seat",
  "kitchen-counter": "a run of old kitchen base cabinets in painted cream wood with chipped paint, worn butcher-block worktop, a small enamel sink, brass handles",
  "fridge-1970s": "a 1970s refrigerator in yellowed cream enamel with rounded corners, a chrome handle and a small freezer door at the top, slightly rusty at the base",
  "stove": "a 1950s freestanding kitchen stove in chipped cream and black enamel with four burners, an oven door and a back panel with dials",
  "bed": "an old double bed with a tall dark carved walnut headboard and a low footboard, a rumpled faded olive bedspread and two pillows",
  "dresser": "a dark walnut chest of drawers with six drawers and tarnished brass handles, on short turned feet",
  "nightstand": "a small dark walnut nightstand with one drawer and a lower open shelf, brass knob",
  "grandfather-clock": "a tall dark walnut grandfather clock with a brass clock face, a glass door over the pendulum and a carved hood",
  "upright-piano": "an old upright piano in dark walnut with the key lid open, yellowed ivory keys and brass candle holders",
  "tv-set": "a 1970s television set in a wooden cabinet with a curved grey screen, dials and a speaker grille, on four short legs",
  "radiator": "an old cast-iron column radiator painted cream with flaking paint and rust spots, on small feet",
  "table-lamp": "a brass table lamp with a pleated faded cream fabric shade",
  "potted-plant": "a cracked terracotta pot holding a dead shrub whose dried brown foliage forms one dense, rounded, solid-looking clump above the rim, no thin stems or fronds sticking out",
  "wooden-crate": "a weathered wooden shipping crate with plank sides and stencil-free plain wood",
  "cardboard-boxes": "two stacked old cardboard moving boxes, both closed with the flaps taped shut, boxy and slightly dented, brown tape",
  "book-stack": "a neat stack of four thick, closed old hardback books lying flat, square edges aligned, worn spines in brown, burgundy and green",
  "bottles": "three old glass bottles standing together, dark green, brown and clear, one with a cork",
  "typewriter": "a chunky old black manual typewriter with a solid boxy body, the keys forming a dense stepped block, no paper, no thin levers sticking out",
  "rotary-phone": "a chunky black 1960s rotary dial telephone with a solid rounded body and the thick handset resting on top, no cord",
  "plate-stack": "a neat stack of six thick, chipped white china plates, no cup",
}

/** Small props whose first pictures had thin parts TRELLIS.2 and the cleanup shredded: ask for closed, chunky forms. */
const CHUNKY = new Set(["potted-plant", "cardboard-boxes", "book-stack", "typewriter", "rotary-phone", "plate-stack"])
const CHUNKY_STYLE = "Simple, chunky, closed solid shapes that read at a glance from above; no thin sheets, wires, gaps or loose parts."

export const promptFor = (id: string): string => {
  const subject = SUBJECTS[id]
  if (!subject) throw new Error(`no source prompt for ${id}`)
  return `${STYLE} The object: ${subject}.${CHUNKY.has(id) ? ` ${CHUNKY_STYLE}` : ""}`
}
