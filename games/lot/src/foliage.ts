// Source atlas painter and its coverage-preserving mips are baked alongside the native meshes.
export async function foliageTexture(device: GPUDevice, url: string, kind: "foliageAtlas" | "undergrowthAtlas" | "impostors" = "foliageAtlas") {
  const paint = await import(/* @vite-ignore */ url) as {
    foliageAtlas(): OffscreenCanvas
    undergrowthAtlas(): OffscreenCanvas
    paintImpostors(trees: unknown[], foliage: OffscreenCanvas): OffscreenCanvas
    mipChain(canvas: OffscreenCanvas): { width: number; height: number; data: Uint8Array }[]
  }
  const atlas=kind==="impostors" ? paint.paintImpostors(await (await fetch(new URL("tree-inputs.json",new URL(url,location.href)))).json(),paint.foliageAtlas()) : paint[kind]()
  const levels=paint.mipChain(atlas)
  const texture=device.createTexture({size:[levels[0]!.width,levels[0]!.height],mipLevelCount:levels.length,format:"rgba8unorm-srgb",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
  levels.forEach((level,mipLevel)=>device.queue.writeTexture({texture,mipLevel},new Uint8Array(level.data),{bytesPerRow:level.width*4},[level.width,level.height]))
  return texture
}
export function solidTexture(device:GPUDevice, color:number[]) {
  const texture=device.createTexture({size:[1,1],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
  device.queue.writeTexture({texture},new Uint8Array(color),{},[1,1])
  return texture
}
