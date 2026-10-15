import { defineConfig } from "vite"
import { audioAssets } from "../../scripts/audio-assets"
import { textureAssets } from "../../scripts/texture-assets"
import { SFX } from "./src/sfx-ids"

export default defineConfig({
  plugins: [audioAssets({ sfx: SFX }), textureAssets()],
  base: "./",
  build: { target: "esnext", outDir: "dist/arcade/brawl", emptyOutDir: true },
  server: {
    fs: { allow: ["../.."] },
    allowedHosts: true,
    proxy: { "/ws": { target: "ws://localhost:8790", ws: true }, "/api": { target: "http://localhost:8790" } },
  },
})
