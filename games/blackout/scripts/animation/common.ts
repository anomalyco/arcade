import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

export const repoRoot = resolve(import.meta.dir, "../../../..")
export const blackoutRoot = resolve(import.meta.dir, "../..")
export const fixturesDir = join(import.meta.dir, "fixtures/mocap")

/** `--name value` and boolean `--flag` arguments; the first bare argument is the tag. */
export function parseArgs(argv: string[], defaults: { tag: string; out: string }) {
  const values: Record<string, string> = {}
  const flags = new Set<string>()
  let tag = defaults.tag
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith("--")) tag = a
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) values[a.slice(2)] = argv[++i]!
    else flags.add(a.slice(2))
  }
  if (values.tag) tag = values.tag
  const out = resolve(values.out ?? join(repoRoot, "captures/animation", defaults.out))
  mkdirSync(out, { recursive: true })
  return { tag, out, values, flags }
}

/** Reference walk and run mocap clips, fetched into fixtures/mocap on first use and checked by hash. */
const SOURCE = "https://raw.githubusercontent.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset/74ead3ba1ae4696404e6086233779f60de8bf9ef/dataset"
export const MOCAP = {
  walk: {
    file: "dataset-1_walk_normal_001.bvh",
    url: `${SOURCE}/Bandai-Namco-Research-Motiondataset-1/data/dataset-1_walk_normal_001.bvh`,
    sha256: "5764cebc2fedabf287880a7f25cb06753e1679675a02a6f033998de041ba8032",
  },
  run: {
    file: "dataset-2_run_normal_001.bvh",
    url: `${SOURCE}/Bandai-Namco-Research-Motiondataset-2/data/dataset-2_run_normal_001.bvh`,
    sha256: "3efb502ebf6245f3a644072fe24f24ccef6f7e35dad7efb5475b57f87801f423",
  },
} as const

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** Returns the BVH text, downloading it into the fixtures folder when it is missing. */
export async function loadMocap(clip: keyof typeof MOCAP, dir = fixturesDir): Promise<string> {
  const { file, url, sha256: expected } = MOCAP[clip]
  const path = join(dir, file)
  if (!existsSync(path)) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Could not download ${file} (${res.status}). Pass --bvh-dir with a local copy.`)
    const text = await res.text()
    if (sha256(text) !== expected) throw new Error(`${file} from ${url} does not match its pinned hash`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, text)
  }
  const text = readFileSync(path, "utf8")
  if (sha256(text) !== expected) throw new Error(`${path} does not match the pinned hash for ${file}`)
  return text
}
