import { defineConfig } from "vite"
import { audioAssets } from "../../scripts/audio-assets"
import { textureAssets } from "../../scripts/texture-assets"

export default defineConfig({
  plugins: [audioAssets(), textureAssets()],
  base: "./",
  build: {
    target: "esnext",
    outDir: "dist/arcade/outbreak",
    emptyOutDir: true,
    rollupOptions: { input: { main: "index.html", lab: "lab.html" } },
  },
  server: { host: "127.0.0.1", port: Number(process.env.PORT) || 5197, allowedHosts: true },
})
