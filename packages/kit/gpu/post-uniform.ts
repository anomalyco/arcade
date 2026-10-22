import { LOOK_UNIFORM_FLOATS } from "./look"

/** Game-specific post values follow the grade and Look blocks without aliasing either. */
export const POST_CUSTOM_OFFSET=8+LOOK_UNIFORM_FLOATS
export const POST_UNIFORM_FLOATS=POST_CUSTOM_OFFSET+4
export const customPostGradeWgsl=`struct Grade {
  frame:vec4f,
  look:vec4f,
  @size(${LOOK_UNIFORM_FLOATS*4}) reservedLook:vec4f,
  custom:vec4f,
}
@group(0) @binding(4) var<uniform> grade:Grade;`
