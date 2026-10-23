import { defineConfig } from "vite"
import { audioAssets } from "../../scripts/audio-assets"
import { textureAssets } from "../../scripts/texture-assets"
import { propAssets } from "../../scripts/prop-assets"
import { getawaySfx } from "../../scripts/game-sfx"
import { forestAssets } from "../../scripts/forest-assets"

export default defineConfig({
  plugins: [audioAssets({ sfx: "all" }), textureAssets(), propAssets(), getawaySfx(), forestAssets()],
  base: "./",
  build: { target: "esnext", outDir: "dist/arcade/lab", emptyOutDir: true, rollupOptions: { input: { main: new URL("./index.html", import.meta.url).pathname, woods: new URL("./woods.html", import.meta.url).pathname, spider: new URL("./spider.html", import.meta.url).pathname } } },
  server: { fs: { allow: ["../.."] }, allowedHosts: true },
})
