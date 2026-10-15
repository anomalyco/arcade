import { defineConfig } from "vite"
import { audioAssets } from "../../scripts/audio-assets"
import { SFX } from "./src/sfx-ids"

export default defineConfig({
  plugins: [audioAssets({ sfx: SFX })],
  base: "./",
  build: { target: "esnext", outDir: "dist/arcade/archers", emptyOutDir: true, rollupOptions: { input: { main: "index.html", playground: "playground.html" } } },
  server: {
    fs: { allow: ["../.."] },
    allowedHosts: true,
    proxy: { "/ws": { target: "ws://localhost:8792", ws: true }, "/api": { target: "http://localhost:8792" } },
  },
})
