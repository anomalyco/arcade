import { defineConfig } from "vite"
import { textureAssets } from "../../scripts/texture-assets"
import { bootScreen } from "../../scripts/boot-screen"
export default defineConfig({
  plugins: [textureAssets(), bootScreen()], base: "/arcade/nightshift/",
  build: { outDir: "dist/arcade/nightshift", emptyOutDir: true, target: "es2022" },
  server: { host: "127.0.0.1", allowedHosts: [".ts.net"], fs: { allow: ["../.."] } },
})
