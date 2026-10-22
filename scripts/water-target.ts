/** Edit an actual screenshot into a water-only target. Credential travels on SSH stdin, never disk or argv. */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const [input, output, kind] = process.argv.slice(2)
if (!input || !output || !["ocean", "lake"].includes(kind ?? "")) throw Error("Usage: bun scripts/water-target.ts input.png output.png ocean|lake")
const key = process.env.OPENAI_API_KEY
if (!key) throw Error("Run with OPENAI_API_KEY injected by 2password")
const image = readFileSync(input)
const prompt = `Edit this actual game screenshot. Repaint ONLY the water surface and water foam. Preserve the exact camera, perspective, horizon, geometry, shoreline, boat silhouettes, lighting direction, interface and all non-water pixels. Keep ALL existing text, UI and gameplay overlays exactly where they are; do not add new objects, text, arrows, borders or labels. Keep the input image aspect ratio and framing exactly. This is a feasible real-time game water material target, not a new composition. ${kind === "ocean"
  ? "IMPORTANT: the giant glowing white circular arc at the left is a holographic gameplay CAPTURE ZONE with a vertical translucent grid wall. It is NOT foam, a wave, a wake or part of the water. Preserve its luminous white arc and vertical grid wall unchanged. Preserve the height, location and silhouette of EVERY large rolling swell, including the steep foreground wave trough. Do not flatten the sea or move the crest foam. Only replace the visibly flat polygon facets with continuous water shading over the SAME underlying large wave geometry. Smaller irregular wind chop breaks warm sun reflections into coherent ribbons, with dark blue-green troughs and restrained teal light through crests. Foam is broken, fine-edged and only on existing breaking crests, shore intersections or existing hull wakes. Do not blanket the water with white foam or metallic glare. Aim for the physical reading of photographed open ocean while keeping this scene's colour and exposure."
  : "Make the lake read as still dark freshwater at night. Preserve existing large sky and tree reflections, with fine slow ripples breaking the highlights. Any existing torch or lamp should create a narrow warm reflected path correctly beneath its position, broken by small ripples. Near shore the dark shallow bed grades naturally into depth. Sparse soft mist only immediately over the water and very subtle sparse rain rings. No ocean swell, no whitecaps, no extra lights or moon, no change to the sky or trees."}`
const model = "gpt-image-2"
const program = `import sys,json,base64,urllib.request,urllib.error,uuid
s=json.load(sys.stdin)
b='water-'+uuid.uuid4().hex
parts=[]
for k in ['model','prompt','size','quality','n']:
 parts.append(('--'+b+'\\r\\nContent-Disposition: form-data; name="'+k+'"\\r\\n\\r\\n'+str(s[k])+'\\r\\n').encode())
parts.append(('--'+b+'\\r\\nContent-Disposition: form-data; name="image[]"; filename="frame.png"\\r\\nContent-Type: image/png\\r\\n\\r\\n').encode()+base64.b64decode(s['image'])+b'\\r\\n')
parts.append(('--'+b+'--\\r\\n').encode())
r=urllib.request.Request('https://api.openai.com/v1/images/edits',data=b''.join(parts),headers={'Authorization':'Bearer '+s['key'],'Content-Type':'multipart/form-data; boundary='+b})
try:
 with urllib.request.urlopen(r,timeout=600) as response: print(response.read().decode())
except urllib.error.HTTPError as e:
 print(json.dumps({'error':{'status':e.code,'message':e.read().decode()[:700]}}))
 sys.exit(1)
`
const remote = `/opt/homebrew/bin/python3 -c 'import sys,base64;exec(base64.b64decode(sys.argv[1]))' ${Buffer.from(program).toString("base64")}`
const processRemote = Bun.spawn(["ssh", "pro", remote], {
  stdin: new TextEncoder().encode(JSON.stringify({ key, model, prompt, size: "auto", quality: "high", n: 1, image: image.toString("base64") })),
  stdout: "pipe", stderr: "pipe",
})
const [text, stderr, code] = await Promise.all([new Response(processRemote.stdout).text(), new Response(processRemote.stderr).text(), processRemote.exited])
if (!text) throw Error(`Image edit failed (${code}): ${stderr.slice(0, 300)}`)
const result = JSON.parse(text) as { data?: { b64_json?: string }[]; error?: unknown }
const b64 = result.data?.[0]?.b64_json
if (!b64 || code) throw Error(`Image edit failed: ${JSON.stringify(result.error)}`)
await Bun.write(output, Buffer.from(b64, "base64"))
await Bun.write(`${output}.json`, JSON.stringify({ model, kind, prompt, input: resolve(input), inputSha256: createHash("sha256").update(image).digest("hex"), generatedAt: new Date().toISOString(), source: "OpenAI images/edits; actual screenshot input; generated target, not renderer output" }, null, 2))
console.log(`Generated ${output}`)
