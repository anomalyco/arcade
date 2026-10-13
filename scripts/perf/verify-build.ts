import { resolve, relative, join } from "node:path"
import { writeFileSync } from "node:fs"
const root=resolve(import.meta.dir,"../..")
const manifest=await Bun.file(join(root,"perf/proposals-data/source-manifest.json")).json()
const rows=[]
for(const game of ["getaway","blackout"]) {
  const dir=join(root,`games/${game}/dist/arcade/${game}/assets`)
  const file=[...new Bun.Glob('main-*.js.map').scanSync(dir)][0]!
  const map=await Bun.file(join(dir,file)).json()
  const checked=[]
  for(let i=0;i<map.sources.length;i++) {
    const path=relative(root,resolve(dir,map.sources[i]))
    if(path.includes('node_modules/'))continue
    if(path==='games/blackout/shared/build.gen.ts')continue // generated build ID, not a renderer/simulation source
    const hash=new Bun.CryptoHasher('sha256').update(map.sourcesContent[i]).digest('hex')
    if(manifest.sha256[path]!==hash)throw Error(`Unexpected compiled source: ${path}`)
    checked.push(path)
  }
  rows.push({game,verified:checked.length,sources:checked})
}
writeFileSync(join(root,'perf/proposals-data/compiled-source-proof.json'),JSON.stringify(rows,null,2))
console.log(rows.map(({game,verified})=>({game,verified})))
