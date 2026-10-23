import { defineConfig } from "vite"
import { audioAssets } from "../../scripts/audio-assets"
import { textureAssets } from "../../scripts/texture-assets"
import { TIMBER_SFX } from "./shared/sfx"

export default defineConfig({
  plugins: [audioAssets({ sfx: TIMBER_SFX }), textureAssets()],
  base: "/arcade/timber/",
  build: {
    outDir: "dist/arcade/timber",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    host: "127.0.0.1",
    allowedHosts: [".ts.net"],
    fs: { allow: ["../.."] },
  },
})
