import { setHouseVariety, type HouseVariety } from "../shared/houses/variety"
import { generateWorldChunk, type WorldMode } from "../shared/world"
import { archSettings } from "./architecture"
import { interiorSettings } from "./interiors/plan"
import { propDressingState } from "./props/state"
import { vegetationBuild } from "./vegetation/settings"
import { compileSingleWorldChunk, recycleTileBuffers } from "./world-streamer"

export type WorldWorkerRequest =
  | {
      type?: "compile"
      id: number
      cacheKey: string
      seed: number
      houseSeed: number
      terrain: number
      foliageDensity: number
      mode: WorldMode
      cx: number
      cy: number
      houseDecay: number
      weathering: number
      clutterDensity: number
      clutterSeed: number
      interior?: typeof interiorSettings
      props?: typeof propDressingState
      veg?: typeof vegetationBuild
      variety?: HouseVariety
    }
  | {
      type: "recycle"
      floorBuf: ArrayBuffer
      moonBuf: ArrayBuffer
      bounceBuf: ArrayBuffer
      opaqueBuf?: ArrayBuffer
    }

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<WorldWorkerRequest>) => void) | null
  postMessage: (message: unknown, transfer: Transferable[]) => void
}

ctx.onmessage = (ev: MessageEvent<WorldWorkerRequest>) => {
  const req = ev.data
  if (req.type === "recycle") {
    recycleTileBuffers(req.floorBuf, req.moonBuf, req.bounceBuf, req.opaqueBuf)
    return
  }
  archSettings.houseDecay = req.houseDecay
  archSettings.weathering = req.weathering
  archSettings.clutterDensity = req.clutterDensity
  archSettings.clutterSeed = req.clutterSeed
  if (req.interior) Object.assign(interiorSettings, req.interior)
  if (req.props) Object.assign(propDressingState, req.props)
  if (req.veg) Object.assign(vegetationBuild, req.veg)
  if (req.variety) setHouseVariety(req.variety)
  const worldChunk = generateWorldChunk(req.seed, req.houseSeed, req.cx, req.cy, req.mode)
  const compiled = compileSingleWorldChunk(
    worldChunk,
    req.seed,
    req.houseSeed,
    req.terrain,
    req.foliageDensity,
    req.mode,
  )
  const transfer: Transferable[] = [
    compiled.floorTile.buffer,
    compiled.moonTile.buffer,
    compiled.bounceTile.buffer,
    compiled.sconces.buffer,
  ]
  for (const c of compiled.staticOpaqueChunks) transfer.push(c.data)
  for (const c of compiled.glassChunks) transfer.push(c.data)
  if (compiled.roofChunks) {
    for (const r of compiled.roofChunks) transfer.push(r.data)
  }
  ctx.postMessage({ id: req.id, cacheKey: req.cacheKey, compiled }, transfer)
}
