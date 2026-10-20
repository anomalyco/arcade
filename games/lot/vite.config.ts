import { defineConfig } from "vite"
import { textureAssets } from "../../scripts/texture-assets"

export default defineConfig({
  plugins: [textureAssets()],
  base: "/arcade/lot/",
  build: {
    outDir: "dist/arcade/lot",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    host: "127.0.0.1",
    allowedHosts: [".ts.net"],
    fs: { allow: ["../.."] },
  },
})
