import { resolveWgsl, wgslSnippet } from "@arcade/kit/gpu/wgsl"
import { asciiTerminalStyle } from "./ascii-terminal"
import { comicCelStyle } from "./comic-cel"
import { hotlineNeonStyle } from "./hotline-neon"
import { inkHatchStyle } from "./ink-hatch"
import { oneBitStyle } from "./one-bit"
import { papercraftStyle } from "./papercraft"
import { tacticalBreachStyle } from "./tactical-breach"
import { tinyPixelStyle } from "./tiny-pixel"
import { STYLE_ORDER, isStyleId, type StyleId, type StylePresentationModule, type StyleRecipe } from "./types"
import { watercolourStyle } from "./watercolour"
import { STYLE_UNIFORM_FLOATS, StyleUniformsStruct, styleWgslCommonSnippet } from "./wgsl-common"

export * from "./types"
export { STYLE_UNIFORM_FLOATS, StyleUniformsStruct }

export const STYLE_MODULES: Readonly<Record<StyleId, StylePresentationModule>> = {
  "tiny-pixel": tinyPixelStyle,
  "one-bit": oneBitStyle,
  "comic-cel": comicCelStyle,
  papercraft: papercraftStyle,
  "ink-hatch": inkHatchStyle,
  watercolour: watercolourStyle,
  "tactical-breach": tacticalBreachStyle,
  "hotline-neon": hotlineNeonStyle,
  "ascii-terminal": asciiTerminalStyle,
}

export const STYLE_LIST: readonly StylePresentationModule[] = STYLE_ORDER.map(id => STYLE_MODULES[id])

export function resolveStyleId(raw: unknown): StyleId | null {
  if (typeof raw === "number") {
    const idx = Math.round(raw)
    if (idx >= 1 && idx <= STYLE_ORDER.length) return STYLE_ORDER[idx - 1]!
    if (idx >= 0 && idx < STYLE_ORDER.length) return STYLE_ORDER[idx]!
    return null
  }
  if (typeof raw !== "string") return null
  const q = raw.trim().toLowerCase()
  if (isStyleId(q)) return q
  if (/^[1-9]$/.test(q)) return STYLE_ORDER[Number(q) - 1] ?? null
  for (const m of STYLE_LIST) {
    if (m.id.includes(q) || m.name.toLowerCase().includes(q) || m.shortName.toLowerCase().includes(q)) {
      return m.id
    }
  }
  return null
}

export function createDefaultStyleStates(): Record<StyleId, StyleRecipe> {
  const out = {} as Record<StyleId, StyleRecipe>
  for (const m of STYLE_LIST) {
    out[m.id] = { ...m.defaults }
  }
  return out
}

export function buildStylePostShaderWgsl(): string {
  const moduleSnippets = STYLE_LIST.map(m => wgslSnippet(`style-mod-${m.id}`, m.wgsl, [styleWgslCommonSnippet]))
  const rootSnippet = wgslSnippet(
    "style-playground-post-root",
    /* wgsl */ `
@fragment fn fsStyle(o: VSOut) -> @location(0) vec4f {
  let uv = clamp(o.uv, vec2f(0.001), vec2f(0.999));
  let idx = i32(round(SU.params0.x));
  var rgb = vec3f(0.0);
  switch (idx) {
    case 0: { rgb = evalStyle_0(uv); }
    case 1: { rgb = evalStyle_1(uv); }
    case 2: { rgb = evalStyle_2(uv); }
    case 3: { rgb = evalStyle_3(uv); }
    case 4: { rgb = evalStyle_4(uv); }
    case 5: { rgb = evalStyle_5(uv); }
    case 6: { rgb = evalStyle_6(uv); }
    case 7: { rgb = evalStyle_7(uv); }
    case 8: { rgb = evalStyle_8(uv); }
    default: { rgb = evalStyle_0(uv); }
  }
  return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), 1.0);
}
`,
    [styleWgslCommonSnippet, ...moduleSnippets],
  )
  return resolveWgsl(rootSnippet)
}
