import { defineConfig } from "vite"
import { audioAssets } from "../../scripts/audio-assets"
import { textureAssets } from "../../scripts/texture-assets"
import { getawaySfx } from "../../scripts/game-sfx"

export default defineConfig({
  plugins: [audioAssets({ sfx: "all" }), textureAssets(), getawaySfx()],
  base: "./",
  build: { target: "esnext", outDir: "dist/arcade/lab", emptyOutDir: true, rollupOptions: { input: { main: new URL("./index.html", import.meta.url).pathname } } },
  server: { fs: { allow: ["../.."] }, allowedHosts: true },
})
