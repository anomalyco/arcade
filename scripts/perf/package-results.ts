import { readFileSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs"
import { gzipSync, gunzipSync } from "node:zlib"
import { join } from "node:path"

const root=join(import.meta.dir,"../.."),dir=join(root,"perf/proposals-data")
// Lossless packaging of this investigation's generated frame records only.
for(const file of new Bun.Glob('*-render.json').scanSync(dir)) {
  const path=join(dir,file),bytes=readFileSync(path),compressed=gzipSync(bytes)
  if(!gunzipSync(compressed).equals(bytes))throw Error('Compression round-trip failed')
  writeFileSync(path+'.gz',compressed);unlinkSync(path)
}
const records=[]
for(const file of new Bun.Glob('*-profile-summary.json').scanSync(dir)) {
  records.push({experiment:'proposals-cpu-profile',scenario:file.replace('-profile-summary.json',''),...JSON.parse(readFileSync(join(dir,file),'utf8'))})
}
records.push({experiment:'proposals-methodology-decisions',decisions:[
  {selector:'proposals-render',decision:'superseded',reason:'Initial warmup MSAA target mismatch, canvas-post label error, and initial profiler overlap. Use proposals-render-validated for GPU and proposals-render-cpu-followup for CPU.'},
  {selector:'proposals-render-harness-proof',decision:'harness proof only',reason:'Two blocks / three frames verify disjoint isolated spans and valid 1x descriptors; not an optimization sample.'},
  {selector:'serial command buffers without completion barriers',decision:'discard',reason:'Timestamp ranges still overlap.'},
  {selector:'isolated passes using swapchain output',decision:'discard',reason:'Canvas texture expired between queue-completion waits. Persistent final texture fixes diagnostics.'},
  {selector:'proposals-network-candidates',decision:'superseded interest estimates',reason:'Centered every viewer on human0; corrected recipient-centered estimates are proposals-network-candidates-per-recipient.'},
  {selector:'enable WebSocket compression',decision:'not a new win',reason:'Already enabled by compatibility date. Miniflare proxy advertises extension with either backend flag; production negotiation unmeasured.'},
  {selector:'blind snapshot-rate reduction',decision:'defer',reason:'At 0-60ms jitter, 15 to 10 Hz raises Getaway unbracketed frames from 0.58% to 12.25%.'},
  {selector:'Blackout lower MSAA',decision:'no demonstrated win',reason:'Differences within shared-machine spread; do not change default.'}
]})
for(const r of records)appendFileSync(join(root,'perf/results.jsonl'),JSON.stringify(r)+'\n')
console.log('Packed render records losslessly; appended profiles and experiment decisions')
