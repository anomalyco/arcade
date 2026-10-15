import { defineConfig } from "vite"
import { audioAssets } from "../../scripts/audio-assets"

export default defineConfig({
  plugins: [audioAssets()],
  base: "./",
  build: { target: "esnext", outDir: "dist/arcade/brawl", emptyOutDir: true },
  server: {
    fs: { allow: ["../.."] },
    allowedHosts: true,
    proxy: { "/ws": { target: "ws://localhost:8790", ws: true }, "/api": { target: "http://localhost:8790" } },
  },
})
