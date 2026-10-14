import { defineConfig } from "vite"
import { audioAssets } from "../../scripts/audio-assets"
import { textureAssets } from "../../scripts/texture-assets"

export default defineConfig({
  plugins: [audioAssets(), textureAssets()],
  base: "./",
  build: { target: "esnext", outDir: "dist/arcade/lab", emptyOutDir: true, rollupOptions: { input: { main: new URL("./index.html", import.meta.url).pathname } } },
  server: { fs: { allow: ["../.."] }, allowedHosts: true },
})
