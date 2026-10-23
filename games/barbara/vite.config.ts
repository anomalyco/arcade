import { defineConfig } from "vite"
import { audioAssets } from "../../scripts/audio-assets"
import { textureAssets } from "../../scripts/texture-assets"
import { forestAssets } from "../../scripts/forest-assets"
import { WOODS_SFX } from "./src/sfx"

export default defineConfig({
  plugins: [audioAssets({ sfx: WOODS_SFX }), textureAssets(), forestAssets()],
  base: "/arcade/barbara/",
  build: { outDir: "dist/arcade/barbara", emptyOutDir: true, target: "es2022" },
  server: { host: "127.0.0.1", allowedHosts: [".ts.net"], fs: { allow: ["../.."] } },
})
