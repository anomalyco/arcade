import { homedir } from "node:os"
import { join } from "node:path"

export const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Pipeline scratch (source images, raw GLBs, Blender output) lives outside the repo. */
export const workDir = (): string => arg("--work") ?? process.env.PROPS_WORK ?? join(homedir(), "code/home/artifacts/2026-10-16-props")

/** The TRELLIS.2 Apple Silicon install (shivampkumar/trellis-mac with the Metal stack, BiRefNet and normal fixes). */
export const trellisHome = (): string => process.env.TRELLIS_HOME ?? join(homedir(), "code/experiments/image-to-3d/trellis2-mac")
