import { defineConfig } from "vite"
import { audioAssets } from "../../scripts/audio-assets"

export default defineConfig({
  plugins: [audioAssets()],
  base: "./",
  build: { target: "esnext", outDir: "dist/arcade/outbreak", emptyOutDir: true },
  server: { host: "127.0.0.1", port: Number(process.env.PORT) || 5197, allowedHosts: true },
})
