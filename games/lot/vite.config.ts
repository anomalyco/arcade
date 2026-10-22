import { defineConfig } from "vite"
import { textureAssets } from "../../scripts/texture-assets"
import { audioAssets } from "../../scripts/audio-assets"

export default defineConfig({
  // The storm's sound set, fetched only once weather is turned on (src/weather/audio.ts).
  plugins: [textureAssets(), audioAssets({ sfx: ["game:lot"], manifest: false })],
  base: "/arcade/lot/",
  build: {
    outDir: "dist/arcade/lot",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    host: "127.0.0.1",
    allowedHosts: [".ts.net"],
    fs: { allow: ["../.."] },
  },
})
