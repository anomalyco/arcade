#!/usr/bin/env bun
/**
 * Item portraits for the Attaché Case (AR-94, D-46): one painted, lit portrait per item, at its shape in the case.
 *
 *   bun scripts/item-portraits.ts                 # generate what is missing, then process everything
 *   bun scripts/item-portraits.ts --only pistol,ammo --force
 *   bun scripts/item-portraits.ts --process       # re-crop and re-encode the cached paintings, no requests
 *   bun scripts/item-portraits.ts --dry-run       # print the prompts
 *
 * Each item is painted by an image model (gpt-image-1.5, transparent background) from one locked style prompt plus a
 * line about the object, so the set shares a light direction (warm key from the upper left), palette and brushwork.
 * The painting is cached in `~/.cache/arcade/item-portraits/` (raw PNGs are big and not committed; ITEM_PORTRAITS_CACHE
 * moves it); processing trims it to the object, fits it into its footprint (cells across × down from
 * `shared/progression/shapes.ts`, exactly 128 px a cell, 9 px margin) and writes `src/portraits/<id>.webp` and the URL
 * table `portraits/index.ts`. Without a cached painting it reprocesses the committed WebP. The drop shadow is CSS.
 * `tests/inventory-art.test.ts` checks every portrait's size and that the painted object's aspect matches its shape:
 * when one fails, repaint it with a line that says how long it is, or change its shape.
 *
 * To restyle the set, change STYLE and run with --force; to fix one item, change its line and run --only id --force.
 * Requests read OPENAI_API_KEY, or 1Password (op://Anomaly/OpenAI API Key/credential).
 */
import { mkdir, readdir, rm } from "node:fs/promises"
import { parseArgs } from "node:util"
import sharp from "sharp"
import { ITEMS } from "../shared/progression/catalog"
import { ITEM_SHAPES } from "../shared/progression/shapes"

const ROOT = new URL("..", import.meta.url).pathname
const RAW = process.env.ITEM_PORTRAITS_CACHE ?? `${process.env.HOME}/.cache/arcade/item-portraits`
const OUT = `${ROOT}src/portraits`
const CELL_PX = 128
/** Margin on every side, in pixels: the same at every shape, so a 1×1 and a 4×1 sit alike on the grid. */
const PAD = Math.round(CELL_PX * 0.07)

const STYLE = [
  "Inventory item portrait for a gritty survival-horror game, hand-painted in the manner of classic late-1990s dark",
  "action-RPG inventory art crossed with the item renders in a survival-horror attaché case: richly detailed,",
  "slightly painterly brushwork, believable proportions. Exactly one object, the whole object visible, filling the",
  "frame with a small margin, seen from slightly above at a gentle three-quarter angle. Lighting: one warm key light",
  "from the upper left, a soft cool fill from the right and a thin rim light along the right edges, with soft ambient",
  "occlusion in crevices. Real materials with true colour and wear: scratched gunmetal, oiled wood grain, frayed",
  "canvas, chipped paint, scuffed leather, dusty glass. Muted, earthy palette with one or two saturated accents.",
  "Isolated on a fully transparent background with no ground, no cast shadow, no text, no numbers, no labels, no logos,",
  "no border, no frame, no people.",
].join(" ")

/** What each item is, as one concrete line. Long items are told which way they lie so they fill their cells. */
const OBJECTS: Record<string, string> = {
  fists: "a clenched fist with the knuckles wrapped in grubby white cloth tape, seen from the back of the hand",
  pistol: "a worn black 9mm semi-automatic police pistol with a checkered grip and a scuffed slide, muzzle pointing right",
  knife: "a short, broad utility knife with a chunky riveted dark wooden handle and a wide stained steel blade, blade to the right; the whole knife is only about twice as long as it is tall",
  hammer: "a claw hammer with a hickory handle and a rust-flecked steel head, the head at the right end",
  pipe: "a heavy length of dull grey lead pipe with threaded ends and a dent in the middle",
  crowbar: "a long steel crowbar with chipped red paint, the hooked claw at the right end",
  machete: "a machete with a long, slightly curved, nicked steel blade and a black grip wrapped in tape, blade to the right",
  bat: "a wooden baseball bat, pale ash with dark grip tape on the handle and a dark stain on the barrel, barrel on the right",
  "spiked-board": "a crude weapon: one long, narrow weathered pine plank, about eight times longer than it is wide, seen side-on, with rusty nails driven through near the right end and their points sticking up",
  axe: "a wood-splitting axe with a curved hickory handle and a dark forged head with a bright honed edge, the head at the right end",
  "fire-axe": "a firefighter's axe with a long varnished handle and a red-painted head with a pick on the back, the head at the right end",
  medkit: "a white enamelled metal first aid box with a red cross, rounded corners, a carry handle and chipped edges",
  bandage: "a rolled white cotton bandage, slightly unravelled, with a safety pin through the loose end",
  noisemaker: "a homemade noise lure: an old wind-up kitchen timer taped to a tin can, with a small battery and twisted wires",
  bottle: "an empty, stout dark green glass bottle with a short neck, dusty, catching the light, standing upright; it is half as wide as it is tall",
  cans: "three dented tin cans tied together on a length of twine, a homemade tripwire rattle",
  flare: "a red road flare with a black striker cap and a plain paper wrapper",
  food: "a short, wide, dented tin of canned beans with a plain faded paper wrapper, about as wide as it is tall",
  flamethrower: "a homemade flamethrower: a scuffed propane tank strapped by a rubber hose to a long welded steel nozzle with a trigger grip, nozzle to the right",
  dynamite: "two sticks of red dynamite bound with black electrical tape, a short fuse at the top, standing upright",
  firecrackers: "a squat bundle of red paper firecrackers lying on their side with braided green fuses, about as wide as it is tall",
  molotov: "a molotov cocktail: a clear glass bottle half full of amber liquid with a cloth rag stuffed in the neck, standing upright",
  "flare-gun": "an orange plastic emergency flare pistol with a wide barrel, muzzle pointing right",
  "bear-trap": "a rusty steel bear trap with its toothed jaws open and a short chain",
  baseball: "a scuffed white leather baseball with red stitching",
  brick: "a chipped red clay house brick",
  rock: "a fist-sized grey granite rock",
  "tin-can": "a single empty tin can lying on its side, its jagged lid bent open, about as wide as it is tall in the picture",
  ammo: "a small open cardboard box of 9mm pistol cartridges, brass rounds standing in rows",
  plank: "seen from directly above, three very long, narrow rough pine boards lying side by side and tied with twine at both ends, the bundle exactly four times as long as it is wide, grain and knots visible",
  scrap: "a small heap of scrap: bent nails, a hinge, washers and a twisted strip of sheet metal",
  chem: "a brown glass bottle of rubbing alcohol with a folded white cloth rag draped over it, standing upright",
  battery: "two worn D-cell flashlight batteries lying side by side",
  key: "a ring of old brass and steel house keys",
  fuel: "a red metal jerry can with a spout and a carry handle, standing upright",
  toolbox: "a red metal hardware toolbox with a top handle and latches, paint worn at the corners",
  "car-battery": "a black car battery with red and black terminal caps and a carry strap",
  "pressure-tank": "a dented steel propane pressure tank with a brass valve on top, standing upright",
  "bolt-cutters": "a pair of long bolt cutters lying flat and closed, two straight steel handles with red rubber grips on the left and short heavy steel jaws on the right, seen from above",
  "school-bag": "a child's blue canvas school backpack with zips, a sewn-on patch and worn straps",
  attache: "a black leather attaché case with brass latches and a handle, scuffed at the corners",
  "hiking-pack": "a large olive-green hiking backpack with straps, buckles and a rolled sleeping mat strapped on top, standing upright",
  duffel: "a long olive canvas military duffel bag with webbing straps and a handle",
  pouch: "a small khaki canvas utility pouch with a snap flap and a belt loop",
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  strict: true,
  options: { only: { type: "string" }, force: { type: "boolean" }, process: { type: "boolean" }, "dry-run": { type: "boolean" }, quality: { type: "string" } },
})

const ids = ITEMS.filter((d) => d.tag !== "knowledge").map((d) => d.id)
for (const id of ids) if (!OBJECTS[id] || !ITEM_SHAPES[id]) throw Error(`${id}: needs a line in OBJECTS and a shape in shapes.ts`)
const only = values.only ? new Set(values.only.split(",").map((s) => s.trim())) : null
const selected = ids.filter((id) => !only || only.has(id))

function promptFor(id: string): { prompt: string; size: string } {
  const { w, h } = ITEM_SHAPES[id]!
  const lie = w > h ? "It lies horizontally, its long side running left to right across the whole frame." : h > w ? "It stands upright, its long side running top to bottom." : ""
  const size = w / h >= 1.25 ? "1536x1024" : h / w >= 1.25 ? "1024x1536" : "1024x1024"
  return { prompt: `${STYLE} The object: ${OBJECTS[id]}. ${lie}`.trim(), size }
}

if (values["dry-run"]) {
  for (const id of selected) console.log(`${id} ${JSON.stringify(ITEM_SHAPES[id])} ${promptFor(id).size}\n  ${OBJECTS[id]}`)
  process.exit(0)
}

await mkdir(RAW, { recursive: true })
await mkdir(OUT, { recursive: true })

const keyRef = "op://Anomaly/OpenAI API Key/credential"
let key = process.env.OPENAI_API_KEY ?? ""
const readKey = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" })
  return r.exitCode === 0 ? r.stdout.toString().trim() : ""
}

async function paint(id: string): Promise<void> {
  const file = `${RAW}/${id}.png`
  if (!values.force && ((await Bun.file(file).exists()) || (await Bun.file(`${OUT}/${id}.webp`).exists()))) return
  key ||= readKey(["2password", "read", keyRef]) || readKey(["op", "read", keyRef])
  if (!key) throw Error(`No OpenAI key: set OPENAI_API_KEY or sign in to 1Password (${keyRef})`)
  const { prompt, size } = promptFor(id)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now()
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-1.5", prompt, n: 1, size, quality: values.quality ?? "high", background: "transparent", output_format: "png" }),
    })
    const text = await res.text()
    if (res.ok) {
      const b64 = (JSON.parse(text) as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json
      if (!b64) throw Error(`${id}: no image in the response`)
      await Bun.write(file, Buffer.from(b64, "base64"))
      console.log(`${id}: painted ${size} in ${Math.round((Date.now() - started) / 1000)}s`)
      return
    }
    console.error(`${id}: HTTP ${res.status} ${text.slice(0, 200)} (attempt ${attempt})`)
    if (res.status < 500 && res.status !== 429) break
    await Bun.sleep(4000 * attempt)
  }
  throw Error(`${id}: not painted`)
}

/** Trims the painting to the object, fits it into its footprint with a margin, and writes the WebP (exactly W × H). */
async function process1(id: string): Promise<void> {
  const raw = `${RAW}/${id}.png`
  const committed = `${OUT}/${id}.webp`
  const source = (await Bun.file(raw).exists()) ? raw : (await Bun.file(committed).exists()) ? Buffer.from(await Bun.file(committed).arrayBuffer()) : null
  if (!source) return
  const { w, h } = ITEM_SHAPES[id]!
  const W = w * CELL_PX
  const H = h * CELL_PX
  const trimmed = await sharp(source).ensureAlpha().trim({ threshold: 8 }).toBuffer()
  const fitted = await sharp(trimmed)
    .resize({ width: W - PAD * 2, height: H - PAD * 2, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: "lanczos3" })
    .toBuffer()
  await sharp(fitted)
    .extend({ top: PAD, bottom: PAD, left: PAD, right: PAD, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 86, alphaQuality: 90, effort: 6 })
    .toFile(committed)
}

const queue = [...selected]
const failed: string[] = []
if (!values.process) {
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) await paint(id).catch((e: Error) => (failed.push(id!), console.error(e.message)))
    }),
  )
}
for (const id of selected) await process1(id)

// The URL table: static `new URL` per portrait so Vite bundles each one (and the Lab, which bundles this game, too).
const have = new Set((await readdir(OUT)).filter((f) => f.endsWith(".webp")).map((f) => f.slice(0, -5)))
for (const f of await readdir(OUT)) if (f.endsWith(".webp") && !ids.includes(f.slice(0, -5))) await rm(`${OUT}/${f}`)
const rows = ids.filter((id) => have.has(id)).map((id) => `  ${JSON.stringify(id)}: new URL(${JSON.stringify(`./${id}.webp`)}, import.meta.url).href,`)
await Bun.write(
  `${OUT}/index.ts`,
  `// Generated by scripts/item-portraits.ts: do not edit. One painted portrait per item, at its shape in the case.\nexport const PORTRAITS: Readonly<Record<string, string>> = {\n${rows.join("\n")}\n}\n\n/** Pixels per case cell in every portrait. */\nexport const PORTRAIT_CELL_PX = ${CELL_PX}\n`,
)
console.log(`${have.size}/${ids.length} portraits in src/portraits${failed.length ? `; failed: ${failed.join(", ")}` : ""}`)
if (failed.length) process.exit(1)
