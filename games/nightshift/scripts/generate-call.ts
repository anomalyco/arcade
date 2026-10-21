// Explicit authoring command; requires ELEVENLABS_API_KEY injected by 2password.
// Saves files only. Never plays audio or changes an account voice.
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

const out=resolve(process.argv[2]??"captures/nightshift-voice")
await mkdir(out,{recursive:true})
const voice="8olojUk4IXpvKgaOCHXj" // Kit explicitly authorized his PVC; character Jay is fictional.
const lines=["...You're still here. Good.","It's Jay.","Come up to my office. I need to see you.","...Don't take the lift."]
const receipts=[]
for(const [i,line] of lines.entries()) {
  if(process.argv[3] && i+1!==Number(process.argv[3]))continue
  const body={model_id:"eleven_v4",inputs:[{voice_id:voice,text:`[whispers] ${line}`}],settings:{stability:0.5,similarity:0.75},use_pvc_as_ivc:false}
  const r=await fetch("https://api.elevenlabs.io/v1/text-to-dialogue",{method:"POST",headers:{"xi-api-key":process.env.ELEVENLABS_API_KEY!,"Content-Type":"application/json"},body:JSON.stringify(body)})
  if(!r.ok)throw new Error(`${r.status}: ${await r.text()}`)
  await Bun.write(resolve(out,`kit-jay-${i+1}.mp3`),await r.arrayBuffer())
  receipts.push({...body,requestId:r.headers.get("request-id")})
}
await Bun.write(resolve(out,`kit-generation${process.argv[3]?"-"+process.argv[3]:""}.json`),JSON.stringify({voice,name:"Kit Langton (authorized PVC)",fictionalCharacter:"Jay, CEO",receipts},null,2))
console.log(`Saved four whispered Kit/Jay stems to ${out}`)
