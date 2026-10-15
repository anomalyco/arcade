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
  walkTired: {
    file: "dataset-1_walk_tired_001.bvh",
    url: `${SOURCE}/Bandai-Namco-Research-Motiondataset-1/data/dataset-1_walk_tired_001.bvh`,
    sha256: "c23ae74ce470c3588bd12232fdeae0c5001b736bdf1234c1873aec26723c40c1",
  },
  walkOld: {
    file: "dataset-1_walk_old_002.bvh",
    url: `${SOURCE}/Bandai-Namco-Research-Motiondataset-1/data/dataset-1_walk_old_002.bvh`,
    sha256: "40e133e29c4f954a40bbed88e9132088aad3595bc6772288449c9cc86d005691",
  },
  walkExhausted: {
    file: "dataset-2_walk_exhausted_001.bvh",
    url: `${SOURCE}/Bandai-Namco-Research-Motiondataset-2/data/dataset-2_walk_exhausted_001.bvh`,
    sha256: "f5bdb63830b6656ae88c872b65056622a2a5211cfecf288889ac1d7e95d2231f",
  },
  runCrouch: {
    file: "dataset-1_dash_not-confident_001.bvh",
    url: `${SOURCE}/Bandai-Namco-Research-Motiondataset-1/data/dataset-1_dash_not-confident_001.bvh`,
    sha256: "0cc2713c90c6760aa5dcdef8bc9f556cd110eb72c3e6a733dfed00383b9118c1",
  },
  runTired: {
    file: "dataset-1_dash_tired_001.bvh",
    url: `${SOURCE}/Bandai-Namco-Research-Motiondataset-1/data/dataset-1_dash_tired_001.bvh`,
    sha256: "3d006956b32dbe230e162ffc0e2104e5d41bbb8bd537c67d5fa4ee340358589d",
  },
  runOld: {
    file: "dataset-1_run_old_001.bvh",
    url: `${SOURCE}/Bandai-Namco-Research-Motiondataset-1/data/dataset-1_run_old_001.bvh`,
    sha256: "1985df3f564adc8de91bff9628978c2127b2fc3adcb1a791aac468c6b7bdc12f",
  },
  walkLeft: {
    file: "dataset-1_walk-left_normal_001.bvh",
    url: `${SOURCE}/Bandai-Namco-Research-Motiondataset-1/data/dataset-1_walk-left_normal_001.bvh`,
    sha256: "26ee7e8cf65a7c839b7790c90328fcb730e53ab18b4cbef5f8fba397de3ae675",
  },
  walkRight: {
    file: "dataset-1_walk-right_normal_001.bvh",
    url: `${SOURCE}/Bandai-Namco-Research-Motiondataset-1/data/dataset-1_walk-right_normal_001.bvh`,
    sha256: "2b77b84d4caf2e037441d48073f4c3f5e5b43bf98a96f4f4ca96be931a0c3657",
  },
  walkBack: {
    file: "dataset-1_walk-back_normal_001.bvh",
    url: `${SOURCE}/Bandai-Namco-Research-Motiondataset-1/data/dataset-1_walk-back_normal_001.bvh`,
    sha256: "4c182559dbd28e4ba485f664dea49817a30fc0acde29b482f1baaeff4fa80397",
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
