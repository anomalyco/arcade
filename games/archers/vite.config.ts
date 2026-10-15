import { defineConfig } from "vite"
import { audioAssets } from "../../scripts/audio-assets"
import { SFX } from "./src/sfx-ids"

export default defineConfig({
  plugins: [audioAssets({ sfx: SFX })],
  base: "./",
  build: { target: "esnext", outDir: "dist/arcade/archers", emptyOutDir: true },
  server: {
    fs: { allow: ["../.."] },
    allowedHosts: true,
    proxy: { "/api": { target: "http://localhost:8792" } },
  },
})
