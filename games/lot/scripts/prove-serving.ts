import { meshBytes } from "../src/mesh-bytes"
import assert from "node:assert/strict"

// Exercise the actual Worker asset binding, including its production /arcade/lot prefix and gzip body handling.
const reserve=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()})
const port=reserve.port;reserve.stop(true)
const child=Bun.spawn(["bunx","--no-install","wrangler","dev","--local","--ip","127.0.0.1","--port",String(port)],{
  cwd:resolveGame(),stdout:"pipe",stderr:"pipe",env:{...process.env,WRANGLER_SEND_METRICS:"false"},
})
let log=""
const stderr=new Response(child.stderr).text()
const timeout=setTimeout(()=>child.kill(),45_000)
try {
  const reader=child.stdout.getReader(),decoder=new TextDecoder()
  for(;;){const {done,value}=await reader.read();if(done)break;log+=decoder.decode(value,{stream:true});if(log.includes("Ready on"))break}
  reader.releaseLock()
  if(!log.includes("Ready on"))throw new Error(log+await stderr)
  const base=`http://127.0.0.1:${port}/arcade/lot/`
  const page=await fetch(base)
  assert.equal(page.status,200)
  const html=await page.text(),script=html.match(/src="([^"]+\.js)"/)?.[1]
  assert.ok(script,"production script URL")
  assert.equal((await fetch(new URL(script,base))).status,200)
  assert.equal(await (await fetch(base+"api/health")).text(),"ok")
  const bytes=await meshBytes(await fetch(base+"ashwood/glass-0.bin.gz"))
  const source=Bun.gunzipSync(new Uint8Array(await Bun.file(`${resolveGame()}/public/ashwood/glass-0.bin.gz`).arrayBuffer()))
  assert.deepEqual(new Uint8Array(bytes),source)
  console.log("Worker index, hashed bundle, health route and decoded mesh bytes passed")
} finally {clearTimeout(timeout);child.kill();await child.exited;await stderr}
function resolveGame(){return `${import.meta.dir}/..`}
