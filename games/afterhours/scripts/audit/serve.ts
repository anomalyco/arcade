// Static server for the frozen audit build: bun scripts/audit/serve.ts <dir> [port=5231]
import { serve } from "../../bench/lib"
const dir = process.argv[2]!
const port = Number(process.argv[3] ?? 5231)
serve(dir, port)
console.log(`serving ${dir} on :${port}`)
