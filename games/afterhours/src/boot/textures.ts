import * as THREE from "three/webgpu"

// Stop-gap until materials.ts loads with ImageBitmapLoader or KTX2 (docs/boot-architecture.md): `TextureLoader` hands
// three an <img>, and the WebGPU upload (copyExternalImageToTexture) decodes the JPEG synchronously on the main thread,
// ~2.5 s for the 57 scanned 2K maps at 4× CPU throttling, right while shaders are being built. This fetches each file
// and decodes it from a Blob with createImageBitmap (off the main thread) before `onLoad` fires, so loadMaterials
// still resolves when the pixels are ready, and frees the decoded copy once it is on the GPU. Same upload path and
// flipY as an <img>.

export function decodeTexturesOffThread() {
  if (typeof createImageBitmap !== "function") return
  type Load = THREE.TextureLoader["load"]
  THREE.TextureLoader.prototype.load = function (this: THREE.TextureLoader, url, onLoad, _onProgress, onError) {
    const texture = new THREE.Texture() as THREE.Texture<HTMLImageElement>
    fetch(this.manager.resolveURL((this.path ?? "") + url))
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${url}`)
        return r.blob()
      })
      .then((blob) => createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" }))
      .then((bitmap) => {
        ;(texture as unknown as { image: unknown }).image = bitmap
        texture.needsUpdate = true
        texture.onUpdate = () => {
          texture.onUpdate = null
          // The pixels live on the GPU now; a decoded 2K map is 16 MB of CPU memory.
          bitmap.close()
        }
        onLoad?.(texture)
      })
      .catch((e) => onError?.(e))
    return texture
  } as Load
}
